/// <reference path="./ws.d.ts" />
// Superego in a browser: the daemon serves the app's window (the same build Electron loads) over HTTP on loopback, and
// the protocol over a WebSocket at /rpc. Off unless the machine's "Web access" setting turns it on: for this computer,
// or for the tailnet through `tailscale serve` (see tailscale.ts).
//
// Who may: a paired device (web-devices.ts), by its HttpOnly cookie; and through serve, the machine's owner by their
// Tailscale login. Nothing secret is ever in an address. Every request must name a host the daemon is served at (so a
// DNS-rebound page can't reach it), and a WebSocket must come from the page's own origin (so another site can't ride the
// cookie). The hosts are loopback's, the one the `web.host` setting names (a name it's reached at some other way: a
// proxy of the user's own, whose requests are plain loopback ones, so pairing still decides who gets in through it), and
// through serve, Tailscale's.
//
// Two listeners. 127.0.0.1:<port>, which anyone on this computer reaches (every local user, and pages in a browser
// here), so what a request there says of itself counts for nothing: it's a device by its cookie or no one. And while
// Tailscale serves, a Unix socket in a folder only the daemon's user (and root, as tailscaled runs) can open: serve
// proxies there, and only there are its headers (Tailscale-User-Login, X-Forwarded-For, X-Forwarded-Host, each set
// by serve over whatever the browser sent) believed.
//
// Nothing a request is or says (a path that isn't one, a broken cookie, a body that's no object) takes the daemon
// down: each listener answers what's malformed with 400 and anything that throws with 500, and says what threw.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, join, normalize, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { RpcPeer } from '@superego/protocol'
import { DEVICE_COOKIE, type WebDevices } from './web-devices.ts'
import type { Via } from './clients.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.htm': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

/** The names the daemon is served at on this computer's loopback. */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
/** The cookie lasts as long as browsers let one; the daemon decides when a device has expired. */
const COOKIE_AGE = 400 * 24 * 60 * 60
/** How long a page's grant to its thread's files outlives its last use, where it can't be bound to a tailnet device. */
export const GRANT_IDLE = 15 * 60 * 1000

/** Tailscale serve in front of the daemon, while it is (see tailscale.ts). */
export type ServedByTailscale = {
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
  /** Its path as sent (still percent-encoded), and its query. */
  path: string
  search: string
  /** Where it came from: through serve, the tailnet address serve says; else the socket's (loopback). */
  address: string
  /** The page's own origin, as the browser sees it. */
  origin: string
  /** Came through Tailscale serve: over HTTPS, with serve's identity headers. */
  serve?: ServedByTailscale
  login?: string
}

/** A request that isn't one the server can make sense of: answered 400, before anything else looks at it. */
class Malformed extends Error {}

/** A percent-encoded part of an address, decoded; Malformed when it isn't validly encoded. */
const decode = (value: string) => { try { return decodeURIComponent(value) } catch { throw new Malformed(`Malformed address: ${value}`) } }

/** A request's path and query. Malformed for a target that's no path (`*`, an absolute URL) or no URL at all. */
function targetOf(request: IncomingMessage): { path: string; search: string } {
  const target = request.url ?? '/'
  if (!target.startsWith('/')) throw new Malformed(`Not a path: ${target}`)
  try {
    const url = new URL(`http://x${target}`)
    return { path: url.pathname, search: url.search }
  } catch { throw new Malformed(`Not a path: ${target}`) }
}

const cookieOf = (request: IncomingMessage) => {
  const value = new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([^;]+)`).exec(request.headers.cookie ?? '')?.[1]
  // A cookie that doesn't decode is no device's: checked as it is, it's a miss like any wrong one.
  if (!value) return undefined
  try { return decodeURIComponent(value) } catch { return value }
}
const header = (request: IncomingMessage, name: string) => { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value }
const hostname = (host: string) => host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!
/** Whether a Host header names `origin`'s host (its port as the scheme has it by default, when left out). */
const sameHost = (origin: string, host: string) => {
  try { return new URL(`${new URL(origin).protocol}//${host}`).host === new URL(origin).host } catch { return false }
}

/**
 * The origin a `web.host` value names: a hostname (`box.example.ts.net`, over HTTPS), with a port (`box.lan:8080`), or a
 * whole origin (`http://box.lan:7777`). Empty is none (the address Web access works out itself); anything else, an error
 * saying what's wrong with it.
 */
export function webOrigin(value: string): string | undefined {
  const given = value.trim()
  if (!given) return undefined
  const bad = (why: string): never => { throw new Error(why) }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(given)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https') bad(`${scheme}: isn't a web address: use http or https`)
  let url: URL
  try { url = new URL(scheme ? given : `https://${given}`) } catch { return bad(`${JSON.stringify(given)} isn't a hostname or an origin`) }
  if (url.username || url.password) bad('no user or password: just the hostname')
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(given)) bad('no path: just the hostname, and a port if it has one')
  const name = url.hostname
  const ip = name.startsWith('[') || /^\d+(\.\d+){3}$/.test(name)
  if (!ip && !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(name)) bad(`${JSON.stringify(name)} isn't a hostname`)
  return url.origin
}

/**
 * Serve `root` (the window's build) and the protocol on 127.0.0.1:port, each connection a peer handed to `serve`; and
 * while Tailscale serves, at `serveSocket` too, for serve alone to proxy to.
 */
export async function serveWeb({ root, port, devices, tailscale, serveSocket, origin, serve, artifact }: {
  root: string; port: number; devices: WebDevices
  /** The origin the `web.host` setting says it's reached at, if it says one (see webOrigin). */
  origin?: () => string | undefined
  /** Serve a connection: `via` names who it is in the client list, `hangUp` closes it. */
  serve(peer: RpcPeer, transport: { via: Via; hangUp: () => void }): () => void
  /** Tailscale serve in front, while it is. */
  tailscale?: () => ServedByTailscale | undefined
  /**
   * The Unix socket Tailscale serve proxies to: in a folder of the daemon's user's alone (0700), so whatever comes in
   * there came through serve, and its identity headers are serve's. Made here, and removed as the server closes.
   */
  serveSocket?: string
  /**
   * A file of an artifact (an HTML page in a thread's folder, and what it links to), at /artifact/<thread>/<path>; of a
   * thread on another machine this daemon reaches, at /artifact/<thread>@<machine>/<path>. Refused (throwing) for one
   * that isn't really in the thread's folder (see artifacts.ts).
   */
  artifact?(thread: string, path: string, machine?: string): Promise<Buffer>
}): Promise<WebServer> {
  /** Where a request came in (`viaServe`: on serve's socket); undefined if it names a host the daemon isn't served at. */
  const callerOf = (request: IncomingMessage, viaServe: boolean): Caller | undefined => {
    const { path, search } = targetOf(request)
    // Serve sends a socket's requests to `localhost`, and the host the browser asked for in X-Forwarded-Host.
    const host = header(request, viaServe ? 'x-forwarded-host' : 'host') ?? ''
    const chosen = origin?.()
    const isChosen = Boolean(chosen && sameHost(chosen, host))
    const name = hostname(host).toLowerCase()
    if (viaServe) {
      // Serve's socket, while serve isn't (or no longer) set up to proxy there: nothing to believe its headers by.
      const ts = tailscale?.()
      if (!ts || (!isChosen && name !== ts.name.toLowerCase())) return undefined
      const address = header(request, 'x-forwarded-for')?.split(',')[0]?.trim() || 'tailnet'
      const login = header(request, 'tailscale-user-login')
      return { path, search, address, origin: isChosen ? chosen! : `https://${ts.name}`, serve: ts, ...(login ? { login } : {}) }
    }
    if (!isChosen && !LOOPBACK_NAMES.has(name)) return undefined
    return { path, search, address: request.socket.remoteAddress ?? 'unknown', origin: isChosen ? chosen! : `http://${host}` }
  }
  /** Whether the owner's Tailscale login is let in as it is: through serve, theirs, and pairing not required of it. */
  const isOwner = (caller: Caller) => Boolean(caller.serve && caller.login && caller.serve.owner && caller.login === caller.serve.owner && !caller.serve.pairOwner)
  /** Who a caller is: a paired device's id, or `tailscale:<node>` for the owner through serve; 'limited' after too many misses. */
  const identify = async (caller: Caller, cookie: string | undefined): Promise<string | 'limited' | undefined> => {
    if (devices.limited(caller.address)) return 'limited'
    const device = devices.check(cookie, caller.address)
    if (device) return device.id
    if (isOwner(caller)) {
      const node = (await caller.serve!.nodeAt(caller.address)) ?? caller.address
      devices.seenOnTailscale(node, caller.address)
      return `tailscale:${node}`
    }
    if (cookie) devices.failed(caller.address)
    return undefined
  }

  // Artifacts are shown from an opaque origin (their CSP sandboxes them), which no cookie goes with: what a page links
  // to comes without one. So the page's own request, which has it, is sent on to an address under a grant: a random
  // name for "this device's view of this thread's files", which the rest of the page's requests carry. The page can
  // read its own address, and a script in it (the agent's, from whatever it read) can send it anywhere, so a grant is
  // held to whom and where it was given: the device (or the owner's login) as long as it may in, and through serve, the
  // same tailnet device (its address, which serve vouches for), so it's worth nothing from any other. On loopback every
  // caller looks alike (anyone on this computer, or behind a proxy of the user's), so there it can't be held to one:
  // it lapses instead, GRANT_IDLE after the page last used it. Grants are the server's: a restart ends them all.
  type Grant = { who: string; thread: string; address: string; serve: boolean; login: string | undefined; used: number }
  const grants = new Map<string, Grant>()
  const fresh = (grant: Grant, now = Date.now()) => grant.serve || now - grant.used < GRANT_IDLE
  /** Whether a grant still stands for a request: from where it was given, by whom it was given to. */
  const stands = (grant: Grant, caller: Caller) =>
    fresh(grant) && grant.serve === Boolean(caller.serve) && grant.address === caller.address && grant.login === caller.login &&
    (grant.who.startsWith('tailscale:') ? isOwner(caller) : devices.has(grant.who))
  const grant = (who: string, thread: string, caller: Caller) => {
    for (const [name, old] of grants) {
      if (!fresh(old) || (!old.who.startsWith('tailscale:') && !devices.has(old.who))) grants.delete(name)
      else if (old.who === who && old.thread === thread && stands(old, caller)) { old.used = Date.now(); return name }
    }
    const name = randomBytes(18).toString('base64url')
    grants.set(name, { who, thread, address: caller.address, serve: Boolean(caller.serve), login: caller.login, used: Date.now() })
    return name
  }

  const cookie = (caller: Caller, value: string, age = COOKIE_AGE) =>
    `${DEVICE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${caller.origin.startsWith('https:') ? '; Secure' : ''}`
  /** Refused: a cookie that isn't a device's any more is cleared, so it stops counting against the address. */
  const refuse = (response: ServerResponse, caller: Caller, who: string | undefined, hadCookie: boolean) => {
    if (who === 'limited') return void response.writeHead(429, { 'content-type': 'text/plain' }).end('Too many tries. Wait a few minutes.')
    response.writeHead(401, hadCookie ? { 'set-cookie': cookie(caller, '', 0) } : {}).end()
  }

  const handle = async (request: IncomingMessage, response: ServerResponse, viaServe: boolean) => {
    const caller = callerOf(request, viaServe)
    if (!caller) { response.writeHead(403, { 'content-type': 'text/plain' }).end('Unknown host'); return }
    const path = decode(caller.path)
    // Pairing: a ticket (from the link) or its code (typed in) makes this browser a device.
    if (path === '/pair') {
      if (request.method !== 'POST' || header(request, 'origin') !== caller.origin) { response.writeHead(403).end(); return }
      if (devices.limited(caller.address)) return refuse(response, caller, 'limited', false)
      const body = await readBody(request).catch(() => undefined)
      const parsed = (() => { try { return JSON.parse(body ?? '') as unknown } catch { return undefined } })()
      const given = (parsed && typeof parsed === 'object' ? parsed : {}) as { ticket?: unknown; code?: unknown }
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
    // Artifacts: a device's too, sandboxed, under a grant (see above).
    if (caller.path.startsWith('/artifact/') && artifact) {
      const [first = '', ...after] = caller.path.slice('/artifact/'.length).split('/')
      if (!first.startsWith('~')) {
        const given = cookieOf(request)
        const who = await identify(caller, given)
        if (!who || who === 'limited') return refuse(response, caller, who, Boolean(given))
        const name = grant(who, decode(first), caller)
        response.writeHead(302, { location: `/artifact/~${name}/${[first, ...after].join('/')}${caller.search}`, 'cache-control': 'no-store' }).end()
        return
      }
      const [thread = '', ...rest] = after.map(decode)
      const held = grants.get(first.slice(1))
      if (!held || held.thread !== thread || !stands(held, caller)) { response.writeHead(401).end(); return }
      held.used = Date.now()
      try {
        const [id, machine] = thread.split('@')
        const content = await artifact(id!, rest.join('/'), machine)
        response.writeHead(200, {
          'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
          'content-security-policy': "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: 'unsafe-inline' 'unsafe-eval'",
          'cache-control': 'no-cache',
        })
        response.end(content)
      } catch (error) {
        const kind = (error as { kind?: string }).kind
        response.writeHead(kind === 'forbidden' ? 403 : kind === 'too_large' ? 413 : 404, { 'content-type': 'text/plain' }).end((error as Error).message)
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
  /** Live connections, by who they are: revoking a device closes its own. */
  const live = new Map<WebSocket, string>()
  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer, viaServe: boolean) => {
    const deny = (status: string) => socket.end(`HTTP/1.1 ${status}\r\n\r\n`)
    const caller = callerOf(request, viaServe)
    if (!caller) return deny('403 Forbidden')
    if (caller.path !== '/rpc') return deny('404 Not Found')
    if (header(request, 'origin') !== caller.origin) return deny('403 Forbidden')
    const who = await identify(caller, cookieOf(request))
    if (who === 'limited') return deny('429 Too Many Requests')
    if (!who) return deny('401 Unauthorized')
    if (socket.destroyed) return
    // For the client list: a paired device by its name, the owner by their login. Through serve, it's on another
    // computer of the tailnet; otherwise on this one (Web access listens on loopback).
    const elsewhere = Boolean(caller.serve)
    const via: Via = who.startsWith('tailscale:')
      ? { via: 'tailscale', label: caller.login ?? who.slice('tailscale:'.length), elsewhere }
      : { via: 'web', device: who, label: devices.list().find((d) => d.id === who)?.name ?? 'A browser', elsewhere }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      live.set(ws, who)
      // Full past 1 MiB unsent, as a socket's write says; each sent message checks whether there's room again.
      const room = () => ws.bufferedAmount < 1024 * 1024
      const peer = new RpcPeer((line) => {
        if (ws.readyState !== ws.OPEN) return true
        ws.send(line.trimEnd(), () => { if (room()) peer.drain() })
        return room()
      })
      const cleanup = serve(peer, { via, hangUp: () => ws.terminate() })
      ws.on('message', (data) => peer.receive(String(data)))
      ws.on('close', () => { live.delete(ws); peer.close(); cleanup() })
      // A connection that breaks is closed too (ws emits 'close' after 'error'), which is where it's cleaned up.
      ws.on('error', () => {})
    })
  }

  /** A listener's server: every request and upgrade answered, whatever it throws (see above). */
  const listener = (viaServe: boolean) => {
    const server = createServer((request, response) => {
      handle(request, response, viaServe).catch((error: unknown) => {
        if (error instanceof Malformed) {
          if (!response.headersSent) response.writeHead(400, { 'content-type': 'text/plain' }).end(error.message)
          else response.destroy()
          return
        }
        console.error(`Web access: ${request.method} ${request.url} failed:`, error)
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' }).end('Something went wrong here: the daemon\'s log says what.')
        else response.destroy()
      })
    })
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Node leaves an upgrading socket without an error listener: one that resets while it's checked would be thrown.
      // Its end is all that's left to say then, and the request's handling sees it closed.
      socket.on('error', () => {})
      upgrade(request, socket, head, viaServe).catch((error: unknown) => {
        if (error instanceof Malformed) return void socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        console.error(`Web access: upgrading ${request.url} failed:`, error)
        socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      })
    })
    return server
  }
  const disconnect = (match: (id: string) => boolean) => { for (const [ws, who] of live) if (match(who)) ws.terminate() }
  const unrevoke = devices.onRevoke((id) => disconnect((who) => who === id))

  const servers: Server[] = []
  /** Listen at a port of loopback's, or a socket's path. */
  const listen = (server: Server, at: number | string) => new Promise<void>((resolve, reject) => {
    const listening = () => { server.off('error', reject); servers.push(server); resolve() }
    server.once('error', reject)
    if (typeof at === 'number') server.listen(at, '127.0.0.1', listening)
    else server.listen(at, listening)
  })
  const close = async () => {
    unrevoke()
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })))
    if (serveSocket) await rm(serveSocket, { force: true })
  }
  const server = listener(false)
  try {
    await listen(server, port)
    if (serveSocket) {
      await privateFolder(dirname(serveSocket))
      // One left by a daemon that didn't close (a crash): nothing listens there, so it's in the way.
      await rm(serveSocket, { force: true })
      await listen(listener(true), serveSocket)
      await chmod(serveSocket, 0o600)
    }
  } catch (error) {
    await close()
    throw error
  }
  const bound = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${bound}`, port: bound, disconnect, close }
}

/**
 * Make `dir` a folder only this user opens (0700), or say why it can't be: one that's a symlink, or someone else's, is
 * refused, since whoever has it could put their own listener where serve proxies to, or reach the daemon's.
 */
async function privateFolder(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory()) throw new Error(`${dir} isn't a folder`)
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`)
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700)
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
