// Web access: paired devices, their cookie on /rpc and /artifact/, Origin and Host checks, rate limits, revocation and
// expiry; artifact grants, held to whom and where they were given; malformed requests, answered and survived; and
// Tailscale serve's identity, trusted only on the socket serve proxies to (a stub `tailscale` on PATH stands in for the
// real one).
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineApp, PROTOCOL_VERSION, RpcError, type Hello, type SettingsSnapshot } from '@superego/protocol'
import { MemorySettingsStore } from '@superego/settings'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { GRANT_IDLE, serveWeb, webOrigin, type ServedByTailscale, type WebServer } from '../src/web.ts'
import { otherInstances } from '../src/tailscale.ts'
import { DEVICE_TTL, FAILURES, TICKET_TTL, WebDevices, deviceName } from '../src/web-devices.ts'
import { until } from './until.ts'

type Client = { on(event: string, listener: (...args: unknown[]) => void): void; send(data: string): void; close(): void; readyState: number }
const { WebSocket: WsClient } = await import('ws') as unknown as { WebSocket: new (url: string, options: { headers: Record<string, string> }) => Client }

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-web-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string }
/**
 * A raw HTTP request: the Host, Origin and Cookie headers as given (fetch won't let a test set Host). To loopback's
 * port, or (a path) to a Unix socket, as Tailscale serve sends one there: to `localhost`, the host asked for in
 * X-Forwarded-Host.
 */
function http(at: number | string, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const where = typeof at === 'number' ? { host: '127.0.0.1', port: at } : { socketPath: at }
    const req = httpRequest({ ...where, path, method, headers: { host: typeof at === 'number' ? `127.0.0.1:${at}` : 'localhost', ...headers } }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
/** A request as written, byte for byte (what a client library won't send: `GET //`), and the answer's status line. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(text))
    let answer = ''
    sock.on('data', (chunk) => { answer += chunk; if (answer.includes('\r\n')) { resolve(answer.split('\r\n')[0]!); sock.destroy() } })
    sock.on('end', () => resolve(answer.split('\r\n')[0]!))
    sock.on('error', reject)
  })
}
const cookieFrom = (response: Response) => String(response.headers['set-cookie'] ?? '').split(';')[0]!
const pairWith = (port: number, given: object, headers: Record<string, string> = {}) =>
  http(port, '/pair', { method: 'POST', body: JSON.stringify(given), headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', ...headers } })

/** A WebSocket to /rpc: 'open' (then closed by the test or the server), or the status it was refused with. */
function socket(at: number | string, headers: Record<string, string>, { path = '/rpc', keep = false } = {}): Promise<{ result: string; ws: Client; closed: Promise<void> }> {
  return new Promise((resolve) => {
    const url = typeof at === 'number' ? `ws://127.0.0.1:${at}${path}` : `ws+unix://${at}:${path}`
    const ws = new WsClient(url, { headers: { origin: `http://127.0.0.1:${at}`, ...headers } })
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

/** The socket Tailscale serve proxies to, in the test's folder. */
const viaServe = () => join(dir, 'web', 'tailscale.sock')

describe('the web server', () => {
  let web: WebServer
  let devices: WebDevices
  let ts: ServedByTailscale | undefined
  let chosen: string | undefined
  let served: number
  beforeEach(async () => {
    const root = join(dir, 'root')
    await mkdir(root)
    await writeFile(join(root, 'index.html'), '<h1>app</h1>')
    devices = new WebDevices(dir)
    ts = undefined
    chosen = undefined
    served = 0
    web = await serveWeb({
      root, port: 0, devices, tailscale: () => ts, origin: () => chosen,
      serve: () => { served++; return () => {} },
      serveSocket: viaServe(),
      artifact: async (thread, path) => {
        if (path === 'escape.html') throw new RpcError('forbidden', "escape.html leads outside the thread's folder")
        return Buffer.from(`${thread}/${path}`)
      },
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
    expect(at).toMatch(/^\/artifact\/~[\w-]+\/t1\/page\.html$/)
    const artifact = await http(web.port, at)
    expect(artifact).toMatchObject({ status: 200, body: 't1/page.html' })
    expect(String(artifact.headers['content-security-policy'])).toContain('sandbox')
    expect(await http(web.port, at.replace('page.html', 'img/dot.svg'))).toMatchObject({ status: 200, body: 't1/img/dot.svg' })
    // Not another thread's, and not forged.
    expect((await http(web.port, at.replace('/t1/', '/t2/'))).status).toBe(401)
    expect((await http(web.port, at.replace(/~[\w-]+\//, '~AAAAAAAAAAAAAAAAAAAAAAAA/'))).status).toBe(401)
    // The page's own request again: the same grant.
    expect((await http(web.port, '/artifact/t1/other.html', { headers: { cookie } })).headers.location).toBe(at.replace('page.html', 'other.html'))
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

  it('answers malformed requests, and survives whatever a request throws', async () => {
    const unhandled: unknown[] = []
    const note = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', note)
    try {
      const cookie = await paired()
      for (const path of ['//', '/%', '/%E0%A4%A', '/artifact/%/x.html', '/rpc/%']) {
        expect(await raw(web.port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`), path).toMatch(/^HTTP\/1\.1 (400|200|401)/)
      }
      expect(await raw(web.port, 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')).toBe('HTTP/1.1 200 OK')
      expect(await raw(web.port, 'GET /% HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')).toBe('HTTP/1.1 400 Bad Request')
      expect(await raw(web.port, 'OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')).toBe('HTTP/1.1 400 Bad Request')
      expect(await raw(web.port, 'GET http://127.0.0.1/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')).toBe('HTTP/1.1 400 Bad Request')
      // Upgrades too, by the same rules.
      for (const path of ['//', '/%', '/%/rpc']) {
        expect(await raw(web.port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`), path).toMatch(/^HTTP\/1\.1 40\d/)
      }
      // A cookie that doesn't decode is a wrong one; a pairing whose body is no object, a failed one.
      expect((await http(web.port, '/rpc', { headers: { cookie: 'superego-device=%' } })).status).toBe(401)
      for (const body of ['null', '1', '"x"', '[]', '{']) expect((await http(web.port, '/pair', { method: 'POST', body, headers: { origin: `http://127.0.0.1:${web.port}` } })).status, body).toBe(401)
      // A thread's address that doesn't decode.
      expect((await http(web.port, '/artifact/%zz/page.html', { headers: { cookie } })).status).toBe(400)
      // Still serving.
      expect((await http(web.port, '/rpc', { headers: { cookie } })).status).toBe(204)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', note)
    }
  })

  it('answers 500 for a request that fails inside, and says why in the log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    ts = { name: 'box.tail1234.ts.net', owner: 'me@example.com', pairOwner: false, nodeAt: async () => { throw new Error('tailscale went away') } }
    const headers = { 'x-forwarded-host': 'box.tail1234.ts.net', 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': 'me@example.com' }
    expect((await http(viaServe(), '/rpc', { headers })).status).toBe(500)
    expect((await socket(viaServe(), { ...headers, host: 'localhost', 'x-forwarded-host': 'box.tail1234.ts.net', origin: 'https://box.tail1234.ts.net' })).result).toBe('500')
    expect(errors.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain('tailscale went away')
    errors.mockRestore()
    // Still serving.
    expect((await http(web.port, '/')).status).toBe(200)
  })

  it('refuses what an artifact may not have, and lets a grant on loopback lapse once its page stops using it', async () => {
    const cookie = await paired()
    const at = String((await http(web.port, '/artifact/t1/page.html', { headers: { cookie } })).headers.location)
    expect((await http(web.port, at.replace('page.html', 'escape.html'))).status).toBe(403)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      vi.advanceTimersByTime(GRANT_IDLE - 1000)
      expect((await http(web.port, at)).status).toBe(200)
      vi.advanceTimersByTime(GRANT_IDLE - 1000)
      expect((await http(web.port, at)).status).toBe(200)
      vi.advanceTimersByTime(GRANT_IDLE + 1)
      expect((await http(web.port, at)).status).toBe(401)
      // The page's own request, with the cookie, grants again.
      const again = String((await http(web.port, '/artifact/t1/page.html', { headers: { cookie } })).headers.location)
      expect(again).not.toBe(at)
      expect((await http(web.port, again)).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is served at the host chosen for it too, from that origin, and still only to paired devices', async () => {
    const host = 'workbox.tail1ffbc8.ts.net'
    expect((await http(web.port, '/', { headers: { host } })).status).toBe(403)
    chosen = `https://${host}`
    expect((await http(web.port, '/', { headers: { host } })).body).toBe('<h1>app</h1>')
    expect((await http(web.port, '/', { headers: { host: `${host}:443` } })).status).toBe(200)
    expect((await http(web.port, '/', { headers: { host: `${host}:8443` } })).status).toBe(403)
    // A proxy of the user's own is no Tailscale serve of the daemon's: its identity headers count for nothing.
    expect((await http(web.port, '/rpc', { headers: { host, 'tailscale-user-login': 'me@example.com' } })).status).toBe(401)
    const response = await pairWith(web.port, { ticket: devices.pair().ticket }, { host, origin: `https://${host}` })
    expect(response.status).toBe(200)
    expect(String(response.headers['set-cookie'])).toContain('; Secure')
    const cookie = cookieFrom(response)
    expect((await socket(web.port, { cookie, host, origin: `https://${host}` })).result).toBe('open')
    expect((await socket(web.port, { cookie, host, origin: `http://${host}` })).result).toBe('403')
    expect((await pairWith(web.port, { ticket: devices.pair().ticket }, { host, origin: `http://${host}` })).status).toBe(403)
    // Loopback's names still are.
    expect((await socket(web.port, { cookie })).result).toBe('open')
  })

  it('takes a hostname, or an origin, for the host', () => {
    expect(webOrigin('')).toBeUndefined()
    expect(webOrigin('  ')).toBeUndefined()
    expect(webOrigin('workbox.tail1ffbc8.ts.net')).toBe('https://workbox.tail1ffbc8.ts.net')
    expect(webOrigin('Box.LAN:8443')).toBe('https://box.lan:8443')
    expect(webOrigin('http://box.lan:7777/')).toBe('http://box.lan:7777')
    expect(webOrigin('https://box.lan:443')).toBe('https://box.lan')
    expect(webOrigin('100.103.115.1')).toBe('https://100.103.115.1')
    for (const bad of ['ftp://box.lan', 'https://box.lan/path', 'box.lan?x=1', 'https://me:pw@box.lan', 'box_lan', 'has space.lan', 'box.lan:99999', '-box.lan', 'https://']) {
      expect(() => webOrigin(bad), bad).toThrow()
    }
  })

  describe('through Tailscale serve', () => {
    const name = 'box.tail1234.ts.net'
    const through = (headers: Record<string, string> = {}) => ({ host: 'localhost', 'x-forwarded-host': name, 'x-forwarded-for': '100.64.0.7', 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@example.com', 'tailscale-user-name': 'Me', ...headers })
    beforeEach(() => { ts = { name, owner: 'me@example.com', pairOwner: false, nodeAt: async () => 'phone' } })

    it('lets the owner in without pairing, as one of their devices', async () => {
      expect((await http(viaServe(), '/rpc', { headers: through() })).status).toBe(204)
      expect((await socket(viaServe(), { ...through(), origin: `https://${name}` })).result).toBe('open')
      expect(devices.list()).toMatchObject([{ id: 'tailscale:phone', name: 'phone', address: '100.64.0.7', tailscale: true }])
      // The page itself, and the Host serve passes on.
      expect((await http(viaServe(), '/', { headers: through() })).body).toBe('<h1>app</h1>')
    })

    it('listens where only this user (and tailscaled, as root) can connect', async () => {
      expect((await stat(viaServe())).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir, 'web'))).mode & 0o777).toBe(0o700)
    })

    it('trusts the headers only on serve’s socket: on loopback’s port, anyone on the computer could send them', async () => {
      // A loopback client forging serve's headers is "this computer": it must pair, whatever path or host it names.
      expect((await http(web.port, '/rpc', { headers: through({ host: name }) })).status).toBe(403)
      expect((await http(web.port, '/rpc', { headers: through() })).status).toBe(401)
      expect((await http(web.port, '/rpc', { headers: through({ host: `127.0.0.1:${web.port}` }) })).status).toBe(401)
      expect((await socket(web.port, { ...through({ host: name }), origin: `https://${name}` })).result).toBe('403')
      expect((await socket(web.port, { ...through(), origin: `https://${name}` })).result).toBe('403')
      expect((await socket(web.port, { ...through({ host: `127.0.0.1:${web.port}` }) })).result).toBe('401')
      // On serve's socket, the host is the one serve says the browser asked for.
      expect((await http(viaServe(), '/rpc', { headers: through({ 'x-forwarded-host': 'evil.example' }) })).status).toBe(403)
      // What was serve's secret path is just a path now, the app's page's.
      expect((await http(web.port, '/.tailscale-secret/rpc', { headers: through({ host: `127.0.0.1:${web.port}` }) })).body).toBe('<h1>app</h1>')
      // Serve's socket, while Tailscale doesn't serve: nothing to believe.
      ts = undefined
      expect((await http(viaServe(), '/rpc', { headers: through() })).status).toBe(403)
    })

    it('asks other tailnet users, and the owner when told to, to pair; with a Secure cookie', async () => {
      expect((await http(viaServe(), '/rpc', { headers: through({ 'tailscale-user-login': 'friend@example.com' }) })).status).toBe(401)
      expect((await http(viaServe(), '/rpc', { headers: through({ 'tailscale-user-login': '' }) })).status).toBe(401)
      ts!.pairOwner = true
      expect((await http(viaServe(), '/rpc', { headers: through() })).status).toBe(401)
      const response = await http(viaServe(), '/pair', { method: 'POST', body: JSON.stringify({ ticket: devices.pair().ticket }), headers: { ...through(), origin: `https://${name}` } })
      expect(response.status).toBe(200)
      expect(String(response.headers['set-cookie'])).toContain('; Secure')
      expect((await http(viaServe(), '/rpc', { headers: { ...through(), cookie: cookieFrom(response) } })).status).toBe(204)
      expect(devices.list()).toMatchObject([{ address: '100.64.0.7' }])
    })

    it('holds an artifact grant to the tailnet device it was given to', async () => {
      // A paired device's: its page's files from that device alone, not another of the tailnet's, nor loopback.
      const friend = through({ 'tailscale-user-login': 'friend@example.com' })
      const cookie = cookieFrom(await http(viaServe(), '/pair', { method: 'POST', body: JSON.stringify({ ticket: devices.pair().ticket }), headers: { ...friend, origin: `https://${name}` } }))
      const at = String((await http(viaServe(), '/artifact/t1/page.html', { headers: { ...friend, cookie } })).headers.location)
      expect(await http(viaServe(), at, { headers: friend })).toMatchObject({ status: 200, body: 't1/page.html' })
      expect((await http(viaServe(), at, { headers: { ...friend, 'x-forwarded-for': '100.64.0.9' } })).status).toBe(401)
      expect((await http(viaServe(), at, { headers: { ...friend, 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'me@example.com' } })).status).toBe(401)
      expect((await http(web.port, at)).status).toBe(401)
      // Through serve it doesn't lapse: it's held to the device instead.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * GRANT_IDLE })
      try { expect((await http(viaServe(), at, { headers: friend })).status).toBe(200) } finally { vi.useRealTimers() }
      // The owner's: from their device, with their login, while they get in without pairing.
      const own = String((await http(viaServe(), '/artifact/t1/page.html', { headers: through() })).headers.location)
      expect((await http(viaServe(), own, { headers: through() })).status).toBe(200)
      expect((await http(viaServe(), own, { headers: through({ 'x-forwarded-for': '100.64.0.9' }) })).status).toBe(401)
      expect((await http(viaServe(), own, { headers: through({ 'tailscale-user-login': 'friend@example.com' }) })).status).toBe(401)
      ts!.pairOwner = true
      expect((await http(viaServe(), own, { headers: through() })).status).toBe(401)
    })
  })
})

describe('other tailscaleds', () => {
  it('are found by their sockets, but for the default one', async () => {
    // A socket's path must be short (104 bytes on macOS): not in the long per-user temp dir.
    const short = await mkdtemp('/tmp/se-')
    const run = join(short, 'run')
    const listening = []
    for (const name of ['tailscale', 'tailscale-personal', 'tailscale-empty', 'other']) {
      await mkdir(join(run, name), { recursive: true })
      if (name === 'tailscale-empty') continue
      const server = createNetServer()
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(join(run, name, 'tailscaled.sock'), resolve))
      listening.push(server)
    }
    expect(otherInstances([run, join(dir, 'nowhere')]).map((s) => s.slice(s.indexOf('/run/')))).toEqual(['/run/tailscale-personal/tailscaled.sock'])
    for (const server of listening) server.close()
    await rm(short, { recursive: true, force: true })
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

  it('pairs at the host chosen for it, and refuses a host that isn’t one, or one set from an agent’s shell', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const { peer, section, close } = await open({ 'web.access': 'local' as never, 'web.port': port as never })
    await until(async () => Boolean((await section()).data))
    expect((await http(port, '/', { headers: { host: 'box.lan:7000' } })).status).toBe(403)
    await peer.call('settings.set', { key: 'web.host', value: 'http://box.lan:7000' })
    expect((await peer.call<{ link: string }>('web.pair', {})).link).toMatch(/^http:\/\/box\.lan:7000\/#pair=[\w-]+$/)
    expect((await section()).data).toMatchObject({ url: 'http://box.lan:7000' })
    expect((await http(port, '/', { headers: { host: 'box.lan:7000' } })).status).toBe(200)
    const { code } = await peer.call<{ code: string }>('web.pair', {})
    expect((await pairWith(port, { code }, { host: 'box.lan:7000', origin: `http://127.0.0.1:${port}` })).status).toBe(403)
    expect((await pairWith(port, { code }, { host: 'box.lan:7000', origin: 'http://box.lan:7000' })).status).toBe(200)
    await expect(peer.call('settings.set', { key: 'web.host', value: 'https://box.lan/app' })).rejects.toMatchObject({ kind: 'invalid_setting', message: expect.stringContaining('no path') })
    await expect(peer.call('settings.set', { key: 'web.host', value: 'box lan' })).rejects.toMatchObject({ kind: 'invalid_setting' })
    // Back to automatic.
    await peer.call('settings.set', { key: 'web.host', value: '' })
    expect((await peer.call<{ link: string }>('web.pair', {})).link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=`))
    expect((await http(port, '/', { headers: { host: 'box.lan:7000' } })).status).toBe(403)
    // An agent's shell: the user's consent, not the agent's.
    const agent = await connectSocket(join(dir, 'superego.sock'))
    await agent.peer.call('hello', { client: 'cli', version: PROTOCOL_VERSION, from: 't1' })
    for (const [key, value] of [['web.host', 'evil.example'], ['web.tailscale.socket', '']] as const) {
      await expect(agent.peer.call('settings.set', { key, value })).rejects.toMatchObject({ kind: 'consent' })
    }
    agent.socket.destroy()
    await close()
  })

  it('serves a thread’s artifacts from its folder, and nothing a symlink there leads to outside it', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const { peer, section, close } = await open({ 'web.access': 'local' as never, 'web.port': port as never })
    await until(async () => Boolean((await section()).data))
    await mkdir(join(dir, 'repo'))
    await writeFile(join(dir, 'repo/page.html'), '<p>hi</p>')
    await writeFile(join(dir, 'secret.txt'), 'secret')
    await symlink(join(dir, 'secret.txt'), join(dir, 'repo/secret.txt'))
    const thread = await peer.call<{ id: string }>('thread.start', { cwd: join(dir, 'repo') })
    const { code } = await peer.call<{ code: string }>('web.pair', {})
    const cookie = cookieFrom(await pairWith(port, { code }))
    const at = String((await http(port, `/artifact/${thread.id}/page.html`, { headers: { cookie } })).headers.location)
    expect(await http(port, at)).toMatchObject({ status: 200, body: '<p>hi</p>' })
    expect((await http(port, at.replace('page.html', 'secret.txt'))).status).toBe(403)
    expect((await http(port, at.replace('page.html', '..%2Fsecret.txt'))).status).toBe(403)
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
      // `status --json`, `serve status --json`, `serve --bg … <target>` (kept in serve.json), `serve --https=443 off`;
      // any of them for another tailscaled, after --socket=<its socket>.
      await writeFile(join(bin, 'tailscale'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
case "$1" in --socket=*) shift ;; esac
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
      Version: '1.94.0-t1234-g5678', BackendState: 'Running', CertDomains: ['box.tail1234.ts.net'],
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
      // To a socket in the data folder: no path, nothing secret in it.
      expect(proxy).toBe(`unix:${join(dir, 'web', 'tailscale.sock')}`)
      const through = join(dir, 'web', 'tailscale.sock')
      const headers = { host: 'localhost', 'x-forwarded-host': 'box.tail1234.ts.net', 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': 'me@example.com' }
      expect((await http(through, '/rpc', { headers })).status).toBe(204)
      expect((await http(port, '/rpc', { headers })).status).toBe(401)
      expect((await http(port, '/rpc', { headers: { ...headers, host: 'box.tail1234.ts.net' } })).status).toBe(403)
      const owner = await socket(through, { ...headers, origin: 'https://box.tail1234.ts.net' }, { keep: true })
      expect(owner.result).toBe('open')
      expect(await peer.call('web.devices', {})).toMatchObject([{ id: 'tailscale:phone', tailscale: true }])
      await expect(peer.call('web.revoke', { id: 'tailscale:phone' })).rejects.toMatchObject({ kind: 'invalid' })
      expect((await peer.call<{ link: string }>('web.pair', {})).link).toMatch(/^https:\/\/box\.tail1234\.ts\.net\/#pair=/)
      // Require pairing for the owner too: their live connections close.
      await peer.call('settings.set', { key: 'web.tailscale.pairing', value: true })
      await owner.closed
      expect((await http(through, '/rpc', { headers })).status).toBe(401)
      expect(await peer.call('web.devices', {})).toEqual([])
      await peer.call('settings.set', { key: 'web.access', value: 'off' })
      // Taken down: the stub logs the command before it has done it.
      await until(async () => (await readFile(join(dir, 'serve.json'), 'utf8')).trim() === '{}')
      expect(await readFile(log, 'utf8')).toContain('serve --https=443 off')
      expect(await readFile(join(dir, 'serve.json'), 'utf8')).toContain('{}')
      // And its socket with it.
      await until(async () => !(await stat(through).then(() => true, () => false)))
      await close()
    })

    it('says what keeps Tailscale from serving', async () => {
      const port = 20000 + Math.floor(Math.random() * 20000)
      // A tailscaled too old to proxy to a Unix socket is one that can't serve it (its message says to update it).
      for (const [status, state] of [[{ ...running, BackendState: 'NeedsLogin' }, 'logged-out'], [{ ...running, CertDomains: null }, 'no-https'], [{ ...running, Version: '1.92.3-tabc-gdef' }, 'error']] as const) {
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

    it('serves through the tailscaled chosen, and takes over a serve that already reaches its port', async () => {
      await stub(running)
      const port = 20000 + Math.floor(Math.random() * 20000)
      // Set up by hand, without the prefix: it reached the daemon, as a plain loopback client.
      await writeFile(join(dir, 'serve.json'), JSON.stringify({ Web: { 'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } }))
      const { peer, section, close } = await open({ 'web.access': 'tailscale' as never, 'web.port': port as never, 'web.tailscale.socket': '/run/tailscale-personal/tailscaled.sock' as never })
      await until(async () => ((await section()).data as { tailscale?: { state: string } }).tailscale?.state === 'serving')
      // What serves (this machine's other tailscaleds are looked at too, each by its own socket, the default by none).
      const lines = (await readFile(log, 'utf8')).trim().split('\n').filter((line) => line.includes('serve'))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).toMatch(/^--socket=\/run\/tailscale-personal\/tailscaled\.sock /)
      expect(lines.some((line) => line.includes(' serve --bg '))).toBe(true)
      // Back to the default one: the chosen one's serve goes, and the default one's comes, without --socket.
      await writeFile(log, '')
      await peer.call('settings.set', { key: 'web.tailscale.socket', value: '' })
      await until(async () => (await readFile(log, 'utf8')).includes('\nserve --bg') || (await readFile(log, 'utf8')).startsWith('serve --bg'))
      const after = await readFile(log, 'utf8')
      expect(after).toContain('--socket=/run/tailscale-personal/tailscaled.sock serve --https=443 off')
      expect(after).toMatch(/^serve --bg /m)
      await close()
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
