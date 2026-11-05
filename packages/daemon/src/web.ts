/// <reference path="./ws.d.ts" />
// mu in a browser: the daemon serves the app's window (the same build Electron loads) over HTTP, and the protocol over a
// WebSocket at /rpc. Off unless the machine's "Web access" setting turns it on. A token, made once per data dir, guards
// the protocol: the address Settings shows carries it (`#token=…`), and the page keeps it.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { RpcPeer } from '@mu/protocol'

/** The token a browser needs to speak to this daemon: kept in the data dir, made the first time. */
export async function webToken(dataDir: string): Promise<string> {
  const path = join(dataDir, 'web-token')
  const existing = await readFile(path, 'utf8').catch(() => '')
  if (existing.trim()) return existing.trim()
  const token = randomBytes(24).toString('base64url')
  await writeFile(path, token + '\n', { mode: 0o600 })
  return token
}

/** The first address other devices on the local network can reach this machine at. */
export function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) if (address.family === 'IPv4' && !address.internal) return address.address
  }
  return undefined
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

export type WebServer = { url: string; close(): Promise<void> }

/** Serve `root` (the window's build) and the protocol on host:port, each connection a peer handed to `serve`. */
export async function serveWeb({ root, host, port, token, serve }: {
  root: string; host: string; port: number; token: string; serve(peer: RpcPeer): () => void
}): Promise<WebServer> {
  const server: Server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)
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
  const expected = Buffer.from(token)
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://x')
    const given = Buffer.from(url.searchParams.get('token') ?? '')
    if (url.pathname !== '/rpc' || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const peer = new RpcPeer((line) => { if (ws.readyState === ws.OPEN) ws.send(line.trimEnd()) })
      const cleanup = serve(peer)
      ws.on('message', (data) => peer.receive(String(data)))
      ws.on('close', () => { peer.close(); cleanup() })
      ws.on('error', () => {})
    })
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, host, resolve))
  const shown = host === '0.0.0.0' ? lanAddress() ?? '127.0.0.1' : host
  return {
    url: `http://${shown}:${port}/#token=${token}`,
    close: () => new Promise<void>((resolve) => { for (const client of sockets.clients) client.terminate(); sockets.close(); server.close(() => resolve()); server.closeAllConnections() }),
  }
}
