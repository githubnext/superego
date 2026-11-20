// OAuth against a fake authorization server (auth-server.ts: the SDK's own server-side pieces): discovery from the
// server's 401, dynamic registration (once), PKCE and state and resource; the redirect caught by the daemon's listener,
// or pasted when its port is taken (a remote machine's flow, as the desktop app answers it); refresh before a token
// runs out, a rotating refresh token used once however many calls want it at once, `invalid_grant` → needs-sign-in;
// a client registered by hand; and through a real daemon: `mcp-servers.signIn` as a flow, tools over the token, a call
// failing cleanly once the sign-in is refused, and logout.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { AuthFlow } from '@superego/daemon'
import { callTool, say, testDaemon, type Turn } from '@superego/sdk/testing'
import type { AuthEvent, AuthPrompt, Notifications, RpcPeer, ThreadInfo } from '@superego/protocol'
import { mcpServersExtension } from '../src/daemon.ts'
import { Callbacks, catchRedirect, redirectOf } from '../src/loopback.ts'
import { clientKey, OAuthAccess, readRedirect, resourceOf, signIn, tokenKey, type SignedIn, type SignInOptions } from '../src/oauth.ts'
import { SERVERS_VALUE, type CheckResult, type SectionData, type ServerInfo } from '../src/shared.ts'
import { SecretStore, serverKey } from '../src/store.ts'
import { serveOAuth } from './auth-server.ts'
import { serveHttp } from './fixture.ts'

let dir: string
const closing: (() => unknown)[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-oauth-')) })
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close()
  await rm(dir, { recursive: true, force: true })
})

const until = async (check: () => boolean | Promise<boolean>, what = 'it') => {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out waiting for ${what}`)
}
/** A port nothing listens on now. */
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}
/** Something else on the port: the daemon can't listen there, so the address is pasted (or the app answers). */
async function occupy(port: number) {
  const server: Server = createServer((_req, res) => res.writeHead(418).end())
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  closing.push(() => new Promise((resolve) => server.close(resolve)))
}
async function authServer(options: Parameters<typeof serveOAuth>[0] = {}) {
  const as = await serveOAuth(options)
  closing.push(() => as.close())
  return as
}

/** A flow as `superego.auth.flow` gives `run` one: its events kept, its prompts answered by the test. */
function fakeFlow() {
  const events: AuthEvent[] = []
  const prompts: { prompt: AuthPrompt; answer(value: string): void; closed: boolean }[] = []
  const abort = new AbortController()
  const flow: AuthFlow = {
    id: 'flow', signal: abort.signal,
    emit: (event) => { events.push(event) },
    prompt: (prompt, options) => new Promise<string>((resolve, reject) => {
      const entry = { prompt, answer: resolve, closed: false }
      prompts.push(entry)
      options?.signal?.addEventListener('abort', () => { entry.closed = true; reject(new Error('Prompt closed')) }, { once: true })
    }),
  }
  const page = () => (events.find((e) => e.type === 'auth_url') as Extract<AuthEvent, { type: 'auth_url' }> | undefined)
  return { flow, events, prompts, page, cancel: () => abort.abort() }
}

async function signedIn(options: Parameters<typeof serveOAuth>[0] = {}, more: Partial<SignInOptions> = {}, port?: number) {
  const as = await authServer(options)
  const store = new SecretStore(join(dir, 'mcp-auth.json'))
  port ??= await freePort()
  const callbacks = new Callbacks(port)
  closing.push(() => callbacks.close())
  const { flow, page } = fakeFlow()
  const signing = signIn({ store, name: 'fx', url: as.url, redirect: redirectOf(port), callbacks, clientName: 'Superego', ...more }, flow)
  await until(() => Boolean(page()), 'the sign-in page')
  // The browser: signs in, and is sent back to the daemon's listener.
  const back = await fetch(await as.approve(page()!.url))
  expect(await back.text()).toMatch(/Signed in/)
  const entry = await signing
  return { as, store, port, entry, access: new OAuthAccess(store) }
}

it('signs in: discovery from the 401, registration, PKCE, state and resource; the redirect caught by the listener', async () => {
  const { as, store, port, entry } = await signedIn({}, { scopes: ['tools'] })
  const redirect = redirectOf(port)
  // Registered once, for the app's redirect, as a public client.
  expect(as.seen.registered).toHaveLength(1)
  expect(as.seen.registered[0]).toMatchObject({ client_name: 'Superego', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
  // Asked with a PKCE challenge, its state, the resource and the scope.
  expect(as.seen.authorized).toEqual([expect.objectContaining({ redirectUri: redirect, scopes: ['tools'], codeChallenge: expect.any(String), state: expect.any(String) })])
  expect(as.seen.authorized[0]!.resource?.href).toBe(as.url)
  expect(as.seen.grants).toEqual([{ grant: 'code', client: as.seen.registered[0]!.client_id, resource: as.url }])
  // Kept: the tokens by the server's resource, the registration by its issuer and redirect.
  const kept = JSON.parse(await readFile(join(dir, 'mcp-auth.json'), 'utf8'))
  expect(Object.keys(kept).sort()).toEqual([clientKey(`${as.base}/`, redirect), tokenKey(resourceOf(as.url))].sort())
  expect(kept[tokenKey(resourceOf(as.url))]).toEqual(JSON.parse(JSON.stringify(entry)))
  expect(entry).toMatchObject({ resource: as.url, tokens: { access_token: expect.stringMatching(/^access-/), refresh_token: expect.stringMatching(/^refresh-/) }, expiresAt: expect.any(Number) })
  expect(store.secrets()).toContain(entry.tokens.access_token)

  // Again: the registration is used again, not made again.
  const { flow, page } = fakeFlow()
  const callbacks = new Callbacks(port)
  closing.push(() => callbacks.close())
  const again = signIn({ store, name: 'fx', url: as.url, redirect, callbacks, clientName: 'Superego' }, flow)
  await until(() => Boolean(page()))
  await fetch(await as.approve(page()!.url))
  await again
  expect(as.seen.registered).toHaveLength(1)
})

it('takes the pasted address when its port is taken: a bad one asked again, the right one signs in', async () => {
  const as = await authServer()
  const store = new SecretStore(join(dir, 'mcp-auth.json'))
  const port = await freePort()
  await occupy(port)
  const callbacks = new Callbacks(port)
  closing.push(() => callbacks.close())
  const { flow, events, prompts, page } = fakeFlow()
  const signing = signIn({ store, name: 'fx', url: as.url, redirect: redirectOf(port), callbacks, clientName: 'Superego' }, flow)
  await until(() => prompts.length === 1, 'the prompt')
  // The page, with the address it comes back to (the desktop app listens there for a remote machine), then the prompt.
  expect(page()).toMatchObject({ callback: redirectOf(port), url: expect.stringContaining(`${as.base}/authorize?`) })
  expect(events.findIndex((e) => e.type === 'auth_url')).toBeGreaterThan(-1)
  expect(prompts[0]!.prompt).toMatchObject({ type: 'manual_code' })
  const location = await as.approve(page()!.url)
  // Another sign-in's address: asked again, saying why.
  prompts[0]!.answer(location.replace(/state=[^&]+/, 'state=someone-elses'))
  await until(() => prompts.length === 2)
  expect(prompts[1]!.prompt).toMatchObject({ type: 'manual_code', message: expect.stringMatching(/another sign-in/) })
  prompts[1]!.answer(location)
  const entry = await signing
  expect(entry.tokens.access_token).toMatch(/^access-/)
})

it('says why when the authorization server turns the sign-in down', async () => {
  const state = 'abc'
  expect(readRedirect(`http://127.0.0.1:1456/mcp/callback?error=access_denied&error_description=No&state=${state}`, state)).toEqual({ error: 'access_denied: No' })
  expect(readRedirect(`code=x&state=${state}`, state)).toEqual({ code: 'x' })
  expect(readRedirect('just-a-code', state)).toMatchObject({ why: expect.stringMatching(/whole address/) })
})

it('refreshes a token with under a minute left, with its resource, and keeps the new one', async () => {
  const { as, store, access, entry } = await signedIn({ expiresIn: 30 })
  const resource = resourceOf(as.url)
  const token = await access.token(resource)
  expect(token).not.toBe(entry.tokens.access_token)
  expect(as.seen.grants.at(-1)).toEqual({ grant: 'refresh', client: entry.client.client_id, resource: as.url })
  const kept = await store.read<never>(tokenKey(resource)) as unknown as SignedIn
  expect(kept.tokens.access_token).toBe(token)
  expect(kept.tokens.refresh_token).not.toBe(entry.tokens.refresh_token)
  // A token with time left isn't refreshed.
  as.expiresIn = 3600
  const fresh = await access.token(resource)
  const grants = as.seen.grants.length
  expect(await access.token(resource)).toBe(fresh)
  expect(as.seen.grants).toHaveLength(grants)
})

it('uses a rotating refresh token once, however many calls want a fresh token at once', async () => {
  const { as, access } = await signedIn({ expiresIn: 30 })
  const resource = resourceOf(as.url)
  as.expiresIn = 3600
  const fetchFn = access.fetchFor(resource)
  const calls = await Promise.all(Array.from({ length: 6 }, () => access.token(resource)))
  expect(new Set(calls).size).toBe(1)
  expect(as.seen.grants.filter((g) => g.grant === 'refresh')).toEqual([expect.objectContaining({ grant: 'refresh' })])
  // Requests to the server carry it; a refused one gets another token and one more try.
  as.expireAccess()
  const response = await fetchFn(as.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })
  expect(response.status).toBe(200)
  await response.body?.cancel()
  expect(as.seen.grants.filter((g) => g.grant === 'refresh')).toHaveLength(2)
  expect(as.seen.bearer.at(-1)).toBe(`Bearer ${await access.token(resource)}`)
  // Never to another origin.
  const elsewhere = createServer((req, res) => res.end(req.headers.authorization ?? 'none'))
  await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve))
  closing.push(() => new Promise((resolve) => elsewhere.close(resolve)))
  const other = await fetchFn(`http://127.0.0.1:${(elsewhere.address() as { port: number }).port}/`)
  expect(await other.text()).toBe('none')
})

it('a stalled token endpoint holds up only its own refresh, and is given up on', async () => {
  const { as, store, entry } = await signedIn({ expiresIn: 30 })
  const resource = resourceOf(as.url)
  const access = new OAuthAccess(store, undefined, { timeout: 500 })
  as.stall = true
  const refreshing = access.token(resource)
  let settled = false
  void refreshing.finally(() => { settled = true }).catch(() => {})
  await until(() => as.stalledCount === 1, 'the refresh to stall')
  // Meanwhile, nothing else waits for it: reads (its own key's too), and changes to other keys.
  await store.modify(serverKey('other'), () => ({ key: 'other-key' }))
  expect(await store.read(serverKey('other'))).toEqual({ key: 'other-key' })
  expect((await access.signedIn(resource))?.tokens.access_token).toBe(entry.tokens.access_token)
  expect(settled).toBe(false)
  // Given up on: the token it has is good for a little longer, so it's used.
  expect(await refreshing).toBe(entry.tokens.access_token)
  // One the server turned away can't be: the call fails, saying why.
  await expect(access.token(resource, entry.tokens.access_token)).rejects.toThrow(/didn't answer a refresh within 1s/)
  // Both entries kept whole: writes to different keys didn't lose each other.
  const kept = JSON.parse(await readFile(join(dir, 'mcp-auth.json'), 'utf8'))
  expect(kept[serverKey('other')]).toEqual({ key: 'other-key' })
  expect(kept[tokenKey(resource)].tokens.refresh_token).toBe(entry.tokens.refresh_token)
})

it('remembers only secret values for redacting: tokens, client secrets, server secrets, short ones too', async () => {
  const port = await freePort()
  const client = { client_id: 'superego-app', client_secret: 'shh', redirect_uris: [redirectOf(port)] }
  const { as, store, entry } = await signedIn({ client }, { clientId: 'superego-app', clientSecret: 'shh' }, port)
  await store.modify(serverKey('web'), () => ({ key: 'k1', '@for': '["https://example.com","api-key"]' }))
  const secrets = store.secrets()
  expect(secrets).not.toContain('["https://example.com","api-key"]')
  expect(secrets).toEqual(expect.arrayContaining([entry.tokens.access_token, entry.tokens.refresh_token!, 'shh', 'k1']))
  for (const plain of ['Bearer', 'bearer', as.url, `${as.base}/`, 'superego-app', 'Superego']) expect(secrets).not.toContain(plain)
})

it('forgets a sign-in whose refresh is refused (invalid_grant), and says so', async () => {
  const { as, store, access } = await signedIn({ expiresIn: 30 })
  const resource = resourceOf(as.url)
  as.revokeAll()
  const refused = access.token(resource)
  await expect(refused).rejects.toBeInstanceOf(UnauthorizedError)
  await expect(refused).rejects.toThrow(/refreshing its sign-in was refused/)
  expect(await store.read(tokenKey(resource))).toBeUndefined()
  // Calls that wanted it at the same time, or after, are told why too; once signed out, just that it isn't signed in.
  await expect(access.token(resource)).rejects.toThrow(/refreshing its sign-in was refused/)
  await access.forget(resource)
  await expect(access.token(resource)).rejects.toThrow(/isn't signed in/)
})

it('signs in with a client registered by hand, and its secret', async () => {
  const port = await freePort()
  const client = { client_id: 'superego-app', client_secret: 'shh-its-a-secret', redirect_uris: [redirectOf(port)] }
  const { as, entry } = await signedIn({ client }, { clientId: 'superego-app', clientSecret: 'shh-its-a-secret' }, port)
  expect(as.seen.registered).toEqual([])
  expect(as.seen.grants).toEqual([expect.objectContaining({ grant: 'code', client: 'superego-app' })])
  expect(entry.client).toEqual({ client_id: 'superego-app', client_secret: 'shh-its-a-secret' })
})

// ── Through a daemon ────────────────────────────────────────────────────────────────────────────────────────────────

async function open(port: number, model: Turn[] = []) {
  const d = await testDaemon({ dataDir: dir, model, callbackPort: port, extensions: [mcpServersExtension({ checkWait: 15_000 })] })
  closing.push(() => d.close())
  const events = new Map<string, AuthEvent[]>()
  d.peer.on('auth.event', ({ flow, event }: Notifications['auth.event']) => { events.set(flow, [...events.get(flow) ?? [], event]) })
  return { peer: d.peer, events }
}
const act = <T = CheckResult>(peer: RpcPeer, id: string, params: object) => peer.call<T>('action.run', { id: `mcp-servers.${id}`, params })
/** What Settings → MCP servers draws: the live value it names, once a change just made is told (10ms after it settles). */
const section = async (peer: RpcPeer) => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  const { sub, value } = await peer.call<{ sub: string; value: SectionData }>('value.watch', { key: SERVERS_VALUE })
  await peer.call('unwatch', { sub })
  return value
}
const info = async (peer: RpcPeer, name: string) => (await section(peer)).servers.find((s) => s.name === name) as ServerInfo
async function results(peer: RpcPeer, id: string) {
  const { value } = await peer.call<{ value: { entries: { model?: { role?: string; content?: { type: string; text?: string }[]; isError?: boolean }[] }[] } }>('thread.watch', { thread: id })
  return value.entries.map((e) => e.model?.[0]).filter((m) => m?.role === 'toolResult')
    .map((m) => `${m!.isError ? 'error: ' : ''}${m!.content?.map((c) => c.text ?? `[${c.type}]`).join('\n')}`)
}

it('signs in through mcp-servers.signIn, uses the token for its tools, and signs out', async () => {
  const as = await authServer()
  const port = await freePort()
  const { peer, events } = await open(port, [callTool('mcp__fx__echo', { text: 'hi' }), say('Done.')])
  const { server } = await act(peer, 'add', { name: 'fx', server: { url: as.url, auth: { type: 'oauth' }, unprofiled: true } })
  // Not signed in: not tried, and Settings says so.
  expect(server).toMatchObject({ state: 'needs-sign-in', error: expect.stringMatching(/fx needs you to sign in/), oauth: { signedIn: false } })
  expect(as.seen.bearer).toEqual([])
  await expect(act(peer, 'signIn', { server: 'nope' })).rejects.toThrow(/No MCP server nope/)

  const { flow } = await act<{ flow: string }>(peer, 'signIn', { server: 'fx' })
  await until(() => Boolean(events.get(flow)?.some((e) => e.type === 'prompt')), 'the prompt')
  const url = events.get(flow)!.find((e) => e.type === 'auth_url') as Extract<AuthEvent, { type: 'auth_url' }>
  expect(url.callback).toBe(`http://127.0.0.1:${port}/mcp/callback`)
  // The browser comes back to the daemon: the prompt is put away, and the flow is done once it's connected.
  await fetch(await as.approve(url.url))
  await until(() => Boolean(events.get(flow)?.some((e) => e.type === 'done' || e.type === 'failed')), 'the flow to end')
  const said = events.get(flow)!
  expect(said.at(-1)).toEqual({ type: 'done' })
  expect(said.some((e) => e.type === 'prompt_closed')).toBe(true)
  const signed = await info(peer, 'fx')
  expect(signed).toMatchObject({ tools: 6, oauth: { signedIn: true, refreshes: true, expires: expect.any(Number), since: expect.any(Number) } })
  expect(['running', 'stopped']).toContain(signed.state)
  // No token reaches a client.
  const kept = JSON.parse(await readFile(join(dir, 'mcp-auth.json'), 'utf8'))[tokenKey(resourceOf(as.url))] as SignedIn
  expect(JSON.stringify(await section(peer))).not.toContain(kept.tokens.access_token)
  expect(JSON.stringify(said)).not.toContain(kept.tokens.access_token)

  // A thread's call goes with the token.
  const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'go' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)?.status.state === 'done', 'the thread')
  expect(await results(peer, thread.id)).toEqual(['hi'])
  expect(as.seen.bearer.at(-1)).toBe(`Bearer ${kept.tokens.access_token}`)
  const { text } = await act<{ text: string }>(peer, 'log', { server: 'fx', lines: 200 })
  expect(text).toContain('signed in')
  expect(text).not.toContain(kept.tokens.access_token)

  // Signed out: the tokens are forgotten; the registration is kept for next time.
  const { server: out } = await act(peer, 'signOut', { server: 'fx' })
  expect(out).toMatchObject({ state: 'needs-sign-in', oauth: { signedIn: false } })
  const after = JSON.parse(await readFile(join(dir, 'mcp-auth.json'), 'utf8'))
  expect(Object.keys(after)).toEqual([expect.stringMatching(/^client:/)])
})

it("doesn't hold up other servers or Settings while one server's token endpoint stalls", async () => {
  const as = await authServer()
  const web = await serveHttp()
  closing.push(() => web.close())
  const port = await freePort()
  const { peer, events } = await open(port)
  await act(peer, 'add', { name: 'fx', server: { url: as.url, auth: { type: 'oauth' }, unprofiled: true } })
  const { flow } = await act<{ flow: string }>(peer, 'signIn', { server: 'fx' })
  await until(() => Boolean(events.get(flow)?.some((e) => e.type === 'auth_url')), 'the page')
  const page = events.get(flow)!.find((e) => e.type === 'auth_url') as Extract<AuthEvent, { type: 'auth_url' }>
  // Where the user signs in is said, by its host.
  expect(page.instructions).toContain(new URL(as.base).host)
  await fetch(await as.approve(page.url))
  await until(() => Boolean(events.get(flow)?.some((e) => e.type === 'done')), 'signed in')

  // fx's token is turned away, and getting another stalls: its restart waits on the authorization server…
  as.expireAccess()
  as.stall = true
  const restarting = act(peer, 'restart', { server: 'fx' })
  let settled = false
  void restarting.finally(() => { settled = true }).catch(() => {})
  await until(() => as.stalledCount === 1, 'the refresh to stall')
  // …while another server is added, keyed and connected, and Settings reads.
  await act(peer, 'add', { name: 'web', server: { url: web.url, auth: { type: 'api-key' }, unprofiled: true } })
  const set = await act(peer, 'set-secret', { server: 'web', values: { key: 'good-key' } })
  expect(set.server).toMatchObject({ tools: 6 })
  expect((await section(peer)).servers.map((s) => s.name).sort()).toEqual(['fx', 'web'])
  expect(settled).toBe(false)
  as.stall = false
  await restarting
})

it("answers a remote machine's flow by its manual_code prompt, and puts a refused sign-in into needs-sign-in", async () => {
  const as = await authServer({ expiresIn: 30 })
  const port = await freePort()
  // The daemon's port is taken here: as on a remote machine, the desktop app (or the user) answers the prompt.
  await occupy(port)
  const { peer, events } = await open(port, [callTool('mcp__fx__echo', { text: 'hi' }), say('Done.')])
  await act(peer, 'add', { name: 'fx', server: { url: as.url, auth: { type: 'oauth' }, unprofiled: true } })
  const { flow } = await act<{ flow: string }>(peer, 'signIn', { server: 'fx' })
  await until(() => Boolean(events.get(flow)?.some((e) => e.type === 'prompt')), 'the prompt')
  const said = events.get(flow)!
  const url = said.find((e) => e.type === 'auth_url') as Extract<AuthEvent, { type: 'auth_url' }>
  const prompt = said.find((e) => e.type === 'prompt') as Extract<AuthEvent, { type: 'prompt' }>
  expect(prompt.prompt.type).toBe('manual_code')
  await peer.call('auth.respond', { flow, prompt: prompt.id, value: await as.approve(url.url) })
  await until(() => Boolean(events.get(flow)?.some((e) => e.type === 'done' || e.type === 'failed')), 'the flow to end')
  expect(events.get(flow)!.at(-1)).toEqual({ type: 'done' })
  expect(await info(peer, 'fx')).toMatchObject({ tools: 6 })

  // The authorization server forgets it: the next call's refresh is refused, and the server needs sign-in.
  as.revokeAll()
  const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'go' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)?.status.state === 'done', 'the thread')
  const [result] = await results(peer, thread.id)
  expect(result).toMatch(/^error: fx needs you to sign in again \(Settings → MCP servers\): refreshing its sign-in was refused/)
  await until(async () => (await info(peer, 'fx')).state === 'needs-sign-in', 'needs-sign-in')
  expect((await info(peer, 'fx')).oauth).toEqual({ signedIn: false })
})

it("catches the command line's redirect only with the page's state", async () => {
  const port = await freePort()
  const stop = new AbortController()
  closing.push(() => stop.abort())
  const caught = catchRedirect(redirectOf(port), stop.signal, 'https://auth.example/authorize?state=the-state')
  let got: string | undefined
  void caught.then((url) => { got = url }, () => {})
  await until(() => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false), 'the listener')
  const wrong = await fetch(`${redirectOf(port)}?code=evil&state=other`)
  expect(wrong.status).toBe(400)
  await new Promise((r) => setTimeout(r, 20))
  expect(got).toBeUndefined()
  await fetch(`${redirectOf(port)}?code=abc&state=the-state`)
  expect(await caught).toBe(`${redirectOf(port)}?code=abc&state=the-state`)
})

/** A request as written (`GET //`, which no client library sends): the answer's status line. */
const raw = (port: number, path: string) => new Promise<string>((resolve, reject) => {
  const sock = connect(port, '127.0.0.1', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`))
  let answer = ''
  sock.on('data', (chunk) => { answer += chunk; if (answer.includes('\r\n')) { resolve(answer.split('\r\n')[0]!); sock.destroy() } })
  sock.on('error', reject)
})

it('turns away a request that names no path, rather than going down with it', async () => {
  const port = await freePort()
  const stop = new AbortController()
  closing.push(() => stop.abort())
  const callbacks = new Callbacks(port)
  closing.push(() => callbacks.close())
  void callbacks.wait('the-state', stop.signal).catch(() => {})
  await until(() => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false), 'the listener')
  for (const path of ['//', '//evil.example/mcp/callback', '*']) expect(await raw(port, path), path).toBe('HTTP/1.1 400 Bad Request')
  expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404)
  // The command line's listener too.
  const other = await freePort()
  void catchRedirect(redirectOf(other), stop.signal).catch(() => {})
  await until(() => fetch(`http://127.0.0.1:${other}/`).then(() => true, () => false), 'the listener')
  expect(await raw(other, '//')).toBe('HTTP/1.1 400 Bad Request')
  expect((await fetch(`http://127.0.0.1:${other}/`)).status).toBe(404)
})
