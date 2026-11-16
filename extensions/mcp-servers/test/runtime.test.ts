// The runtime's hygiene (the review's H2, M1, M3, M4, L4, L5): a crash line never carries a stored value out; a profile's
// server from the cache runs only once its profile loads again, and goes with its profile's folder; a call cut off by
// a Restart may have run; an extension torn down while a server starts leaves no process behind; a URL that can't be
// reached is tried again, and never fails the server. Most against `Runtime` itself, with a stand-in for the API; the
// profile's against a real daemon.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { DaemonApi } from '@superego/daemon'
import type { ThreadInfo } from '@superego/protocol'
import { callTool, say, testDaemon, type TestDaemon, type Turn } from '@superego/sdk/testing'
import { mcpServersExtension } from '../src/daemon.ts'
import { Runtime, type Server } from '../src/servers.ts'
import { SERVERS_VALUE, type CheckResult, type SectionData, type ServerConfig } from '../src/shared.ts'
import { SecretStore } from '../src/store.ts'

const FIXTURE = join(import.meta.dirname, 'fixture.ts')
let dir: string
let calls: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-mcp-runtime-'))
  calls = join(dir, 'calls')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

const until = async (check: () => boolean | Promise<boolean>, what = 'it', ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out waiting for ${what}`)
}
const fixture = (more: Partial<ServerConfig> = {}): ServerConfig => ({ command: process.execPath, args: [FIXTURE], env: { FIXTURE_CALLS: calls }, ...more })
const callsMade = () => existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// ── Against the runtime ───────────────────────────────────────────────────────────────────────────────────────────

/** A runtime over a stand-in for the daemon's API: `abort()` tears it down, as an extension reload does. */
function runtime(options: ConstructorParameters<typeof Runtime>[3] = {}) {
  const life = new AbortController()
  const api = {
    dataDir: dir, signal: life.signal,
    agent: () => ({ replace() {}, remove() {} }),
    threads: { of: () => undefined, attachments: () => join(dir, 'files'), get: async () => ({ cwd: dir }) },
  } as unknown as DaemonApi
  const store = new SecretStore(join(dir, 'mcp-auth.json'))
  return { runtime: new Runtime(api, store, () => {}, { idle: 60_000, ...options }), abort: () => life.abort() }
}
const machine = (r: Runtime, name: string, config: ServerConfig) => r.add(name, { type: 'machine' }, config, dir, name)
/** Call one of its tools, as a thread's model would. */
async function call(r: Runtime, server: Server, tool: string, args: Record<string, unknown> = {}) {
  const offered = server.offered.find((t) => t.tool === tool)!
  const result = await r.call(server, offered, args, { conversationId: 1, callId: `c${Math.random()}`, output() {} } as never, {} as never)
  return { error: result.isError === true, text: (result.output as { text: string }[]).map((c) => c.text).join('\n') }
}

it("hides every value the store keeps in what a crash says: the model's result, Settings, the reason it failed", async () => {
  // Another server's key, which this one's crash happens to print.
  writeFileSync(join(dir, 'mcp-auth.json'), JSON.stringify({ 'server:other': { key: 'sntrys_hush_hush_42' } }), { mode: 0o600 })
  const { runtime: r, abort } = runtime()
  const fx = await machine(r, 'fx', fixture({ env: { FIXTURE_CALLS: calls, FIXTURE_LAST_WORDS: 'invalid token sntrys_hush_hush_42' } }))
  await r.check(fx, 30_000)
  expect(fx.offered.length).toBeGreaterThan(0)
  const results = []
  for (let i = 0; i < 3; i++) results.push(await call(r, fx, 'crash'))
  for (const result of results) {
    expect(result.error).toBe(true)
    expect(result.text).toContain('invalid token ***')
  }
  expect(r.stateOf(fx)).toBe('failed')
  // Its config holds the value only because this test put it there to be printed.
  const { config: _config, ...info } = await r.info(fx)
  const said = JSON.stringify([results, info, r.whyNot(fx), fx.error, fx.failed])
  expect(said).not.toContain('sntrys_hush_hush_42')
  expect(r.whyNot(fx)).toContain('invalid token ***')
  // A call now fails at once, with the reason hidden too.
  expect((await call(r, fx, 'echo', { text: 'x' })).text).toMatch(/fx has failed .*invalid token \*\*\*/)
  abort()
}, 60_000)

it('tells the model a call cut off by Restart may or may not have taken effect', async () => {
  const { runtime: r, abort } = runtime()
  const fx = await machine(r, 'fx', fixture())
  await r.check(fx, 30_000)
  const hanging = call(r, fx, 'hang')
  await until(() => callsMade().includes('hang'), 'the call to reach the server')
  await r.restart(fx, 30_000)
  const result = await hanging
  expect(result.error).toBe(true)
  expect(result.text).toBe('fx.hang was cut off before it answered: fx was restarted\nIt may or may not have taken effect on the server. Check (for example, list or read what it would have changed) before calling it again.')
  // Restarted, it runs again.
  expect(await call(r, fx, 'echo', { text: 'back' })).toEqual({ error: false, text: 'back' })
  abort()
}, 60_000)

it('stops a server that is still starting when the extension is torn down', async () => {
  const { runtime: r, abort } = runtime()
  const pidFile = join(dir, 'pid')
  // Starts, and never says hello: it stays starting.
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
  const slow = await machine(r, 'slow', { command: process.execPath, args: ['-e', script] })
  await r.check(slow, 50)
  await until(() => existsSync(pidFile), 'the command to start')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  expect(alive(pid)).toBe(true)
  expect(r.stateOf(slow)).toBe('starting')
  abort()
  await until(() => !alive(pid), 'its process to stop', 10_000)
  // Called off, not failed.
  expect(slow.crashes).toEqual([])
}, 30_000)

it("tries a URL that can't be reached again, and never fails it for that", async () => {
  // A port nothing listens on.
  const port = await new Promise<number>((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) }) })
  const { runtime: r, abort } = runtime({ retries: [10, 10] })
  const web = await machine(r, 'web', { url: `http://127.0.0.1:${port}/mcp` })
  for (let i = 0; i < 4; i++) await r.check(web, 10_000)
  expect(r.stateOf(web)).toBe('stopped')
  expect(web.crashes).toEqual([])
  expect((await r.info(web)).error).toBeTruthy()
  expect(await web.log.tail(100)).toContain('not reached; trying again in 0.01s')
  abort()
}, 30_000)

// ── Against a daemon: a profile's server across restarts ─────────────────────────────────────────────────────────

/** A daemon with mcp-servers, in `dir`, answering as `model` says. */
const open = (model: Turn[] = []) => testDaemon({
  dataDir: dir, model, agentPartsLimit: 65_000,
  extensions: [mcpServersExtension({ checkWait: 15_000, firstListing: 60_000 })],
})
const done = (d: TestDaemon, id: string) =>
  d.until(async () => (await d.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)?.status.state === 'done', 'the thread to be done', 30_000)
/** What Settings → MCP servers draws: the live value it names, once a change just made is told (10ms after it settles). */
const section = async (d: TestDaemon) => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  const { sub, value } = await d.call<{ sub: string; value: SectionData }>('value.watch', { key: SERVERS_VALUE })
  await d.call('unwatch', { sub })
  return value
}
const profileTs = (spec: object) => `import { defineProfile } from 'superego'\nexport default defineProfile(${JSON.stringify(spec)})\n`
const writeProfile = (project: string, spec: object) => {
  const folder = join(project, '.superego', 'profiles', 'default')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'profile.ts'), profileTs(spec))
}
const starts = () => callsMade().filter((l) => l.startsWith('start')).length

it("doesn't run a cached profile's server after a restart until its profile loads again, and forgets it with its folder", async () => {
  const project = join(dir, 'acme')
  writeProfile(project, { mcpServers: [{ docs: fixture() }] })
  const first = await open([callTool('mcp__docs__echo', { text: 'one' }), say('Done.')])
  await first.call('profile.allow', { cwd: project })
  const thread = await first.call<ThreadInfo>('thread.start', { cwd: project, prompt: 'go' })
  await done(first, thread.id)
  expect((await section(first)).profiles).toMatchObject([{ name: 'docs', profileAllowed: true }])
  await first.close()

  // Changed while the daemon was down: it needs allowing again.
  writeProfile(project, { mcpServers: [{ docs: fixture({ args: [FIXTURE, '--changed'] }) }] })
  const second = await first.restart({ model: [callTool('mcp__docs__echo', { text: 'two' }), say('Done.')] })
  const [docs] = (await section(second)).profiles
  expect(docs).toMatchObject({ name: 'docs', state: 'stopped', profileAllowed: false })
  const before = starts()
  // Neither Restart nor a key set from Settings starts it; nor does the thread, which can't run.
  const restarted = await second.dispatch<CheckResult>('mcp-servers.restart', { server: docs!.id })
  expect(restarted.server).toMatchObject({ state: 'stopped', profileAllowed: false })
  await expect(second.call('thread.send', { thread: thread.id, text: 'again' })).rejects.toThrow(/allow it first/)
  // Nothing to wait for: a start would come after, if at all.
  await new Promise((r) => setTimeout(r, 300))
  expect(starts()).toBe(before)

  // Allowed, its next turn loads it, and it runs as the profile says now.
  await second.call('profile.allow', { cwd: project })
  await second.call('thread.send', { thread: thread.id, text: 'again' })
  await done(second, thread.id)
  expect(starts()).toBeGreaterThan(before)
  expect((await section(second)).profiles).toMatchObject([{ name: 'docs', profileAllowed: true }])

  // Its project gone, it's forgotten: no row, no cache.
  await rm(project, { recursive: true, force: true })
  const third = await second.restart()
  expect((await section(third)).profiles).toEqual([])
  expect(readdirSync(join(dir, 'mcp', 'cache')).filter((f) => f.startsWith('docs@'))).toEqual([])
  await third.close()
}, 90_000)
