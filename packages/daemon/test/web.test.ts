/// <reference path="../src/ws.d.ts" />
// Web access over a real HTTP server: pairing, the device cookie on the WebSocket and artifacts, Origin checks,
// revoking, Tailscale's headers, and the client list.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { defineApp, PROTOCOL_VERSION, RpcPeer, type ActionLogEntry, type ClientInfo, type Hello, type Notifications, type ThreadInfo } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { PairingCodes } from '../src/web-auth.ts'
import type { TailscaleNode } from '../src/tailscale.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
process.env.SUPEREGO_MODEL = 'faux'

const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string

const freePort = () => new Promise<number>((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)) })
})

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string }
/** One HTTP request, to a port on loopback or to a unix socket. */
const fetchRaw = (to: { port: number } | { socket: string }, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise<Reply>((resolve, reject) => {
    const req = httpRequest({ ...('port' in to ? { host: '127.0.0.1', port: to.port } : { socketPath: to.socket }), path, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })

/** Open a WebSocket to /rpc: the peer once it's open, or the status it was refused with. */
const openSocket = (address: string, headers: Record<string, string>) => new Promise<{ ws: WebSocket; peer: RpcPeer } | { status: number }>((resolve) => {
  const ws = new WebSocket(address, { headers })
  ws.on('error', () => {})
  ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }))
  ws.once('open', () => {
    const peer = new RpcPeer((line) => ws.send(line.trimEnd()))
    ws.on('message', (data) => peer.receive(String(data)))
    resolve({ ws, peer })
  })
})

const open = async ({ tailscale }: { tailscale?: TailscaleNode } = {}) => {
  const webRoot = join(dir, 'web')
  await mkdir(webRoot, { recursive: true })
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>superego</title>')
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: join(dir, 'data'), defaultCwd: dir, agentsDir: join(dir, 'agents'), webRoot, tailscale: async () => tailscale })
  const server = await listen(daemon, join(dir, 'data', 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'data', 'superego.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'superego-app', version: PROTOCOL_VERSION, label: 'laptop' })
  return { daemon, peer, hello, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

/** Turn on Web access to this computer on a free port; resolves once it answers. */
const serveLocal = async (peer: RpcPeer) => {
  const port = await freePort()
  await peer.call('settings.set', { key: 'web.port', value: port })
  await peer.call('settings.set', { key: 'web.access', value: 'local' })
  await until(async () => (await fetchRaw({ port }, '/session').catch(() => ({ status: 0 }))).status === 401)
  return { port, origin: `http://127.0.0.1:${port}` }
}

const pairWith = (port: number, code: string, headers: Record<string, string> = { origin: `http://127.0.0.1:${port}` }, name?: string) =>
  fetchRaw({ port }, '/pair', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code, ...(name ? { name } : {}) }) })

const cookieOf = (reply: Reply) => String(reply.headers['set-cookie']?.[0] ?? '').split(';')[0]!

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-web-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('web access', () => {
  it('pairs a browser with a one-time code, for a cookie that opens the protocol and artifacts', async () => {
    const { peer, close } = await open()
    const { port, origin } = await serveLocal(peer)
    const made = await peer.call<{ code: string; url: string }>('web.pair', {})
    expect(made.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    // The code rides in the fragment, which browsers don't send.
    expect(made.url).toBe(`http://127.0.0.1:${port}/#pair=${made.code}`)

    const paired = await pairWith(port, made.code.toLowerCase().replace('-', ' '), { origin }, 'My phone')
    expect(paired.status).toBe(200)
    const setCookie = String(paired.headers['set-cookie'])
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    expect(setCookie).not.toMatch(/Secure/)
    const cookie = cookieOf(paired)
    // Only a hash is kept on disk.
    const devicesFile = join(dir, 'data', 'web-devices.json')
    await until(async () => (await readFile(devicesFile, 'utf8').catch(() => '')).includes('My phone'))
    const stored = await readFile(devicesFile, 'utf8')
    expect(stored).not.toContain(cookie.split('.')[1])
    expect(stored).toContain('My phone')

    // Single use.
    expect((await pairWith(port, made.code, { origin })).status).toBe(401)

    expect(JSON.parse((await fetchRaw({ port }, '/session', { headers: { cookie } })).body)).toMatchObject({ via: 'web', name: 'My phone' })
    // The WebSocket: refused without the cookie, or from another site's page; open with both.
    expect(await openSocket(`ws://127.0.0.1:${port}/rpc`, { origin })).toEqual({ status: 401 })
    expect(await openSocket(`ws://127.0.0.1:${port}/rpc`, { origin: 'http://evil.example', cookie })).toEqual({ status: 403 })
    expect(await openSocket(`ws://127.0.0.1:${port}/rpc`, { cookie })).toEqual({ status: 403 })
    const opened = await openSocket(`ws://127.0.0.1:${port}/rpc`, { origin, cookie })
    if (!('peer' in opened)) throw new Error(`refused ${opened.status}`)
    const hello = await opened.peer.call<Hello>('hello', { client: 'web', version: PROTOCOL_VERSION })
    expect(hello.client).toMatch(/^c/)

    // Artifacts by the same cookie.
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir, title: 'art' })
    await writeFile(join(dir, 'page.html'), '<h1>hi</h1>')
    expect((await fetchRaw({ port }, `/artifact/${thread.id}/page.html`)).status).toBe(401)
    const page = await fetchRaw({ port }, `/artifact/${thread.id}/page.html`, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(page.body).toBe('<h1>hi</h1>')
    expect(page.headers['content-security-policy']).toMatch(/sandbox/)
    // The app itself is public.
    expect((await fetchRaw({ port }, '/')).status).toBe(200)
    opened.ws.close()
    await close()
  })

  it('refuses pairing from another origin, and a wrong code; codes expire and give up after a few tries', async () => {
    const { peer, close } = await open()
    const { port } = await serveLocal(peer)
    const { code } = await peer.call<{ code: string }>('web.pair', {})
    expect((await pairWith(port, code, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await pairWith(port, code, {})).status).toBe(403)
    expect((await fetchRaw({ port }, '/pair', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'text/plain' }, body: JSON.stringify({ code }) })).status).toBe(415)
    expect((await fetchRaw({ port }, '/pair', { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(405)
    expect((await pairWith(port, 'AAAA-AAAA')).status).toBe(401)
    // Still open after a wrong guess, and refused cross-origin above without being used up.
    expect((await pairWith(port, code)).status).toBe(200)
    await close()

    const quick = new PairingCodes({ ttl: 30 })
    const soon = quick.issue()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(quick.take(soon.code)).toBe(false)

    const guarded = new PairingCodes({ tries: 3 })
    const kept = guarded.issue()
    for (let i = 0; i < 3; i++) expect(guarded.take('ZZZZ-ZZZZ')).toBe(false)
    expect(guarded.take(kept.code)).toBe(false)
  })

  it('revoking a device closes its live socket at once and forgets its cookie', async () => {
    const { peer, close } = await open()
    const { port, origin } = await serveLocal(peer)
    const { code } = await peer.call<{ code: string }>('web.pair', {})
    const cookie = cookieOf(await pairWith(port, code))
    const opened = await openSocket(`ws://127.0.0.1:${port}/rpc`, { origin, cookie })
    if (!('peer' in opened)) throw new Error(`refused ${opened.status}`)
    await opened.peer.call('hello', { client: 'web', version: PROTOCOL_VERSION })
    const closed = new Promise<number>((resolve) => opened.ws.once('close', (code) => resolve(code)))

    const { value: devices } = (await peer.call<{ value: { sections: { id: string; data: { devices: { id: string; name: string }[] } }[] } }>('settings.watch', {}))
    const device = devices.sections.find((s) => s.id === 'web')!.data.devices[0]!
    expect(device.name).toBe('A browser')
    await peer.call('web.device.rename', { id: device.id, name: 'Kitchen iPad' })
    const clients = await peer.call<{ value: ClientInfo[] }>('clients.watch', {})
    expect(clients.value.find((c) => c.via === 'web')).toMatchObject({ kind: 'web', label: 'Kitchen iPad', device: device.id })

    const started = Date.now()
    await peer.call('web.device.revoke', { id: device.id })
    expect(await closed).toBe(4401)
    expect(Date.now() - started).toBeLessThan(900)
    expect((await fetchRaw({ port }, '/session', { headers: { cookie } })).status).toBe(401)
    expect(await openSocket(`ws://127.0.0.1:${port}/rpc`, { origin, cookie })).toEqual({ status: 401 })
    await until(async () => !(await peer.call<{ value: ClientInfo[] }>('clients.watch', {})).value.some((c) => c.via === 'web'))
    await close()
  })

  it('through Tailscale: admits the node owner and listed logins by header, on a socket only', async () => {
    const { peer, close } = await open({ tailscale: { owner: 'Owner@example.com', dnsName: 'box.tail.ts.net' } })
    // On the TCP listener the headers mean nothing.
    const { port } = await serveLocal(peer)
    expect((await fetchRaw({ port }, '/session', { headers: { 'tailscale-user-login': 'owner@example.com' } })).status).toBe(401)

    await peer.call('settings.set', { key: 'web.access', value: 'tailscale' })
    const socket = join(dir, 'data', 'web.sock')
    await until(async () => (await fetchRaw({ socket }, '/session').catch(() => ({ status: 0 }))).status === 401)
    expect((await fetchRaw({ port }, '/session').catch(() => ({ status: 0 }))).status).toBe(0)
    const as = (login: string) => fetchRaw({ socket }, '/session', { headers: { 'tailscale-user-login': login, 'tailscale-user-name': '=?utf-8?q?M=C3=B8ller?=' } })
    expect(JSON.parse((await as('owner@example.com')).body)).toEqual({ via: 'tailscale', name: 'owner@example.com' })
    expect((await as('friend@example.com')).status).toBe(403)
    await peer.call('settings.set', { key: 'web.tailscale.logins', value: 'friend@example.com, other@example.com' })
    expect((await as('friend@example.com')).status).toBe(200)
    // Nothing to pair here.
    expect((await fetchRaw({ socket }, '/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://box.tail.ts.net:7777' }, body: '{}' })).status).toBe(404)
    await expect(peer.call('web.pair', {})).rejects.toMatchObject({ kind: 'unsupported' })

    const proxied = { origin: `https://box.tail.ts.net:${port}`, 'x-forwarded-host': `box.tail.ts.net:${port}`, 'x-forwarded-proto': 'https' }
    expect(await openSocket(`ws+unix://${socket}:/rpc`, proxied)).toEqual({ status: 401 })
    expect(await openSocket(`ws+unix://${socket}:/rpc`, { ...proxied, 'tailscale-user-login': 'stranger@example.com' })).toEqual({ status: 403 })
    const opened = await openSocket(`ws+unix://${socket}:/rpc`, { ...proxied, 'tailscale-user-login': 'friend@example.com' })
    if (!('peer' in opened)) throw new Error(`refused ${opened.status}`)
    await opened.peer.call('hello', { client: 'web', version: PROTOCOL_VERSION })
    const { value } = await opened.peer.call<{ value: ClientInfo[] }>('clients.watch', {})
    expect(value.find((c) => c.via === 'tailscale')).toMatchObject({ label: 'friend@example.com', kind: 'web' })

    const { value: settings } = await peer.call<{ value: { sections: { id: string; data: { tailscale: { command: string; address: string; owner: string } } }[] } }>('settings.watch', {})
    expect(settings.sections.find((s) => s.id === 'web')!.data.tailscale).toMatchObject({
      command: `tailscale serve --bg --https=${port} unix:${socket}`, address: `https://box.tail.ts.net:${port}/`, owner: 'Owner@example.com',
    })
    opened.ws.close()
    await close()
  })

  it('lists who is connected, names them in the action log, and passes window actions between them', async () => {
    const { peer, hello, close } = await open()
    const second = await connectSocket(join(dir, 'data', 'superego.sock'))
    await second.peer.call('hello', { client: 'superego-cli', version: PROTOCOL_VERSION, label: 'desk' })

    const watched = await peer.call<{ sub: string; value: ClientInfo[] }>('clients.watch', {})
    expect(watched.value.map((c) => [c.kind, c.label, c.via])).toEqual([['superego-app', 'laptop', 'socket'], ['superego-cli', 'desk', 'socket']])
    expect(watched.value[0]!.id).toBe(hello.client)

    await second.peer.call('thread.create', { title: 'from the desk' })
    const log = await peer.call<ActionLogEntry[]>('action.log', {})
    expect(log.find((e) => e.id === 'thread.create')?.client).toMatchObject({ kind: 'superego-cli', label: 'desk' })

    const asked = new Promise<Notifications['client.perform']>((resolve) => peer.on('client.perform', resolve))
    // Only navigation passes: nothing that makes, sends or opens.
    await expect(second.peer.call('client.perform', { client: hello.client, action: 'app.newWindow' })).rejects.toMatchObject({ kind: 'not_exposed' })
    await second.peer.call('client.perform', { client: hello.client, action: 'thread.select', params: { machine: 'local', thread: 't1' } })
    expect(await asked).toMatchObject({ action: 'thread.select', params: { machine: 'local', thread: 't1' }, from: { label: 'desk' } })
    await expect(second.peer.call('client.perform', { client: 'nobody', action: 'thread.next' })).rejects.toMatchObject({ kind: 'not_found' })

    const changed = new Promise<ClientInfo[]>((resolve) => peer.on('clients.changed', ({ value }: Notifications['clients.changed']) => { if (value.length === 1) resolve(value) }))
    second.socket.destroy()
    expect((await changed).map((c) => c.label)).toEqual(['laptop'])
    await close()
  })
})
