/// <reference path="../src/ws.d.ts" />
// Web access over a real HTTP server: pairing, the credential as the WebSocket's first message, artifact tickets,
// Origin and Host checks, revoking, Tailscale's headers, and the client list.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { defineApp, PROTOCOL_VERSION, RpcPeer, type ActionLogEntry, type ClientInfo, type Hello, type Notifications, type ThreadInfo } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { serveWeb } from '../src/web.ts'
import { PairingCodes, Tickets } from '../src/web-auth.ts'
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

/** Open a WebSocket to /rpc: the peer once it's open, or the status it was refused with. `closed` says how it ended. */
const openSocket = (address: string, headers: Record<string, string>) => new Promise<{ ws: WebSocket; peer: RpcPeer; closed: Promise<{ code: number; reason: string }> } | { status: number }>((resolve) => {
  const ws = new WebSocket(address, { headers })
  ws.on('error', () => {})
  ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }))
  const closed = new Promise<{ code: number; reason: string }>((done) => ws.once('close', (code, reason) => done({ code, reason: String(reason) })))
  ws.once('open', () => {
    const peer = new RpcPeer((line) => ws.send(line.trimEnd()))
    ws.on('message', (data) => peer.receive(String(data)))
    resolve({ ws, peer, closed })
  })
})

/** A socket that has said `auth` with `credential` and been let in. */
const authed = async (address: string, headers: Record<string, string>, credential?: string) => {
  const opened = await openSocket(address, headers)
  if (!('peer' in opened)) throw new Error(`refused ${opened.status}`)
  const who = await opened.peer.call<{ via: string; name: string; device?: string }>('auth', credential ? { credential } : {})
  return { ...opened, who }
}

/** How a socket that says `auth` with `credential` is turned away. */
const turnedAway = async (address: string, headers: Record<string, string>, credential?: string) => {
  const opened = await openSocket(address, headers)
  if (!('peer' in opened)) return { status: opened.status }
  opened.peer.call('auth', credential ? { credential } : {}).catch(() => {})
  return opened.closed
}

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
  await until(async () => (await fetchRaw({ port }, '/').catch(() => ({ status: 0 }))).status === 200)
  return { port, origin: `http://127.0.0.1:${port}`, rpc: `ws://127.0.0.1:${port}/rpc` }
}

const pairWith = (port: number, code: string, headers: Record<string, string> = { origin: `http://127.0.0.1:${port}` }, name?: string) =>
  fetchRaw({ port }, '/pair', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code, ...(name ? { name } : {}) }) })

const credentialOf = (reply: Reply) => (JSON.parse(reply.body) as { credential: string }).credential

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-web-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('web access', () => {
  it('pairs a browser with a one-time code, for a credential the page keeps and sends first on its socket', async () => {
    const { peer, close } = await open()
    const { port, origin, rpc } = await serveLocal(peer)
    const made = await peer.call<{ code: string; url: string }>('web.pair', {})
    expect(made.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    // The code rides in the fragment, which browsers don't send.
    expect(made.url).toBe(`http://127.0.0.1:${port}/#pair=${made.code}`)

    const paired = await pairWith(port, made.code.toLowerCase().replace('-', ' '), { origin }, 'My phone')
    expect(paired.status).toBe(200)
    // No cookie: a cookie would go to every port on this host.
    expect(paired.headers['set-cookie']).toBeUndefined()
    const credential = credentialOf(paired)
    expect(JSON.parse(paired.body)).toMatchObject({ name: 'My phone' })
    // Only a hash is kept on disk, written whole.
    const devicesFile = join(dir, 'data', 'web-devices.json')
    await until(async () => (await readFile(devicesFile, 'utf8').catch(() => '')).includes('My phone'))
    expect(await readFile(devicesFile, 'utf8')).not.toContain(credential.split('.')[1])
    expect(existsSync(`${devicesFile}.tmp`)).toBe(false)

    // Single use.
    expect((await pairWith(port, made.code, { origin })).status).toBe(401)

    // The WebSocket: refused from another site's page; open from this one, but nothing is served before `auth`.
    expect(await openSocket(rpc, { origin: 'http://evil.example' })).toEqual({ status: 403 })
    expect(await openSocket(rpc, {})).toEqual({ status: 403 })
    expect(await turnedAway(rpc, { origin })).toMatchObject({ code: 4401 })
    expect(await turnedAway(rpc, { origin }, `${credential.split('.')[0]}.wrong`)).toMatchObject({ code: 4401 })
    const early = await openSocket(rpc, { origin })
    if (!('peer' in early)) throw new Error('refused')
    early.peer.call('hello', { client: 'web', version: PROTOCOL_VERSION }).catch(() => {})
    expect(await early.closed).toMatchObject({ code: 4401, reason: 'Send auth first' })

    const opened = await authed(rpc, { origin }, credential)
    expect(opened.who).toMatchObject({ via: 'web', name: 'My phone' })
    const hello = await opened.peer.call<Hello>('hello', { client: 'web', version: PROTOCOL_VERSION })
    expect(hello.client).toMatch(/^c/)

    // Artifacts by ticket: one thread's, with its relative files beside it.
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir, title: 'art' })
    await writeFile(join(dir, 'page.html'), '<h1>hi</h1>')
    await writeFile(join(dir, 'page.css'), 'h1 {}')
    expect((await fetchRaw({ port }, `/artifact/${thread.id}/page.html`)).status).toBe(401)
    await expect(peer.call('artifact.ticket', { thread: thread.id })).rejects.toMatchObject({ kind: 'unsupported' })
    const ticket = await opened.peer.call<{ path: string; expires: number }>('artifact.ticket', { thread: thread.id })
    expect(ticket.path).toMatch(/^\/artifact\/[\w-]+\/$/)
    expect(ticket.expires - Date.now()).toBeGreaterThan(50 * 60_000)
    const page = await fetchRaw({ port }, `${ticket.path}page.html`)
    expect(page.status).toBe(200)
    expect(page.body).toBe('<h1>hi</h1>')
    expect(page.headers['content-security-policy']).toMatch(/sandbox/)
    expect((await fetchRaw({ port }, `${ticket.path}page.css`)).body).toBe('h1 {}')
    expect((await fetchRaw({ port }, `${ticket.path}../page.html`)).status).not.toBe(200)
    await expect(opened.peer.call('artifact.ticket', { thread: 'nope' })).rejects.toMatchObject({ kind: 'not_found' })
    // The app itself is public.
    expect((await fetchRaw({ port }, '/')).status).toBe(200)
    opened.ws.close()
    await close()
  })

  it('closes a socket that never says who it is', async () => {
    const { peer, close } = await open()
    const { origin, rpc } = await serveLocal(peer)
    const opened = await openSocket(rpc, { origin })
    if (!('peer' in opened)) throw new Error('refused')
    expect(await opened.closed).toMatchObject({ code: 4401 })
    await close()
  }, 10_000)

  it('answers only to its own names, so a name pointed at it (DNS rebinding) gets nothing', async () => {
    const { peer, close } = await open()
    const { port, rpc } = await serveLocal(peer)
    expect((await fetchRaw({ port }, '/', { headers: { host: `evil.example:${port}` } })).status).toBe(421)
    expect((await pairWith(port, 'AAAA-AAAA', { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).status).toBe(421)
    expect(await openSocket(rpc, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toEqual({ status: 421 })
    // A forwarded host means nothing on a TCP listener: anyone could send one.
    expect(await openSocket(rpc, { origin: `http://evil.example:${port}`, 'x-forwarded-host': `evil.example:${port}` })).toEqual({ status: 403 })
    expect((await fetchRaw({ port }, '/', { headers: { host: `localhost:${port}` } })).status).toBe(200)
    await close()
  })

  it('refuses pairing from another origin, and a wrong code; codes expire, and a caller that keeps guessing is turned away alone', async () => {
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
    // Ten wrong tries and this caller isn't heard for a while, even with a good code.
    for (let i = 0; i < 9; i++) expect((await pairWith(port, 'AAAA-AAAA')).status).toBe(401)
    const next = await peer.call<{ code: string }>('web.pair', {})
    expect((await pairWith(port, next.code)).status).toBe(429)
    await close()

    const quick = new PairingCodes({ ttl: 30 })
    const soon = quick.issue()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(quick.take(soon.code)).toBe(false)

    // One guesser doesn't spoil anyone else's code.
    const guarded = new PairingCodes({ tries: 3 })
    const kept = guarded.issue()
    for (let i = 0; i < 3; i++) expect(guarded.take('ZZZZ-ZZZZ', '10.0.0.66')).toBe(false)
    expect(guarded.limited('10.0.0.66')).toBe(true)
    expect(guarded.take(kept.code, '10.0.0.66')).toBe(false)
    expect(guarded.take(kept.code, '10.0.0.7')).toBe(true)
  })

  it('tickets run out', async () => {
    const tickets = new Tickets({ ttl: 30 })
    const { ticket } = tickets.issue('t1', undefined, { device: 'd1' })
    expect(tickets.get(ticket)).toMatchObject({ thread: 't1' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(tickets.get(ticket)).toBeUndefined()
  })

  it('revoking a device closes its live socket at once, ends its tickets and forgets its credential, saved at once', async () => {
    const { peer, close } = await open()
    const { port, origin, rpc } = await serveLocal(peer)
    const { code } = await peer.call<{ code: string }>('web.pair', {})
    const credential = credentialOf(await pairWith(port, code))
    const opened = await authed(rpc, { origin }, credential)
    await opened.peer.call('hello', { client: 'web', version: PROTOCOL_VERSION })
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir, title: 'art' })
    await writeFile(join(dir, 'page.html'), '<h1>hi</h1>')
    const ticket = await opened.peer.call<{ path: string }>('artifact.ticket', { thread: thread.id })
    expect((await fetchRaw({ port }, `${ticket.path}page.html`)).status).toBe(200)

    const { value: devices } = (await peer.call<{ value: { sections: { id: string; data: { devices: { id: string; name: string }[] } }[] } }>('settings.watch', {}))
    const device = devices.sections.find((s) => s.id === 'web')!.data.devices[0]!
    expect(device.name).toBe('A browser')
    await peer.call('web.device.rename', { id: device.id, name: 'Kitchen iPad' })
    const clients = await peer.call<{ value: ClientInfo[] }>('clients.watch', {})
    expect(clients.value.find((c) => c.via === 'web')).toMatchObject({ kind: 'web', label: 'Kitchen iPad', device: device.id })

    const started = Date.now()
    await peer.call('web.device.revoke', { id: device.id })
    expect(await readFile(join(dir, 'data', 'web-devices.json'), 'utf8')).not.toContain(device.id)
    expect((await opened.closed).code).toBe(4401)
    expect(Date.now() - started).toBeLessThan(900)
    expect((await fetchRaw({ port }, `${ticket.path}page.html`)).status).toBe(401)
    expect(await turnedAway(rpc, { origin }, credential)).toMatchObject({ code: 4401 })
    await until(async () => !(await peer.call<{ value: ClientInfo[] }>('clients.watch', {})).value.some((c) => c.via === 'web'))
    await close()
  })

  it('through Tailscale: admits the node owner and listed logins by header, on a socket only, and drops them when they leave the list', async () => {
    const { peer, close } = await open({ tailscale: { owner: 'Owner@example.com', dnsName: 'box.tail.ts.net' } })
    // On the TCP listener the headers mean nothing.
    const { port, origin, rpc } = await serveLocal(peer)
    expect(await turnedAway(rpc, { origin, 'tailscale-user-login': 'owner@example.com' })).toMatchObject({ code: 4401 })

    await peer.call('settings.set', { key: 'web.access', value: 'tailscale' })
    const socket = join(dir, 'data', 'web.sock')
    await until(async () => (await fetchRaw({ socket }, '/').catch(() => ({ status: 0 }))).status === 200)
    expect((await fetchRaw({ port }, '/').catch(() => ({ status: 0 }))).status).toBe(0)
    // Nothing to pair here.
    expect((await fetchRaw({ socket }, '/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://box.tail.ts.net:7777' }, body: '{}' })).status).toBe(404)
    await expect(peer.call('web.pair', {})).rejects.toMatchObject({ kind: 'unsupported' })

    const proxied = { origin: `https://box.tail.ts.net:${port}`, 'x-forwarded-host': `box.tail.ts.net:${port}`, 'x-forwarded-proto': 'https' }
    const at = `ws+unix://${socket}:/rpc`
    expect(await openSocket(at, { ...proxied, 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' })).toEqual({ status: 421 })
    expect(await turnedAway(at, proxied)).toMatchObject({ code: 4403 })
    expect(await turnedAway(at, { ...proxied, 'tailscale-user-login': 'stranger@example.com' })).toMatchObject({ code: 4403, reason: 'stranger@example.com isn\'t allowed on this machine.' })
    await peer.call('settings.set', { key: 'web.tailscale.logins', value: 'friend@example.com, other@example.com' })
    const opened = await authed(at, { ...proxied, 'tailscale-user-login': 'friend@example.com', 'tailscale-user-name': '=?utf-8?q?M=C3=B8ller?=' })
    expect(opened.who).toEqual({ via: 'tailscale', name: 'friend@example.com' })
    await opened.peer.call('hello', { client: 'web', version: PROTOCOL_VERSION })
    const { value } = await opened.peer.call<{ value: ClientInfo[] }>('clients.watch', {})
    expect(value.find((c) => c.via === 'tailscale')).toMatchObject({ label: 'friend@example.com', kind: 'web' })
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir, title: 'art' })
    await writeFile(join(dir, 'page.html'), '<h1>hi</h1>')
    const ticket = await opened.peer.call<{ path: string }>('artifact.ticket', { thread: thread.id })
    expect((await fetchRaw({ socket }, `${ticket.path}page.html`, { headers: { 'x-forwarded-host': 'box.tail.ts.net' } })).status).toBe(200)

    const { value: settings } = await peer.call<{ value: { sections: { id: string; data: { tailscale: { command: string; address: string; owner: string } } }[] } }>('settings.watch', {})
    expect(settings.sections.find((s) => s.id === 'web')!.data.tailscale).toMatchObject({
      command: `tailscale serve --bg --https=${port} unix:${socket}`, address: `https://box.tail.ts.net:${port}/`, owner: 'Owner@example.com',
    })

    // Off the list: its socket closes and its tickets end, at once.
    await peer.call('settings.set', { key: 'web.tailscale.logins', value: 'other@example.com' })
    expect(await opened.closed).toMatchObject({ code: 4403 })
    expect((await fetchRaw({ socket }, `${ticket.path}page.html`, { headers: { 'x-forwarded-host': 'box.tail.ts.net' } })).status).toBe(401)

    opened.ws.close()
    await close()
  })

  it('through Tailscale: a login no longer admitted (the node changed owner) is closed when it is next checked', async () => {
    const root = join(dir, 'web')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'index.html'), '<!doctype html>')
    let owner = 'owner@example.com'
    const socket = join(dir, 'web.sock')
    const web = await serveWeb({
      root, at: { socket }, auth: { kind: 'tailscale', admits: async (login) => login === owner }, tailnet: async () => 'box.tail.ts.net',
      serve: (peer) => { peer.handle('hello', () => ({})); return () => {} },
    })
    const proxied = { origin: 'https://box.tail.ts.net', 'x-forwarded-host': 'box.tail.ts.net', 'tailscale-user-login': 'owner@example.com' }
    const opened = await authed(`ws+unix://${socket}:/rpc`, proxied)
    await web.recheck()
    expect(opened.ws.readyState).toBe(opened.ws.OPEN)
    owner = 'someone-else@example.com'
    await web.recheck()
    expect(await opened.closed).toMatchObject({ code: 4403 })
    await web.close()
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
