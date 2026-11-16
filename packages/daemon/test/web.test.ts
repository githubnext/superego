// Web access: paired devices, their cookie on /rpc and /artifact/, Origin and Host checks, rate limits, revocation and
// expiry; the migration from the single token and from the local network; and Tailscale serve's identity, trusted only
// through serve (a stub `tailscale` on PATH stands in for the real one).
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineApp, PROTOCOL_VERSION, type Hello, type SettingsSnapshot } from '@superego/protocol'
import { MemorySettingsStore } from '@superego/settings'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { serveWeb, type ServedByTailscale, type WebServer } from '../src/web.ts'
import { DEVICE_TTL, FAILURES, TICKET_TTL, WebDevices, deviceName } from '../src/web-devices.ts'
import { until } from './until.ts'

type Client = { on(event: string, listener: (...args: unknown[]) => void): void; send(data: string): void; close(): void; readyState: number }
const { WebSocket: WsClient } = await import('ws') as unknown as { WebSocket: new (url: string, options: { headers: Record<string, string> }) => Client }

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-web-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string }
/** A raw HTTP request: the Host, Origin and Cookie headers as given (fetch won't let a test set Host). */
function http(port: number, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
const cookieFrom = (response: Response) => String(response.headers['set-cookie'] ?? '').split(';')[0]!
const pairWith = (port: number, given: object, headers: Record<string, string> = {}) =>
  http(port, '/pair', { method: 'POST', body: JSON.stringify(given), headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', ...headers } })

/** A WebSocket to /rpc: 'open' (then closed by the test or the server), or the status it was refused with. */
function socket(port: number, headers: Record<string, string>, { path = '/rpc', keep = false } = {}): Promise<{ result: string; ws: Client; closed: Promise<void> }> {
  return new Promise((resolve) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, { headers: { origin: `http://127.0.0.1:${port}`, ...headers } })
    const closed = new Promise<void>((done) => ws.on('close', () => done()))
    ws.on('open', () => { if (!keep) ws.close(); resolve({ result: 'open', ws, closed }) })
    ws.on('unexpected-response', (_req, res) => resolve({ result: String((res as { statusCode: number }).statusCode), ws, closed }))
    ws.on('error', () => resolve({ result: 'error', ws, closed }))
  })
}

describe('devices', () => {
  it('pairs once with a ticket or its code, for five minutes', async () => {
    let now = 1_000_000
    const devices = await WebDevices.open(dir, { now: () => now })
    const first = devices.pair()
    expect(first.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const paired = await devices.redeem({ ticket: first.ticket }, { address: '1.2.3.4', agent: 'Mozilla/5.0 (iPhone) Safari/604.1' })
    expect(paired?.device).toMatchObject({ name: 'Safari on iPhone', address: '1.2.3.4' })
    // Spent: neither the link nor the code works again.
    expect(await devices.redeem({ ticket: first.ticket }, { address: '1.2.3.4' })).toBeUndefined()
    expect(await devices.redeem({ code: first.code }, { address: '1.2.3.4' })).toBeUndefined()
    // A code, typed loosely.
    const second = devices.pair()
    expect(await devices.redeem({ code: second.code.toLowerCase().replace('-', ' ') }, { address: 'x' })).toBeDefined()
    // Expired.
    const third = devices.pair()
    now += TICKET_TTL + 1
    expect(await devices.redeem({ ticket: third.ticket }, { address: 'x' })).toBeUndefined()
    // The secret is kept hashed.
    const stored = await readFile(join(dir, 'web.json'), 'utf8')
    expect(stored).not.toContain(paired!.cookie.split('.')[1])
    expect(devices.check(paired!.cookie, '1.2.3.4')?.id).toBe(paired!.device.id)
    expect(devices.check(`${paired!.device.id}.wrong`, '1.2.3.4')).toBeUndefined()
    await devices.saved()
  })

  it('forgets a device unused for 90 days, and says so to whoever holds its connections', async () => {
    let now = 1_000_000
    const devices = new WebDevices(dir, { now: () => now })
    const { cookie, device } = (await devices.redeem({ ticket: devices.pair().ticket }, { address: 'a' }))!
    const gone: string[] = []
    devices.onRevoke((id) => gone.push(id))
    now += DEVICE_TTL - 1000
    expect(devices.check(cookie, 'a')).toBeDefined()
    now += DEVICE_TTL + 1
    expect(devices.check(cookie, 'a')).toBeUndefined()
    expect(devices.list()).toEqual([])
    expect(gone).toEqual([device.id])
    // Forgotten on disk too, before the folder goes.
    await devices.saved()
  })

  it('names a device from its browser', () => {
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on Mac')
    expect(deviceName('')).toBe('A browser')
  })
})

describe('the web server', () => {
  let web: WebServer
  let devices: WebDevices
  let ts: ServedByTailscale | undefined
  let served: number
  beforeEach(async () => {
    const root = join(dir, 'root')
    await mkdir(root)
    await writeFile(join(root, 'index.html'), '<h1>app</h1>')
    devices = new WebDevices(dir)
    ts = undefined
    served = 0
    web = await serveWeb({
      root, port: 0, devices, tailscale: () => ts,
      serve: () => { served++; return () => {} },
      artifact: async (thread, path) => Buffer.from(`${thread}/${path}`),
    })
  })
  afterEach(async () => { await web.close(); await devices.saved() })
  const paired = async () => cookieFrom(await pairWith(web.port, { ticket: devices.pair().ticket }))

  it('pairs a browser with a cookie, and lets it in by that alone', async () => {
    const response = await pairWith(web.port, { ticket: devices.pair().ticket })
    expect(response.status).toBe(200)
    const set = String(response.headers['set-cookie'])
    expect(set).toMatch(/^superego-device=[^;]+; Path=\/; HttpOnly; SameSite=Strict/)
    expect(set).not.toContain('Secure')
    const cookie = cookieFrom(response)
    expect((await http(web.port, '/rpc')).status).toBe(401)
    expect((await http(web.port, '/rpc', { headers: { cookie } })).status).toBe(204)
    expect((await http(web.port, '/artifact/t1/page.html')).status).toBe(401)
    // An artifact's page is sent on to an address of its own, which its (cookieless, sandboxed) files come from too.
    const sent = await http(web.port, '/artifact/t1/page.html', { headers: { cookie } })
    expect(sent.status).toBe(302)
    const at = String(sent.headers.location)
    expect(at).toMatch(/^\/artifact\/~[\w-]+\.[\w-]+\/t1\/page\.html$/)
    const artifact = await http(web.port, at)
    expect(artifact).toMatchObject({ status: 200, body: 't1/page.html' })
    expect(String(artifact.headers['content-security-policy'])).toContain('sandbox')
    expect(await http(web.port, at.replace('page.html', 'img/dot.svg'))).toMatchObject({ status: 200, body: 't1/img/dot.svg' })
    // Not another thread's, and not forged.
    expect((await http(web.port, at.replace('/t1/', '/t2/'))).status).toBe(401)
    expect((await http(web.port, at.replace(/\.[\w-]+\//, '.AAAAAAAAAAAAAAAAAAAAAAAA/'))).status).toBe(401)
    expect((await socket(web.port, {})).result).toBe('401')
    expect((await socket(web.port, { cookie })).result).toBe('open')
    // The old token in the address is nothing now.
    expect((await socket(web.port, {}, { path: '/rpc?token=anything' })).result).toBe('401')
  })

  it('refuses a ticket twice, and a pairing from another origin', async () => {
    const { ticket } = devices.pair()
    expect((await pairWith(web.port, { ticket })).status).toBe(200)
    expect((await pairWith(web.port, { ticket })).status).toBe(401)
    expect((await pairWith(web.port, { ticket: devices.pair().ticket }, { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('refuses a WebSocket from another origin, and any request for a host it isn’t served at', async () => {
    const cookie = await paired()
    expect((await socket(web.port, { cookie, origin: 'https://evil.example' })).result).toBe('403')
    expect((await socket(web.port, { cookie, origin: `http://localhost:${web.port}` })).result).toBe('403')
    // DNS rebinding: a page at evil.example resolving to 127.0.0.1.
    expect((await http(web.port, '/', { headers: { host: `evil.example:${web.port}` } })).status).toBe(403)
    expect((await socket(web.port, { cookie, host: `evil.example:${web.port}`, origin: `http://evil.example:${web.port}` })).result).toBe('403')
    expect((await http(web.port, '/', { headers: { host: `localhost:${web.port}` } })).status).toBe(200)
    expect((await http(web.port, '/', { headers: { host: `[::1]:${web.port}` } })).status).toBe(200)
  })

  it('stops hearing an address after too many misses', async () => {
    const cookie = await paired()
    for (let i = 0; i < FAILURES; i++) expect((await pairWith(web.port, { code: 'AAAA-AAAA' })).status).toBe(401)
    expect((await pairWith(web.port, { ticket: devices.pair().ticket })).status).toBe(429)
    expect((await http(web.port, '/rpc', { headers: { cookie } })).status).toBe(429)
    expect((await socket(web.port, { cookie })).result).toBe('429')
  })

  it('counts a wrong cookie as a miss, and clears it', async () => {
    const response = await http(web.port, '/rpc', { headers: { cookie: 'superego-device=nope.nope' } })
    expect(response.status).toBe(401)
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0')
    for (let i = 1; i < FAILURES; i++) await http(web.port, '/rpc', { headers: { cookie: 'superego-device=nope.nope' } })
    expect((await http(web.port, '/rpc', { headers: { cookie: 'superego-device=nope.nope' } })).status).toBe(429)
  })

  it('closes a revoked device’s live connections at once', async () => {
    const cookie = await paired()
    const other = await paired()
    const live = await socket(web.port, { cookie }, { keep: true })
    const stays = await socket(web.port, { cookie: other }, { keep: true })
    expect(live.result).toBe('open')
    const [device] = devices.list().filter((d) => cookie.endsWith(d.id) || cookie.includes(`=${d.id}.`))
    const artifact = String((await http(web.port, '/artifact/t1/a.html', { headers: { cookie } })).headers.location)
    expect((await http(web.port, artifact)).status).toBe(200)
    await devices.revoke(device!.id)
    await live.closed
    expect((await http(web.port, artifact)).status).toBe(401)
    expect(stays.ws.readyState).toBe(1)
    expect((await http(web.port, '/rpc', { headers: { cookie } })).status).toBe(401)
    stays.ws.close()
  })

  describe('through Tailscale serve', () => {
    const name = 'box.tail1234.ts.net'
    const through = (headers: Record<string, string> = {}) => ({ host: name, 'x-forwarded-for': '100.64.0.7', 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@example.com', 'tailscale-user-name': 'Me', ...headers })
    beforeEach(() => { ts = { prefix: '.tailscale-secret', name, owner: 'me@example.com', pairOwner: false, nodeAt: async () => 'phone' } })

    it('lets the owner in without pairing, as one of their devices', async () => {
      expect((await http(web.port, '/.tailscale-secret/rpc', { headers: through() })).status).toBe(204)
      expect((await socket(web.port, { ...through(), origin: `https://${name}` }, { path: '/.tailscale-secret/rpc' })).result).toBe('open')
      expect(devices.list()).toMatchObject([{ id: 'tailscale:phone', name: 'phone', address: '100.64.0.7', tailscale: true }])
      // The page itself, and the Host serve passes on.
      expect((await http(web.port, '/.tailscale-secret/', { headers: through() })).body).toBe('<h1>app</h1>')
    })

    it('trusts the headers only under serve’s prefix', async () => {
      // A plain loopback client forging serve's headers is "this computer": it must pair.
      expect((await http(web.port, '/rpc', { headers: through() })).status).toBe(401)
      expect((await socket(web.port, { ...through(), origin: `https://${name}` })).result).toBe('403')
      expect((await socket(web.port, { ...through(), origin: `http://${name}` })).result).toBe('401')
      // Tailscale mode off: the prefix is nothing.
      ts = undefined
      expect((await http(web.port, '/.tailscale-secret/rpc', { headers: through() })).status).toBe(403)
      // …just a path, the app's page's.
      expect((await http(web.port, '/.tailscale-secret/rpc', { headers: through({ host: `127.0.0.1:${web.port}` }) })).body).toBe('<h1>app</h1>')
      expect((await http(web.port, '/rpc', { headers: through({ host: `127.0.0.1:${web.port}` }) })).status).toBe(401)
    })

    it('asks other tailnet users, and the owner when told to, to pair; with a Secure cookie', async () => {
      expect((await http(web.port, '/.tailscale-secret/rpc', { headers: through({ 'tailscale-user-login': 'friend@example.com' }) })).status).toBe(401)
      expect((await http(web.port, '/.tailscale-secret/rpc', { headers: through({ 'tailscale-user-login': '' }) })).status).toBe(401)
      ts!.pairOwner = true
      expect((await http(web.port, '/.tailscale-secret/rpc', { headers: through() })).status).toBe(401)
      const response = await http(web.port, '/.tailscale-secret/pair', { method: 'POST', body: JSON.stringify({ ticket: devices.pair().ticket }), headers: { ...through(), origin: `https://${name}` } })
      expect(response.status).toBe(200)
      expect(String(response.headers['set-cookie'])).toContain('; Secure')
      expect((await http(web.port, '/.tailscale-secret/rpc', { headers: { ...through(), cookie: cookieFrom(response) } })).status).toBe(204)
      expect(devices.list()).toMatchObject([{ address: '100.64.0.7' }])
    })
  })
})

describe('the daemon’s web access', () => {
  const app = defineApp({ name: 'superego', id: 'superego' })
  const open = async (values: Record<string, never> = {}) => {
    process.env.SUPEREGO_MODEL = 'faux'
    const root = join(dir, 'root')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'index.html'), '<h1>app</h1>')
    const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), webRoot: root, settingsStore: new MemorySettingsStore(values) })
    const server = await listen(daemon, join(dir, 'superego.sock'))
    const { peer, socket: sock } = await connectSocket(join(dir, 'superego.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    const section = async () => (await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})).value.sections.find((s) => s.id === 'web')!
    return { daemon, peer, section, close: async () => { sock.destroy(); await new Promise((resolve) => server.close(resolve)); await daemon.close() } }
  }
  it('pairs a device, lets it speak the protocol, lists, renames and revokes it', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const { peer, section, close } = await open({ 'web.access': 'local' as never, 'web.port': port as never })
    await until(async () => Boolean((await section()).data))
    const { link, code } = await peer.call<{ link: string; code: string }>('web.pair', {})
    expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=[\\w-]+$`))
    expect(code).toMatch(/^\w{4}-\w{4}$/)
    const cookie = cookieFrom(await pairWith(port, { code }))
    const live = await socket(port, { cookie }, { keep: true })
    expect(live.result).toBe('open')
    const reply = new Promise<Hello>((resolve) => live.ws.on('message', (data) => resolve((JSON.parse(String(data)) as { result: Hello }).result)))
    live.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { client: 'web', version: PROTOCOL_VERSION } }))
    expect((await reply).version).toBe(PROTOCOL_VERSION)
    const [device] = await peer.call<{ id: string; name: string }[]>('web.devices', {})
    expect(device!.name).toBe('Safari on iPhone')
    await peer.call('web.rename', { id: device!.id, name: 'My phone' })
    expect(((await section()).data as { devices: { name: string }[] }).devices[0]!.name).toBe('My phone')
    await peer.call('web.revoke', { id: device!.id })
    await live.closed
    expect(await peer.call('web.devices', {})).toEqual([])
    await close()
  })

  it('refuses to pair while web access is off', async () => {
    const { peer, close } = await open()
    await expect(peer.call('web.pair', {})).rejects.toMatchObject({ kind: 'web_off' })
    await close()
  })

  describe('over Tailscale (a stub tailscale on PATH)', () => {
    let path: string | undefined
    let log: string
    const stub = async (status: object) => {
      const bin = join(dir, 'bin')
      await mkdir(bin, { recursive: true })
      log = join(dir, 'tailscale.log')
      await writeFile(join(dir, 'status.json'), JSON.stringify(status))
      await writeFile(join(dir, 'serve.json'), '{}')
      // `status --json`, `serve status --json`, `serve --bg … <target>` (kept in serve.json), `serve --https=443 off`.
      await writeFile(join(bin, 'tailscale'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
case "$1 $2" in
  "status --json") cat ${JSON.stringify(join(dir, 'status.json'))} ;;
  "serve status") cat ${JSON.stringify(join(dir, 'serve.json'))} ;;
  *) for last; do :; done
     if [ "$last" = off ]; then echo '{}' > ${JSON.stringify(join(dir, 'serve.json'))}
     else printf '{"Web":{"box.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$last" > ${JSON.stringify(join(dir, 'serve.json'))}; fi ;;
esac
`)
      await chmod(join(bin, 'tailscale'), 0o755)
      path = process.env.PATH
      process.env.PATH = `${bin}:${path}`
    }
    afterEach(() => { if (path !== undefined) process.env.PATH = path; path = undefined })
    const running = {
      BackendState: 'Running', CertDomains: ['box.tail1234.ts.net'],
      Self: { DNSName: 'box.tail1234.ts.net.', HostName: 'box', UserID: 1, TailscaleIPs: ['100.64.0.1'] },
      Peer: { k: { HostName: 'phone', TailscaleIPs: ['100.64.0.7'] } },
      User: { 1: { LoginName: 'me@example.com' } },
    }

    it('sets serve up, admits the owner through it, and takes it down when switched off', async () => {
      await stub(running)
      const port = 20000 + Math.floor(Math.random() * 20000)
      const { peer, section, close } = await open({ 'web.access': 'tailscale' as never, 'web.port': port as never })
      await until(async () => ((await section()).data as { tailscale?: { state: string } }).tailscale?.state === 'serving')
      expect((await section()).data).toMatchObject({ url: 'https://box.tail1234.ts.net', tailscale: { state: 'serving', owner: 'me@example.com' } })
      const proxy = (JSON.parse(await readFile(join(dir, 'serve.json'), 'utf8')) as { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> }).Web['box.tail1234.ts.net:443']!.Handlers['/']!.Proxy
      expect(proxy).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\.tailscale-[\\w-]+$`))
      const prefix = new URL(proxy).pathname
      const headers = { host: 'box.tail1234.ts.net', 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': 'me@example.com' }
      expect((await http(port, `${prefix}/rpc`, { headers })).status).toBe(204)
      expect((await http(port, '/rpc', { headers })).status).toBe(401)
      const owner = await socket(port, { ...headers, origin: 'https://box.tail1234.ts.net' }, { path: `${prefix}/rpc`, keep: true })
      expect(owner.result).toBe('open')
      expect(await peer.call('web.devices', {})).toMatchObject([{ id: 'tailscale:phone', tailscale: true }])
      await expect(peer.call('web.revoke', { id: 'tailscale:phone' })).rejects.toMatchObject({ kind: 'invalid' })
      expect((await peer.call<{ link: string }>('web.pair', {})).link).toMatch(/^https:\/\/box\.tail1234\.ts\.net\/#pair=/)
      // Require pairing for the owner too: their live connections close.
      await peer.call('settings.set', { key: 'web.tailscale.pairing', value: true })
      await owner.closed
      expect((await http(port, `${prefix}/rpc`, { headers })).status).toBe(401)
      expect(await peer.call('web.devices', {})).toEqual([])
      await peer.call('settings.set', { key: 'web.access', value: 'off' })
      // Taken down: the stub logs the command before it has done it.
      await until(async () => (await readFile(join(dir, 'serve.json'), 'utf8')).trim() === '{}')
      expect(await readFile(log, 'utf8')).toContain('serve --https=443 off')
      expect(await readFile(join(dir, 'serve.json'), 'utf8')).toContain('{}')
      await close()
    })

    it('says what keeps Tailscale from serving', async () => {
      const port = 20000 + Math.floor(Math.random() * 20000)
      for (const [status, state] of [[{ ...running, BackendState: 'NeedsLogin' }, 'logged-out'], [{ ...running, CertDomains: null }, 'no-https']] as const) {
        await stub(status)
        const { section, close } = await open({ 'web.access': 'tailscale' as never, 'web.port': port as never })
        await until(async () => ((await section()).data as { tailscale?: { state: string } }).tailscale?.state === state)
        expect((await section()).data).toMatchObject({ tailscale: { state } })
        expect(await readFile(log, 'utf8')).not.toContain('--bg')
        await close()
        process.env.PATH = path!
      }
      // Not installed at all.
      const saved = process.env.PATH
      process.env.PATH = join(dir, 'nowhere')
      const { section, close } = await open({ 'web.access': 'tailscale' as never, 'web.port': port as never })
      await until(async () => ((await section()).data as { tailscale?: { state: string } }).tailscale?.state === 'missing')
      expect((await section()).data).toMatchObject({ tailscale: { state: 'missing' } })
      await close()
      process.env.PATH = saved
    })

    it('leaves someone else’s serve alone', async () => {
      await stub(running)
      await writeFile(join(dir, 'serve.json'), JSON.stringify({ Web: { 'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }))
      const port = 20000 + Math.floor(Math.random() * 20000)
      const { section, close } = await open({ 'web.access': 'tailscale' as never, 'web.port': port as never })
      await until(async () => ((await section()).data as { tailscale?: { state: string } }).tailscale?.state === 'busy')
      expect((await section()).data).toMatchObject({ tailscale: { state: 'busy', message: expect.stringContaining('3000') } })
      await close()
    })
  })
})
