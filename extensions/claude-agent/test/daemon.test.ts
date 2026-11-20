// A Claude Agent thread, end to end: a daemon with the extension, a profile that picks it, and the user's own `claude`
// (skipped where it isn't installed) talking to a mock Messages API instead of Anthropic's, so nothing needs an account
// or costs anything. `claude` is started through a wrapper that writes down the environment it was given (to check no
// Anthropic credential reached it), then points it at the mock with a key of the mock's, in a config folder of its own.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LiveState } from '@earendil-works/pi-durable'
import { testDaemon, type TestDaemon } from '@superego/sdk/testing'
import { claudeEnv } from '../src/claude.ts'
import { claudeAgent } from '../src/daemon.ts'
import { projectConfig, ProjectAllowances } from '../src/project.ts'
import { about, ALLOW, type ProjectFacts } from '../src/shared.ts'
import { mockAnthropic, type MockAnthropic } from './mock-anthropic.ts'

const claude = (() => {
  try { return execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined } catch { return undefined }
})()

const PROFILE = { 'profile.ts': "export default { agent: 'claude-agent' }\n" }

// The tests' folders, where no one but this user can write all the way up: Claude Code reads `.mcp.json` from every
// folder above its own too, so a folder's settings under a shared one (the system's /tmp) can't be allowed (project.ts).
const SCRATCH = join(import.meta.dirname, '..', 'node_modules', '.tmp')
const scratch = (prefix: string) => { mkdirSync(SCRATCH, { recursive: true }); return mkdtempSync(join(SCRATCH, prefix)) }

describe.skipIf(!claude)("a Claude Agent thread, on the user's claude against a mock API", () => {
  let api: MockAnthropic
  let dir: string
  let daemon: TestDaemon | undefined
  const saved = { ...process.env }

  /** A wrapper standing in for the user's `claude`: signed in to the mock (`signedIn`), or to nothing. */
  function wrapper(name: string, signedIn: boolean) {
    const file = join(dir, name)
    const key = signedIn ? 'ANTHROPIC_API_KEY=sk-ant-api03-mock ' : ''
    writeFileSync(file, `#!/bin/sh\nenv > "${dir}/env.$$"\nexec env ANTHROPIC_BASE_URL=${api.url} ${key}CLAUDE_CONFIG_DIR="${dir}/config" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "${claude}" "$@"\n`)
    chmodSync(file, 0o755)
    return file
  }
  const envs = () => readdirSync(dir).filter((f) => f.startsWith('env.')).map((f) => readFileSync(join(dir, f), 'utf8'))

  async function start(signedIn = true) {
    const executable = wrapper(signedIn ? 'claude' : 'claude-signed-out', signedIn)
    daemon = await testDaemon({ extensions: [claudeAgent({ executable: async () => executable })], profile: PROFILE })
    return daemon
  }
  const live = async (d: TestDaemon, thread: string) => (await d.call<{ value: { docs: Record<string, unknown> } }>('thread.watch', { thread })).value.docs['pi.live'] as LiveState | undefined

  beforeAll(async () => { api = await mockAnthropic() })
  afterAll(async () => { await api.close() })
  beforeAll(() => {
    dir = scratch('claude-agent-')
    writeFileSync(join(dir, 'notes.txt'), 'The answer is 42.\n')
    // What a daemon started from a shell with credentials has: none of it may reach `claude`.
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-api03-not-for-claude', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_OAUTH_TOKEN: 'oat', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })
  })
  afterAll(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('runs a turn: the answer streamed in and kept, the thread done; the next turn resumes its session', async () => {
    const d = await start()
    const thread = await d.thread(undefined, { cwd: dir })
    const done = await d.send(thread, 'Say hi')
    expect(done.status.state).toBe('done')
    const saw = (msg: string | undefined) => Number(/^OK \(mock saw (\d+) messages\)$/.exec(msg ?? '')?.[1])
    const first = saw(done.status.msg)
    expect(first).toBeGreaterThan(0)
    const again = await d.send(thread, 'Again')
    // The second turn carried the first's history (its prompt and answer too): the session resumed.
    expect(saw(again.status.msg)).toBeGreaterThan(first + 1)
    const transcript = await d.transcript(thread)
    expect(transcript).toContain(done.status.msg)
    expect(transcript).toContain('"provider":"claude-agent"')
  }, 60_000)

  it('gives a tool call its row, as Superego names the tool, with its result', async () => {
    const d = await start()
    const thread = await d.thread(undefined, { cwd: dir })
    const done = await d.send(thread, `Read ${join(dir, 'notes.txt')}`)
    expect(done.status.state).toBe('done')
    const [call] = await d.toolCalls(thread)
    expect(call).toMatchObject({ name: 'read', args: { path: join(dir, 'notes.txt') }, result: { isError: false } })
    expect(call!.result!.text).toContain('The answer is 42.')
  }, 60_000)

  it('runs `claude` without the daemon\'s Anthropic credentials', async () => {
    const d = await start()
    await d.thread('Say hi', { cwd: dir })
    const seen = envs()
    expect(seen.length).toBeGreaterThan(0)
    for (const env of seen) {
      expect(env).not.toMatch(/^ANTHROPIC_/m)
      expect(env).not.toMatch(/^CLAUDE_CODE_OAUTH_TOKEN=/m)
      expect(env).not.toContain('sk-ant-api03-not-for-claude')
    }
  }, 60_000)

  it("fails with Claude Code's word when it isn't signed in", async () => {
    const d = await start(false)
    const failed = await d.thread('Say hi', { cwd: dir })
    expect(failed.status.state).toBe('error')
    expect(JSON.stringify(failed.status)).toContain('Not logged in · run `claude` and `/login`')
  }, 60_000)

  it("runs a folder's own Claude Code settings (hooks, MCP servers) only once allowed as they are, and says so", async () => {
    const d = await start()
    const repo = join(dir, 'repo')
    const ran = (what: string) => existsSync(join(dir, `${what}-ran`))
    const settings = (hook: string) => writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${dir}/${hook}-ran` }] }] },
      enableAllProjectMcpServers: true,
    }))
    mkdirSync(join(repo, '.claude'), { recursive: true })
    settings('hook')
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { repo: { command: 'sh', args: ['-c', `touch ${dir}/mcp-ran; sleep 2`] } } }))
    const facts = async (thread: { id: string }) => (await d.info(thread)).facts?.[about.name] as ProjectFacts | undefined

    // Not allowed: the thread says so before its first turn, and the turn runs without them.
    const thread = await d.thread(undefined, { cwd: repo })
    expect(await facts(thread)).toMatchObject({ files: ['.claude/settings.json', '.mcp.json'], allowed: false, changed: false })
    expect((await d.send(thread, 'Say hi')).status.state).toBe('done')
    expect([ran('hook'), ran('mcp')]).toEqual([false, false])

    // Allowed as shown: the next turn loads them.
    const { hash } = (await facts(thread))!
    await d.call('action.run', { id: ALLOW, params: { cwd: repo, hash } })
    expect(await facts(thread)).toMatchObject({ allowed: true })
    expect((await d.send(thread, 'Again')).status.state).toBe('done')
    expect([ran('hook'), ran('mcp')]).toEqual([true, true])

    // Changed since: not loaded again until allowed again, and a stale hash doesn't allow it.
    settings('changed')
    expect((await d.send(thread, 'Once more')).status.state).toBe('done')
    expect(ran('changed')).toBe(false)
    expect(await facts(thread)).toMatchObject({ allowed: false, changed: true })
    await expect(d.call('action.run', { id: ALLOW, params: { cwd: repo, hash } })).rejects.toMatchObject({ kind: 'changed' })
  }, 60_000)

  it('streams the answer as it comes, and Stop interrupts it, keeping what it said', async () => {
    const d = await start()
    const thread = await d.thread(undefined, { cwd: dir })
    await d.call('thread.send', { thread: thread.id, text: 'Wait for me' })
    const hold = await api.held()
    await d.until(async () => ((await live(d, thread.id))?.generation?.message as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text === 'Working on it', 'the partial answer', 10_000)
    expect((await d.info(thread)).status.state).toBe('working')
    await d.call('thread.stop', { thread: thread.id })
    await hold.dropped
    const stopped = await d.idle(thread)
    expect(stopped.status.state).not.toBe('working')
    expect(await d.transcript(thread)).toContain('Working on it')
    // It goes on afterwards.
    expect((await d.send(thread, 'Say hi')).status.state).toBe('done')
  }, 60_000)
})

describe("claude's environment", () => {
  it('has no Anthropic or Claude Code credentials, nor the daemon\'s own variables', () => {
    const env = claudeEnv({
      PATH: '/bin', HOME: '/home/me', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_OAUTH_TOKEN: 'o', ANTHROPIC_BASE_URL: 'u',
      CLAUDE_CODE_OAUTH_TOKEN: 'c', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', AWS_BEARER_TOKEN_BEDROCK: 'b', ELECTRON_RUN_AS_NODE: '1',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me' })
  })
})

describe("a folder's own Claude Code configuration", () => {
  let root: string
  beforeAll(() => { root = scratch('claude-project-') })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const write = (path: string, text = '{}') => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }

  it("is its .claude/ and every .mcp.json from it up: not the user's own, nor Claude Code's checkouts", () => {
    const user = join(root, 'home', '.claude')
    write('home/.claude/settings.json')
    expect(projectConfig(join(root, 'home'), user)).toBeUndefined()
    write('.mcp.json')
    write('repo/.claude/settings.json')
    write('repo/.claude/settings.local.json')
    write('repo/.claude/hooks/start.sh', 'echo hi')
    write('repo/.claude/worktrees/feature/.claude/settings.json')
    write('repo/.claude/hooks/node_modules/x.js')
    write('repo/CLAUDE.md', 'notes')
    symlinkSync(join(root, 'repo', '.claude', 'hooks'), join(root, 'repo', '.claude', 'again'))
    const config = projectConfig(join(root, 'repo'), user)!
    expect(config.files).toEqual(['.claude/again/start.sh', '.claude/settings.json', '.claude/settings.local.json', join(root, '.mcp.json')])
    write('repo/.claude/hooks/start.sh', 'echo changed')
    const changed = projectConfig(join(root, 'repo'), user)!.hash
    expect(changed).not.toBe(config.hash)
    // What isn't in it changes nothing.
    write('repo/CLAUDE.md', 'other notes')
    write('repo/.claude/worktrees/feature/.claude/settings.json', '{"x":1}')
    expect(projectConfig(join(root, 'repo'), user)!.hash).toBe(changed)
    expect(config.unsafe).toBeUndefined()
  })

  it("can't be allowed where another user could change what Claude Code loads: a folder above it, or a file", async () => {
    write('shared/repo/.claude/settings.json')
    chmodSync(join(root, 'shared'), 0o777)
    const under = projectConfig(join(root, 'shared', 'repo'))!
    expect(under.unsafe).toBe(join(root, 'shared'))
    write('own/repo/.claude/settings.json')
    write('own/.mcp.json')
    chmodSync(join(root, 'own', '.mcp.json'), 0o666)
    const writable = projectConfig(join(root, 'own', 'repo'))!
    expect(writable.unsafe).toBe(join(root, 'own', '.mcp.json'))

    const allowances = new ProjectAllowances(join(root, 'allowed.json'))
    await allowances.allow(under)
    expect(allowances.allowed(under)).toBe(false)
    const d = await testDaemon({ extensions: [claudeAgent({ executable: async () => '/bin/false' })] })
    try {
      await expect(d.call('action.run', { id: ALLOW, params: { cwd: join(root, 'own', 'repo'), hash: writable.hash } })).rejects.toMatchObject({ kind: 'unsafe' })
    } finally { await d.close() }
  })
})
