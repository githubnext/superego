/// <reference path="./ws.d.ts" />
// Superego in a browser: the daemon serves the app's window (the same build Electron loads) over HTTP, and the protocol
// over a WebSocket at /rpc. Off unless the machine's "Web access" setting turns it on. The page itself is public; the
// protocol and artifacts need a caller this machine knows, one of two ways:
// - pairing: a browser trades a one-time code from Settings (POST /pair) for a credential of its own, which the page
//   keeps in localStorage: only pages of its exact origin, port included, can read it, where a cookie would go to every
//   port on the host. No secret ever rides in a URL. See web-auth.ts.
// - tailscale: `tailscale serve` says who is calling, on a unix socket only it can reach. See tailscale.ts.
// Either way the WebSocket's first message is `auth` (the credential, or nothing behind Tailscale), answered before
// anything else is served; a socket that doesn't send it in a few seconds, or sends a wrong one, is closed. Artifacts
// load in iframes, which can't send the credential: the page asks over its socket for a ticket (`artifact.ticket`), a
// short-lived address for one thread's artifacts.
// Against other sites: the upgrade and the pairing POST must come from a page this server served (their Origin names
// the host they were sent to), and every request must name this server by a host it answers to, so a name an attacker
// points at this machine (DNS rebinding) gets nothing.
import { chmod, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { RpcPeer } from '@superego/protocol'
import type { Via } from './clients.ts'
import { deviceName, sameHolder, Tickets, type Devices, type Holder, type PairingCodes } from './web-auth.ts'
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

/** How long a new socket has to send `auth`. */
const AUTH_WAIT = 5_000
/** Close codes the page reads: pair (again), and turned away for who it is (the reason says why). */
export const CLOSE_UNPAIRED = 4401
export const CLOSE_REFUSED = 4403

/** How callers prove who they are: a paired device's credential, or Tailscale's word for it (see the top of this file). */
export type WebAuth =
  | { kind: 'pairing'; devices: Devices; codes: PairingCodes }
  | { kind: 'tailscale'; admits(login: string): Promise<boolean> }

export type WebServer = {
  /** Where browsers open it, when it listens on TCP; nothing secret in it. */
  url: string | null
  /** Close a device's live connections at once and end its tickets (it was revoked). */
  disconnect(device: string): void
  /** Ask again whether each Tailscale login with a live connection or a ticket is allowed; close and end those that aren't. */
  recheck(): Promise<void>
  close(): Promise<void>
}

/** What a socket's transport offers the daemon besides who it is: tickets for artifacts. */
export type WebTransport = { via: Via; hangUp(): void; ticket(thread: string, machine?: string): { path: string; expires: number } }

/** Who a caller is, or why it isn't let in. */
type Identity = { ok: true; via: Via; holder: Holder } | { ok: false; code: number; why: string }

/** Serve `root` (the window's build) and the protocol, on host:port or a unix socket; each connection a peer handed to `serve`. */
export async function serveWeb({ root, at, auth, serve, artifact, tailnet }: {
  root: string; at: { host: string; port: number } | { socket: string }; auth: WebAuth; serve(peer: RpcPeer, transport: WebTransport): () => void
  /** A file of an artifact (an HTML page in a thread's folder, and what it links to); `machine` for one this daemon reaches. */
  artifact?(thread: string, path: string, machine?: string): Promise<Buffer>
  /** This machine's name on the tailnet, when it has one: a host it answers to besides loopback (and the LAN's). */
  tailnet?(): Promise<string | undefined>
}): Promise<WebServer> {
  const behindProxy = 'socket' in at
  const tickets = new Tickets()

  /** The host a request was sent to: behind `tailscale serve`, the one the browser used, which it forwards. */
  const hostOf = (request: IncomingMessage) => {
    const forwarded = behindProxy ? first(request.headers['x-forwarded-host']) : undefined
    return hostName(forwarded ?? request.headers.host ?? '')
  }
  /** Whether a request names this server: loopback, this machine on the LAN when serving it, or its tailnet name. */
  const hostAllowed = async (request: IncomingMessage) => {
    const host = hostOf(request)
    if (!host) return false
    if (LOOPBACK.has(host)) return true
    if (!behindProxy && at.host === '0.0.0.0' && lanNames().has(host)) return true
    const name = await tailnet?.().catch(() => undefined)
    return Boolean(name && (host === name.toLowerCase() || host === name.toLowerCase().split('.')[0]))
  }
  /** Whether a request comes from a page this server served: its Origin names the host it was sent to. */
  const sameOrigin = (request: IncomingMessage) => {
    const origin = request.headers.origin
    if (!origin) return false
    let host: string
    try { host = new URL(origin).host.toLowerCase() } catch { return false }
    const sent = (behindProxy ? first(request.headers['x-forwarded-host']) : undefined) ?? request.headers.host
    return sent?.toLowerCase() === host
  }

  /** Who the `auth` message (and, behind Tailscale, the upgrade's headers) says this is. */
  const identify = async (request: IncomingMessage, credential: unknown): Promise<Identity> => {
    if (auth.kind === 'tailscale') {
      const caller = tailscaleCaller(request.headers)
      if (!caller) return { ok: false, code: CLOSE_REFUSED, why: 'Open this through `tailscale serve`, signed in to Tailscale.' }
      if (!(await auth.admits(caller.login))) return { ok: false, code: CLOSE_REFUSED, why: `${caller.login} isn't allowed on this machine.` }
      return { ok: true, via: { via: 'tailscale', label: caller.login }, holder: { login: caller.login.toLowerCase() } }
    }
    const device = auth.devices.verify(typeof credential === 'string' ? credential : undefined)
    return device ? { ok: true, via: { via: 'web', label: device.name, device: device.id }, holder: { device: device.id } } : { ok: false, code: CLOSE_UNPAIRED, why: 'Not paired with this machine.' }
  }

  const server: Server = createServer(async (request, response) => {
    try { await handle(request, response) } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end((error as Error).message)
    }
  })
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (!(await hostAllowed(request))) { response.writeHead(421, { 'content-type': 'text/plain' }).end('Not a name this server answers to.'); return }
    const requested = new URL(request.url ?? '/', 'http://x')
    const path = decodeURIComponent(requested.pathname)
    // A code from Settings for a credential of this browser's own, in the answer for the page to keep.
    if (path === '/pair') {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return }
      if (auth.kind !== 'pairing') { json(response, 404, { error: 'This machine admits callers by Tailscale; there is nothing to pair.' }); return }
      if (!sameOrigin(request)) { json(response, 403, { error: 'Pair from this machine’s own page.' }); return }
      if (!/^application\/json\b/.test(request.headers['content-type'] ?? '')) { json(response, 415, { error: 'Expected JSON' }); return }
      const caller = request.socket.remoteAddress ?? ''
      if (auth.codes.limited(caller)) { json(response, 429, { error: 'Too many wrong codes from here. Wait a few minutes, then make a new one in Settings → Web access.' }); return }
      const body = await readJson(request).catch(() => undefined) as { code?: unknown; name?: unknown } | undefined
      if (typeof body?.code !== 'string' || !auth.codes.take(body.code, caller)) { json(response, 401, { error: 'That code isn’t open on this machine. Make a new one in Settings → Web access.' }); return }
      const { device, credential } = auth.devices.add(typeof body.name === 'string' && body.name.trim() ? body.name : deviceName(request.headers['user-agent']))
      json(response, 200, { device: device.id, name: device.name, credential })
      return
    }
    // Artifacts, by ticket, then sandboxed.
    if (path.startsWith('/artifact/') && artifact) {
      const [ticket = '', ...rest] = path.slice('/artifact/'.length).split('/')
      const entry = tickets.get(ticket)
      const holderOk = entry && ('device' in entry.holder ? auth.kind === 'pairing' && auth.devices.get(entry.holder.device) : auth.kind === 'tailscale' && await auth.admits(entry.holder.login))
      if (!entry || !holderOk) { response.writeHead(401, { 'content-type': 'text/plain' }).end('This artifact’s address has expired. Reload the pane.'); return }
      try {
        const content = await artifact(entry.thread, rest.join('/'), entry.machine)
        response.writeHead(200, {
          'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
          'content-security-policy': "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: 'unsafe-inline' 'unsafe-eval'",
          'cache-control': 'no-cache',
          'referrer-policy': 'no-referrer',
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
  /** Each holder's live connections, and how to end one: at once, before the browser has said goodbye. */
  const live = new Map<WebSocket, { holder: Holder; end(): void }>()
  /** End `holder`'s connections with `code`, and its tickets. */
  const shut = (holder: Holder, code: number, why: string) => {
    tickets.drop(holder)
    for (const [ws, entry] of [...live]) {
      if (!sameHolder(entry.holder, holder)) continue
      entry.end()
      ws.close(code, reason(why))
      setTimeout(() => ws.terminate(), 1000).unref()
    }
  }

  server.on('upgrade', async (request, socket, head) => {
    const refuse = (status: number, why: string) => socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : status === 421 ? 'Misdirected Request' : 'Forbidden'}\r\ncontent-type: text/plain\r\n\r\n${why}`)
    if (new URL(request.url ?? '/', 'http://x').pathname !== '/rpc') return refuse(404, 'Not here')
    if (!(await hostAllowed(request))) return refuse(421, 'Not a name this server answers to.')
    if (!sameOrigin(request)) return refuse(403, 'Connect from this machine’s own page.')
    sockets.handleUpgrade(request, socket, head, (ws) => {
      // Until `auth` is answered nothing is served; what comes behind it meanwhile waits, a little of it.
      let state: 'waiting' | 'checking' | 'open' | 'ended' = 'waiting'
      const early: string[] = []
      let peer: RpcPeer | undefined
      const timer = setTimeout(() => { if (state === 'waiting' || state === 'checking') ws.close(CLOSE_UNPAIRED, 'No credential') }, AUTH_WAIT)
      ws.on('message', (data) => {
        const text = String(data)
        if (state === 'open') return peer!.receive(text)
        if (state === 'checking') { if (early.push(text) > 64) ws.terminate(); return }
        if (state !== 'waiting') return
        state = 'checking'
        void admit(text)
      })
      ws.on('close', () => { clearTimeout(timer); if (state !== 'open') state = 'ended' })
      ws.on('error', () => {})

      const admit = async (text: string) => {
        let message: { id?: unknown; method?: unknown; params?: { credential?: unknown } } | undefined
        try { message = JSON.parse(text) } catch { /* not JSON */ }
        if (message?.method !== 'auth' || message.id === undefined) return ws.close(CLOSE_UNPAIRED, 'Send auth first')
        const who = await identify(request, message.params?.credential)
        if (state !== 'checking') return
        clearTimeout(timer)
        if (!who.ok) { state = 'ended'; return ws.close(who.code, reason(who.why)) }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { via: who.via.via, name: who.via.label, ...(who.via.device ? { device: who.via.device } : {}) } }))
        // Full past 1 MiB unsent, as a socket's write says; each sent message checks whether there's room again.
        const room = () => ws.bufferedAmount < 1024 * 1024
        const next = peer = new RpcPeer((line) => {
          if (ws.readyState !== ws.OPEN) return true
          ws.send(line.trimEnd(), () => { if (room()) next.drain() })
          return room()
        })
        const cleanup = serve(next, {
          via: who.via, hangUp: () => ws.terminate(),
          ticket: (thread, machine) => {
            const { ticket, expires } = tickets.issue(thread, machine, who.holder)
            return { path: `/artifact/${ticket}/`, expires }
          },
        })
        let ended = false
        const end = () => {
          if (ended) return
          ended = true
          state = 'ended'
          live.delete(ws)
          next.close()
          cleanup()
        }
        live.set(ws, { holder: who.holder, end })
        ws.on('close', end)
        state = 'open'
        for (const line of early.splice(0)) next.receive(line)
      }
    })
  })

  const recheck = async () => {
    if (auth.kind !== 'tailscale') return
    const logins = new Set([...[...live.values()].map((entry) => entry.holder), ...tickets.holders()].flatMap((holder) => 'login' in holder ? [holder.login] : []))
    for (const login of logins) {
      if (!(await auth.admits(login))) shut({ login }, CLOSE_REFUSED, `${login} isn't allowed on this machine any more.`)
    }
  }
  // Who owns this node can change without a word to us: look again now and then.
  const rechecking = auth.kind === 'tailscale' ? setInterval(() => void recheck().catch(() => {}), 60_000) : undefined
  rechecking?.unref()

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
    // CLOSE_UNPAIRED: the page reads it as "pair again", not as the network dropping. Nothing it sends after this is heard.
    disconnect: (device) => shut({ device }, CLOSE_UNPAIRED, 'Revoked'),
    recheck,
    close: () => new Promise<void>((resolve) => {
      clearInterval(rechecking)
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      server.close(() => resolve())
      server.closeAllConnections()
      if ('socket' in at) void rm(at.socket, { force: true })
    }),
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

/** This machine by the names and addresses the LAN reaches it at. */
function lanNames(): Set<string> {
  const names = new Set<string>()
  for (const list of Object.values(networkInterfaces())) for (const address of list ?? []) names.add(address.address.toLowerCase())
  const name = hostname().toLowerCase()
  names.add(name)
  names.add(name.endsWith('.local') ? name : `${name}.local`)
  return names
}

/** The name in a Host header: lowercase, without the port or an IPv6 address's brackets. */
function hostName(host: string): string {
  const value = host.trim().toLowerCase()
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'))
  return value.replace(/:\d+$/, '')
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim() || undefined

/** A close reason fits in 123 bytes. */
const reason = (text: string) => Buffer.byteLength(text) <= 123 ? text : `${Buffer.from(text).subarray(0, 120).toString('utf8').replace(/�$/, '')}…`

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
