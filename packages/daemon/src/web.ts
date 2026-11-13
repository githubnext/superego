/// <reference path="./ws.d.ts" />
// Superego in a browser: the daemon serves the app's window (the same build Electron loads) over HTTP on loopback, and
// the protocol over a WebSocket at /rpc. Off unless the machine's "Web access" setting turns it on: for this computer,
// or for the tailnet through `tailscale serve` (see tailscale.ts).
//
// Who may: a paired device (web-devices.ts), by its HttpOnly cookie; and through serve, the machine's owner by their
// Tailscale login. Nothing secret is ever in an address. Every request must name a host the daemon is served at (so a
// DNS-rebound page can't reach it), and a WebSocket must come from the page's own origin (so another site can't ride the
// cookie).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { RpcPeer } from '@superego/protocol'
import { DEVICE_COOKIE, type WebDevices } from './web-devices.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.htm': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

/** The names the daemon is served at on this computer; Tailscale's is added when it serves there. */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** The cookie lasts as long as browsers let one; the daemon decides when a device has expired. */
const COOKIE_AGE = 400 * 24 * 60 * 60

/** Tailscale serve in front of the daemon, while it is (see tailscale.ts). */
export type ServedByTailscale = {
  /** The path serve proxies to: requests under it came through serve. */
  prefix: string
  /** This machine's name on the tailnet. */
  name: string
  /** The machine's owner's Tailscale login: admitted without pairing, unless `pairOwner`. */
  owner?: string
  pairOwner: boolean
  /** The tailnet device at an address, for the devices list. */
  nodeAt(address: string): Promise<string | undefined>
}

export type WebServer = {
  /** Where this computer reaches it. */
  url: string
  port: number
  /** Close the live connections of the devices `match` picks (by device id, `tailscale:<node>` for the owner's). */
  disconnect(match: (id: string) => boolean): void
  close(): Promise<void>
}

/** Who a request is from, as far as where it came in tells. */
type Caller = {
  path: string
  address: string
  /** The page's own origin, as the browser sees it. */
  origin: string
  /** Came through Tailscale serve: over HTTPS, with serve's identity headers. */
  serve?: ServedByTailscale
  login?: string
}

const cookieOf = (request: IncomingMessage) => {
  const value = new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([^;]+)`).exec(request.headers.cookie ?? '')?.[1]
  return value ? decodeURIComponent(value) : undefined
}
const header = (request: IncomingMessage, name: string) => { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value }
const hostname = (host: string) => host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!

/** Serve `root` (the window's build) and the protocol on 127.0.0.1:port, each connection a peer handed to `serve`. */
export async function serveWeb({ root, port, devices, tailscale, serve, artifact }: {
  root: string; port: number; devices: WebDevices; serve(peer: RpcPeer): () => void
  /** Tailscale serve in front, while it is. */
  tailscale?: () => ServedByTailscale | undefined
  /** A file of an artifact (an HTML page in a thread's folder, and what it links to), at /artifact/<thread>/<path>. */
  artifact?(thread: string, path: string): Promise<Buffer>
}): Promise<WebServer> {
  /** Where a request came in, or undefined if it names a host the daemon isn't served at. */
  const callerOf = (request: IncomingMessage): Caller | undefined => {
    const host = header(request, 'host') ?? ''
    const ts = tailscale?.()
    const loopback = LOOPBACK.has(request.socket.remoteAddress ?? '')
    let path = new URL(request.url ?? '/', 'http://x').pathname
    // Serve's prefix proves the request came through it; only on loopback, and only while Tailscale serves.
    const via = ts && loopback && (path === `/${ts.prefix}` || path.startsWith(`/${ts.prefix}/`)) ? ts : undefined
    if (via) path = path.slice(via.prefix.length + 1) || '/'
    const name = hostname(host).toLowerCase()
    if (!LOOPBACK_NAMES.has(name) && name !== ts?.name.toLowerCase()) return undefined
    if (via) {
      const address = header(request, 'x-forwarded-for')?.split(',')[0]?.trim() || 'tailnet'
      const login = header(request, 'tailscale-user-login')
      return { path, address, origin: `https://${via.name}`, serve: via, ...(login ? { login } : {}) }
    }
    return { path, address: request.socket.remoteAddress ?? 'unknown', origin: `http://${host}` }
  }
  /** Who a caller is: a paired device's id, or `tailscale:<node>` for the owner through serve; 'limited' after too many misses. */
  const identify = async (caller: Caller, cookie: string | undefined): Promise<string | 'limited' | undefined> => {
    if (devices.limited(caller.address)) return 'limited'
    const device = devices.check(cookie, caller.address)
    if (device) return device.id
    const ts = caller.serve
    if (ts && caller.login && ts.owner && caller.login === ts.owner && !ts.pairOwner) {
      const node = (await ts.nodeAt(caller.address)) ?? caller.address
      devices.seenOnTailscale(node, caller.address)
      return `tailscale:${node}`
    }
    if (cookie) devices.failed(caller.address)
    return undefined
  }
  /** A thread's artifacts, for one device (see /artifact/): made with a key this server keeps, so it's good until it stops. */
  const key = randomBytes(32)
  const mac = (who: string, thread: string) => createHmac('sha256', key).update(`${who}\0${thread}`).digest().subarray(0, 18)
  const capability = (who: string, thread: string) => `${Buffer.from(who).toString('base64url')}.${mac(who, thread).toString('base64url')}`
  /** Whose a capability for `thread` is, if it's one this server made. */
  const holder = (cap: string, thread: string) => {
    const [who, given] = cap.split('.').map((part) => Buffer.from(part, 'base64url'))
    if (!who || !given) return undefined
    const expected = mac(who.toString(), thread)
    return given.length === expected.length && timingSafeEqual(given, expected) ? who.toString() : undefined
  }
  const cookie = (caller: Caller, value: string, age = COOKIE_AGE) =>
    `${DEVICE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${caller.serve ? '; Secure' : ''}`
  /** Refused: a cookie that isn't a device's any more is cleared, so it stops counting against the address. */
  const refuse = (response: ServerResponse, caller: Caller, who: string | undefined, hadCookie: boolean) => {
    if (who === 'limited') return void response.writeHead(429, { 'content-type': 'text/plain' }).end('Too many tries. Wait a few minutes.')
    response.writeHead(401, hadCookie ? { 'set-cookie': cookie(caller, '', 0) } : {}).end()
  }

  const server: Server = createServer(async (request, response) => {
    const caller = callerOf(request)
    if (!caller) { response.writeHead(403, { 'content-type': 'text/plain' }).end('Unknown host'); return }
    const path = decodeURIComponent(caller.path)
    // Pairing: a ticket (from the link) or its code (typed in) makes this browser a device.
    if (path === '/pair') {
      if (request.method !== 'POST' || header(request, 'origin') !== caller.origin) { response.writeHead(403).end(); return }
      if (devices.limited(caller.address)) return refuse(response, caller, 'limited', false)
      const body = await readBody(request).catch(() => undefined)
      const given = (() => { try { return JSON.parse(body ?? '') as { ticket?: unknown; code?: unknown } } catch { return {} } })()
      const paired = await devices.redeem({
        ...(typeof given.ticket === 'string' ? { ticket: given.ticket } : {}), ...(typeof given.code === 'string' ? { code: given.code } : {}),
      }, { agent: header(request, 'user-agent'), address: caller.address })
      if (!paired) { devices.failed(caller.address); response.writeHead(401).end(); return }
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie(caller, paired.cookie), 'cache-control': 'no-store' })
      response.end(JSON.stringify({ name: paired.device.name }))
      return
    }
    // Whether this browser may in, for a page deciding whether to ask: the protocol itself only says so by closing.
    if (path === '/rpc') {
      const given = cookieOf(request)
      const who = await identify(caller, given)
      if (!who || who === 'limited') return refuse(response, caller, who, Boolean(given))
      response.writeHead(204, { 'cache-control': 'no-store' }).end()
      return
    }
    // Artifacts: a device's too, sandboxed. The page is shown from an opaque origin, which no cookie goes with, so a
    // device's request is sent on to an address under a capability for that thread and that device: what the page
    // links to (relative) carries it, and it lasts as long as the device does.
    if (path.startsWith('/artifact/') && artifact) {
      const [first, ...after] = caller.path.slice('/artifact/'.length).split('/')
      if (!first?.startsWith('~')) {
        const given = cookieOf(request)
        const who = await identify(caller, given)
        if (!who || who === 'limited') return refuse(response, caller, who, Boolean(given))
        const search = new URL(request.url ?? '/', 'http://x').search
        response.writeHead(302, { location: `/artifact/~${capability(who, decodeURIComponent(first ?? ''))}/${[first, ...after].join('/')}${search}`, 'cache-control': 'no-store' }).end()
        return
      }
      const [thread, ...rest] = after.map(decodeURIComponent)
      const who = holder(first.slice(1), thread ?? '')
      if (!who || !(who.startsWith('tailscale:') ? caller.serve?.owner && !caller.serve.pairOwner : devices.has(who))) { response.writeHead(401).end(); return }
      try {
        const content = await artifact(thread!, rest.join('/'))
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
  })

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
  /** Live connections, by who they are: revoking a device closes its own. */
  const live = new Map<WebSocket, string>()
  server.on('upgrade', async (request, socket, head) => {
    const deny = (status: string) => socket.end(`HTTP/1.1 ${status}\r\n\r\n`)
    const caller = callerOf(request)
    if (!caller) return deny('403 Forbidden')
    if (caller.path !== '/rpc') return deny('404 Not Found')
    if (header(request, 'origin') !== caller.origin) return deny('403 Forbidden')
    const who = await identify(caller, cookieOf(request))
    if (who === 'limited') return deny('429 Too Many Requests')
    if (!who) return deny('401 Unauthorized')
    sockets.handleUpgrade(request, socket, head, (ws) => {
      live.set(ws, who)
      const peer = new RpcPeer((line) => { if (ws.readyState === ws.OPEN) ws.send(line.trimEnd()) })
      const cleanup = serve(peer)
      ws.on('message', (data) => peer.receive(String(data)))
      ws.on('close', () => { live.delete(ws); peer.close(); cleanup() })
      ws.on('error', () => {})
    })
  })
  const disconnect = (match: (id: string) => boolean) => { for (const [ws, who] of live) if (match(who)) ws.terminate() }
  const unrevoke = devices.onRevoke((id) => disconnect((who) => who === id))

  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
  const bound = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    disconnect,
    close: () => new Promise<void>((resolve) => {
      unrevoke()
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

function readBody(request: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk; if (body.length > limit) { reject(new Error('Too large')); request.destroy() } })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}
