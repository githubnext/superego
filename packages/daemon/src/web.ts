/// <reference path="./ws.d.ts" />
// Superego in a browser: the daemon serves the app's window (the same build Electron loads) over HTTP, and the protocol
// over a WebSocket at /rpc. Off unless the machine's "Web access" setting turns it on. The page itself is public; the
// protocol and artifacts need a caller this machine knows, one of two ways:
// - pairing: a browser trades a one-time code from Settings (POST /pair) for a credential of its own, kept as an
//   HttpOnly, SameSite=Strict cookie. No secret ever rides in a URL. See web-auth.ts.
// - tailscale: `tailscale serve` says who is calling, on a unix socket only it can reach. See tailscale.ts.
// Cookies go with requests from other sites too, so the WebSocket upgrade and the pairing POST must come from a page
// this server served: their Origin has to name the host they were sent to.
import { chmod, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { WebSocketServer, type WebSocket } from 'ws'
import { RpcPeer } from '@superego/protocol'
import type { Via } from './clients.ts'
import { deviceName, type Devices, type PairingCodes } from './web-auth.ts'
import { tailscaleCaller } from './tailscale.ts'

/** The first address other devices on the local network can reach this machine at. */
export function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) if (address.family === 'IPv4' && !address.internal) return address.address
  }
  return undefined
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.htm': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

export const COOKIE = 'superego-device'

/** How callers prove who they are: a paired device's cookie, or Tailscale's word for it (see the top of this file). */
export type WebAuth =
  | { kind: 'pairing'; devices: Devices; codes: PairingCodes }
  | { kind: 'tailscale'; admits(login: string): Promise<boolean> }

export type WebServer = {
  /** Where browsers open it, when it listens on TCP; nothing secret in it. */
  url: string | null
  /** Close a device's live connections at once (it was revoked). */
  disconnect(device: string): void
  close(): Promise<void>
}

/** Who a request is from, or why it isn't let in: `401` nobody we know, `403` someone not allowed. */
type Identity = { ok: true; via: Via } | { ok: false; status: 401 | 403; why: string }

/** Serve `root` (the window's build) and the protocol, on host:port or a unix socket; each connection a peer handed to `serve`. */
export async function serveWeb({ root, at, auth, serve, artifact }: {
  root: string; at: { host: string; port: number } | { socket: string }; auth: WebAuth; serve(peer: RpcPeer, transport: { via: Via; hangUp(): void }): () => void
  /**
   * A file of an artifact (an HTML page in a thread's folder, and what it links to), at /artifact/<thread>/<path>; on
   * another machine this daemon reaches, at /artifact/~<machine>/<thread>/<path>.
   */
  artifact?(thread: string, path: string, machine?: string): Promise<Buffer>
}): Promise<WebServer> {
  const identify = async (request: IncomingMessage): Promise<Identity> => {
    if (auth.kind === 'tailscale') {
      const caller = tailscaleCaller(request.headers)
      if (!caller) return { ok: false, status: 401, why: 'Open this through `tailscale serve`, signed in to Tailscale.' }
      if (!(await auth.admits(caller.login))) return { ok: false, status: 403, why: `${caller.login} isn't allowed on this machine.` }
      return { ok: true, via: { via: 'tailscale', label: caller.login } }
    }
    const device = auth.devices.verify(cookie(request, COOKIE))
    return device ? { ok: true, via: { via: 'web', label: device.name, device: device.id } } : { ok: false, status: 401, why: 'Not paired with this machine.' }
  }

  const server: Server = createServer(async (request, response) => {
    try { await handle(request, response) } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end((error as Error).message)
    }
  })
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const requested = new URL(request.url ?? '/', 'http://x')
    const path = decodeURIComponent(requested.pathname)
    // Who this browser is to us: the page asks before it connects, and shows the pairing form when it's nobody.
    if (path === '/session') {
      const who = await identify(request)
      const body = who.ok ? { via: who.via.via, name: who.via.label, ...(who.via.device ? { device: who.via.device } : {}) } : { error: who.why, pairing: auth.kind === 'pairing' }
      json(response, who.ok ? 200 : who.status, body)
      return
    }
    // A code from Settings for a credential of this browser's own, as a cookie.
    if (path === '/pair') {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return }
      if (auth.kind !== 'pairing') { json(response, 404, { error: 'This machine admits callers by Tailscale; there is nothing to pair.' }); return }
      if (!sameOrigin(request)) { json(response, 403, { error: 'Pair from this machine’s own page.' }); return }
      if (!/^application\/json\b/.test(request.headers['content-type'] ?? '')) { json(response, 415, { error: 'Expected JSON' }); return }
      const body = await readJson(request).catch(() => undefined) as { code?: unknown; name?: unknown } | undefined
      if (typeof body?.code !== 'string' || !auth.codes.take(body.code)) { json(response, 401, { error: 'That code isn’t open on this machine. Make a new one in Settings → Web access.' }); return }
      const { device, credential } = auth.devices.add(typeof body.name === 'string' && body.name.trim() ? body.name : deviceName(request.headers['user-agent']))
      const secure = isHttps(request) ? '; Secure' : ''
      // Browsers keep a cookie 400 days at most; past that, pair again.
      response.setHeader('set-cookie', `${COOKIE}=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000${secure}`)
      json(response, 200, { device: device.id, name: device.name })
      return
    }
    // Artifacts: the caller's cookie (or Tailscale), then sandboxed.
    if (path.startsWith('/artifact/') && artifact) {
      const who = await identify(request)
      if (!who.ok) { response.writeHead(who.status, { 'content-type': 'text/plain' }).end(who.why); return }
      const parts = path.slice('/artifact/'.length).split('/')
      const machine = parts[0]?.startsWith('~') ? decodeURIComponent(parts.shift()!.slice(1)) : undefined
      const [thread, ...rest] = parts
      try {
        const content = await artifact(thread!, rest.join('/'), machine)
        response.writeHead(200, {
          'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
          'content-security-policy': "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: 'unsafe-inline' 'unsafe-eval'",
          'cache-control': 'no-cache',
        })
        response.end(content)
      } catch (error) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end((error as Error).message)
      }
      return
    }
    const file = normalize(join(root, path === '/' ? 'index.html' : path))
    if (!file.startsWith(root + sep) && file !== root) { response.writeHead(403).end(); return }
    // Unknown paths are the app's own (it has no routes yet), so they get the page.
    const target = existsSync(file) && (await stat(file)).isFile() ? file : join(root, 'index.html')
    if (!existsSync(target)) { response.writeHead(404, { 'content-type': 'text/plain' }).end('The web app is not built here.'); return }
    response.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      // Hashed assets keep; the page and manifest are checked each time, so a new build shows on reload.
      'cache-control': target.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    response.end(await readFile(target))
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
  /** Each paired device's live connections, and how to end one: at once, before the browser has said goodbye. */
  const byDevice = new Map<string, Map<WebSocket, () => void>>()
  server.on('upgrade', async (request, socket, head) => {
    const refuse = (status: number, why: string) => socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Forbidden'}\r\ncontent-type: text/plain\r\n\r\n${why}`)
    if (new URL(request.url ?? '/', 'http://x').pathname !== '/rpc') return refuse(404, 'Not here')
    if (!sameOrigin(request)) return refuse(403, 'Connect from this machine’s own page.')
    const who = await identify(request)
    if (!who.ok) return refuse(who.status, who.why)
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const device = who.via.device
      // Full past 1 MiB unsent, as a socket's write says; each sent message checks whether there's room again.
      const room = () => ws.bufferedAmount < 1024 * 1024
      const peer = new RpcPeer((line) => {
        if (ws.readyState !== ws.OPEN) return true
        ws.send(line.trimEnd(), () => { if (room()) peer.drain() })
        return room()
      })
      const cleanup = serve(peer, { via: who.via, hangUp: () => ws.terminate() })
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        if (device) byDevice.get(device)?.delete(ws)
        peer.close()
        cleanup()
      }
      if (device) { if (!byDevice.has(device)) byDevice.set(device, new Map()); byDevice.get(device)!.set(ws, end) }
      ws.on('message', (data) => { if (!ended) peer.receive(String(data)) })
      ws.on('close', end)
      ws.on('error', () => {})
    })
  })

  let url: string | null = null
  if ('socket' in at) {
    // Only this user, and tailscaled (root), can connect: see tailscale.ts.
    await mkdir(dirname(at.socket), { recursive: true, mode: 0o700 })
    await rm(at.socket, { force: true })
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(at.socket, resolve))
    await chmod(at.socket, 0o600)
  } else {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(at.port, at.host, resolve))
    const shown = at.host === '0.0.0.0' ? lanAddress() ?? '127.0.0.1' : at.host
    url = `http://${shown}:${at.port}/`
  }
  return {
    url,
    disconnect(device) {
      // 4401: the page reads it as "pair again", not as the network dropping. Nothing it sends after this is heard.
      for (const [ws, end] of byDevice.get(device) ?? []) {
        end()
        ws.close(4401, 'Revoked')
        setTimeout(() => ws.terminate(), 1000).unref()
      }
      byDevice.delete(device)
    },
    close: () => new Promise<void>((resolve) => {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      server.close(() => resolve())
      server.closeAllConnections()
      if ('socket' in at) void rm(at.socket, { force: true })
    }),
  }
}

/** Whether a request comes from a page this server served: its Origin names the host it was sent to (or, behind a proxy, the one the browser used). */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (!origin) return false
  let host: string
  try { host = new URL(origin).host } catch { return false }
  const forwarded = request.headers['x-forwarded-host']
  return [request.headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded])].some((h) => h?.toLowerCase() === host.toLowerCase())
}

/** Whether the browser sees HTTPS: here, or at a proxy in front (`tailscale serve`), which only marks the cookie Secure. */
const isHttps = (request: IncomingMessage) => Boolean((request.socket as TLSSocket).encrypted) || request.headers['x-forwarded-proto'] === 'https'

function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(/;\s*/)) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at) === name) return part.slice(at + 1)
  }
  return undefined
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

function readJson(request: IncomingMessage, limit = 4096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { text += chunk; if (text.length > limit) { reject(new Error('Too large')); request.destroy() } })
    request.on('end', () => { try { resolve(JSON.parse(text)) } catch (error) { reject(error) } })
    request.on('error', reject)
  })
}
