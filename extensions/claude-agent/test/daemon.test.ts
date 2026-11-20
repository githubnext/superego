// A Claude Agent thread, end to end: a daemon with the extension, a profile that picks it, and the user's own `claude`
// (skipped where it isn't installed) talking to a mock Messages API instead of Anthropic's, so nothing needs an account
// or costs anything. `claude` is started through a wrapper that writes down the environment it was given (to check no
// Anthropic credential reached it), then points it at the mock with a key of the mock's, in a config folder of its own.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LiveState } from '@earendil-works/pi-durable'
import type { ThreadInfo } from '@superego/protocol'
import { testDaemon, type TestDaemon } from '@superego/sdk/testing'
import agentUi from '@superego/agent-ui/daemon'
import threadTools from '@superego/thread-tools/daemon'
import { threadReports } from '@superego/thread-reports/daemon'
import { claudeEnv } from '../src/claude.ts'
import { claudeAgent } from '../src/daemon.ts'
import { projectConfig, ProjectAllowances } from '../src/project.ts'
import { about, ALLOW, ANSWER, KEPT, WAITING, type Approval, type Kept, type ProjectFacts } from '../src/shared.ts'
import { mockAnthropic, type MockAnthropic } from './mock-anthropic.ts'

/** This checkout's `superego` command line. */
const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
/** Its `superego` skill, as the app's daemon gives it. */
const SKILL_DIR = fileURLToPath(new URL('../../../packages/cli/skill/', import.meta.url))

const claude = (() => {
  try { return execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined } catch { return undefined }
})()

/** A profile that picks Claude Agent, with `claudeAgent` choices and instructions of its own when given. */
const profileOf = (claudeAgent?: object, prompt?: string) => ({
  'profile.ts': `export default ${JSON.stringify({ agent: 'claude-agent', ...(claudeAgent ? { claudeAgent } : {}), ...(prompt ? { prompt } : {}) })}\n`,
})

// The tests' folders, where no one but this user can write all the way up: Claude Code reads `.mcp.json` from every
// folder above its own too, so a folder's settings under a shared one (the system's /tmp) can't be allowed (project.ts).
const SCRATCH = join(import.meta.dirname, '..', 'node_modules', '.tmp')
const scratch = (prefix: string) => { mkdirSync(SCRATCH, { recursive: true }); return mkdtempSync(join(SCRATCH, prefix)) }

describe.skipIf(!claude)("a Claude Agent thread, on the user's claude against a mock API", () => {
  let api: MockAnthropic
  let dir: string
  let daemon: TestDaemon | undefined
  const saved = { ...process.env }

  /**
   * A wrapper standing in for the user's `claude`: signed in to the mock (`signedIn`), or to nothing. Its config is a
   * folder of the test's own, or, given a `home`, that home's `~/.claude` (Claude Code's default), as the user's is.
   */
  function wrapper(name: string, signedIn: boolean, home?: string) {
    const file = join(dir, name)
    const key = signedIn ? 'ANTHROPIC_API_KEY=sk-ant-api03-mock ' : ''
    const config = home ? `HOME="${home}" ` : `CLAUDE_CONFIG_DIR="${dir}/config" `
    writeFileSync(file, `#!/bin/sh\nenv > "${dir}/env.$$"\nexec env ANTHROPIC_BASE_URL=${api.url} ${key}${config}CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "${claude}" "$@"\n`)
    chmodSync(file, 0o755)
    return file
  }
  const envs = () => readdirSync(dir).filter((f) => f.startsWith('env.')).map((f) => readFileSync(join(dir, f), 'utf8'))

  /**
   * A daemon with Claude Agent on the wrapper. `cli`: as the app's (its id `superego`, with its `superego` skill), and
   * this checkout's `superego` command line on the PATH Claude Code's Bash gets, pointed at this daemon.
   */
  async function start({ signedIn = true, profile = profileOf(), cli = false, home }: { signedIn?: boolean; profile?: Record<string, string>; cli?: boolean; home?: string } = {}) {
    const executable = wrapper(home ? 'claude-at-home' : signedIn ? 'claude' : 'claude-signed-out', signedIn, home)
    const bin = join(dir, 'bin')
    if (cli) {
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'superego'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`)
      chmodSync(join(bin, 'superego'), 0o755)
    }
    let made: TestDaemon | undefined
    const env = () => ({
      ...claudeEnv(),
      ...(cli && made ? { PATH: `${bin}:${process.env.PATH}`, SUPEREGO_SOCKET: made.socket, SUPEREGO_HOME: made.dataDir, SUPEREGO_APP: made.dataDir } : {}),
    })
    const extension = claudeAgent({ executable: async () => executable, env, ...(cli ? { skills: [SKILL_DIR] } : {}) })
    made = daemon = await testDaemon({
      extensions: [extension, agentUi, threadTools, threadReports({ quietMs: 50, maxMs: 200 })], profile,
      ...(cli ? { appId: 'superego' } : {}),
    } as Parameters<typeof testDaemon>[0])
    return daemon
  }
  /** A folder of the test's own to work in: what one thread allows "always" stays out of the others'. */
  const folder = () => {
    const cwd = mkdtempSync(join(dir, 'work-'))
    writeFileSync(join(cwd, 'notes.txt'), 'The answer is 42.\n')
    return cwd
  }
  const live = async (d: TestDaemon, thread: string) => (await d.call<{ value: { docs: Record<string, unknown> } }>('thread.watch', { thread })).value.docs['pi.live'] as LiveState | undefined
  /** Send without waiting for the run: what it asks is the test's to answer. */
  const ask = async (d: TestDaemon, thread: ThreadInfo, text: string) => {
    const waiting = await d.watch<Approval[]>(WAITING, { scope: thread.id })
    await d.call('thread.send', { thread: thread.id, text })
    const [approval] = await waiting.until((list) => list.length > 0, 'an approval')
    return { approval: approval!, waiting }
  }

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
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
    rmSync(join(dir, 'config', 'settings.json'), { force: true })
  })

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
    const d = await start({ signedIn: false })
    const failed = await d.thread('Say hi', { cwd: dir })
    expect(failed.status.state).toBe('error')
    expect(JSON.stringify(failed.status)).toContain('Not logged in · run `claude` and `/login`')
  }, 60_000)

  it("runs a folder's own Claude Code settings (hooks, MCP servers) only once allowed as they are, and says so", async () => {
    // A profile that asks for them all narrows what's allowed, and adds nothing to it.
    const d = await start({ profile: profileOf({ settingSources: ['user', 'project', 'local'] }) })
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

  describe('approvals', () => {
    it('blocks the thread on a permission while Claude Code asks, and Allow lets the call run', async () => {
      const d = await start()
      const cwd = folder()
      const thread = await d.thread(undefined, { cwd })
      const { approval, waiting } = await ask(d, thread, 'Run touch allowed.txt')
      expect(approval).toMatchObject({ tool: 'Bash', title: 'Bash: touch allowed.txt', thread: thread.id })
      expect((await d.info(thread)).status).toEqual({ state: 'blocked', kind: 'permission', msg: 'Bash: touch allowed.txt' })
      // Its row is there while it waits, drawn as running.
      const [call] = await d.toolCalls(thread)
      expect(call).toMatchObject({ id: approval.id, name: 'bash', args: { command: 'touch allowed.txt' } })
      expect(call!.result).toBeUndefined()
      expect((await live(d, thread.id))?.tools?.map((s) => s.callId)).toEqual([approval.id])

      await expect(d.dispatch(ANSWER, { id: 'nope', choice: 'allow' })).rejects.toMatchObject({ kind: 'not_found' })
      await d.dispatch(ANSWER, { id: approval.id, choice: 'allow' })
      await waiting.until((list) => list.length === 0, 'nothing waiting')
      const done = await d.idle(thread)
      expect(done.status.state).toBe('done')
      expect(existsSync(join(cwd, 'allowed.txt'))).toBe(true)
      expect((await d.toolCalls(thread))[0]!.result).toMatchObject({ isError: false })
    }, 60_000)

    it('Deny refuses the call, with what the user said', async () => {
      const d = await start()
      const cwd = folder()
      const thread = await d.thread(undefined, { cwd })
      const { approval } = await ask(d, thread, 'Run touch denied.txt')
      await d.dispatch(ANSWER, { id: approval.id, choice: 'deny', message: 'not in this folder' })
      expect((await d.idle(thread)).status.state).toBe('done')
      expect(existsSync(join(cwd, 'denied.txt'))).toBe(false)
      const [call] = await d.toolCalls(thread)
      expect(call!.result).toMatchObject({ isError: true })
      expect(call!.result!.text).toContain('not in this folder')
    }, 60_000)

    it('"Always" allows it, and Superego remembers it for the folder: the same call goes ahead next time without asking', async () => {
      const d = await start()
      const cwd = folder()
      const thread = await d.thread(undefined, { cwd })
      const { approval } = await ask(d, thread, 'Run touch always.txt')
      expect(approval.always).toMatch(/^Always allow /)
      await d.dispatch(ANSWER, { id: approval.id, choice: 'always' })
      expect((await d.idle(thread)).status.state).toBe('done')
      expect(existsSync(join(cwd, 'always.txt'))).toBe(true)
      // Superego keeps it, not the folder's own settings (which load only once allowed, and would change by it).
      expect(existsSync(join(cwd, '.claude'))).toBe(false)
      rmSync(join(cwd, 'always.txt'))
      const again = await d.send(thread, 'Run touch always.txt')
      expect(again.status.state).toBe('done')
      expect(existsSync(join(cwd, 'always.txt'))).toBe(true)
    }, 60_000)

    it('Stop withdraws what waits, and closes its call', async () => {
      const d = await start()
      const cwd = folder()
      const thread = await d.thread(undefined, { cwd })
      const { approval, waiting } = await ask(d, thread, 'Run touch stopped.txt')
      await d.call('thread.stop', { thread: thread.id })
      await waiting.until((list) => list.length === 0, 'the approval withdrawn')
      const stopped = await d.idle(thread)
      expect(stopped.status.state).not.toBe('blocked')
      expect(existsSync(join(cwd, 'stopped.txt'))).toBe(false)
      await expect(d.dispatch(ANSWER, { id: approval.id, choice: 'allow' })).rejects.toMatchObject({ kind: 'not_found' })
      expect((await d.toolCalls(thread))[0]!.result).toMatchObject({ isError: true, text: 'Stopped' })
      // It goes on afterwards.
      expect((await d.send(thread, 'Say hi')).status.state).toBe('done')
    }, 60_000)

    it('after a restart, an approval that was waiting is interrupted: send again', async () => {
      const d = await start()
      const cwd = folder()
      const thread = await d.thread(undefined, { cwd })
      const { approval } = await ask(d, thread, 'Run touch restarted.txt')
      await d.restart()
      const after = await d.idle(thread)
      expect(after.status.state).toBe('error')
      expect(JSON.stringify(after.status)).toContain('Send again')
      expect(existsSync(join(cwd, 'restarted.txt'))).toBe(false)
      const [call] = await d.toolCalls(thread)
      expect(call).toMatchObject({ id: approval.id, result: { isError: true } })
      expect(call!.result!.text).toMatch(/^Interrupted: .*Send again/)
      expect((await d.watch<Approval[]>(WAITING, { scope: thread.id })).value).toEqual([])
    }, 60_000)

    it('asks Claude Code\'s questions through the question card, and answers them as it expects', async () => {
      const d = await start()
      const thread = await d.thread(undefined, { cwd: folder() })
      const questions = await d.watch<{ id: string; tool: string; question: string; options: { label: string }[] }[]>('agent-ui.waiting', { scope: thread.id })
      await d.call('thread.send', { thread: thread.id, text: 'Ask me' })
      const [question] = await questions.until((list) => list.length > 0, 'the question')
      expect(question).toMatchObject({ tool: 'ask_user', options: [{ label: 'Red' }, { label: 'Blue' }] })
      expect(question!.question).toMatch(/Colour[\s\S]*Which colour\?$/)
      expect((await d.info(thread)).status).toMatchObject({ state: 'blocked', kind: 'question' })
      await d.dispatch('agent-ui.answer', { id: question!.id, text: 'Blue' })
      const done = await d.idle(thread)
      expect(done.status.state).toBe('done')
      // Claude Code told its model what was picked, for the question it asked.
      const told = (await d.toolCalls(thread)).find((c) => c.name === 'AskUserQuestion')!
      expect(told.result).toMatchObject({ isError: false })
      expect(told.result!.text).toContain('Which colour?')
      expect(told.result!.text).toContain('Blue')
    }, 60_000)

    it('shows a plan to approve (ExitPlanMode), and goes on once it is', async () => {
      const d = await start({ profile: profileOf({ permissionMode: 'plan' }) })
      const thread = await d.thread(undefined, { cwd: folder() })
      const { approval } = await ask(d, thread, 'Plan it')
      expect(approval).toMatchObject({ tool: 'ExitPlanMode', title: 'Plan: Tidy up', plan: expect.stringContaining('Remove the old file') })
      await d.dispatch(ANSWER, { id: approval.id, choice: 'allow' })
      expect((await d.idle(thread)).status.state).toBe('done')
      expect((await d.toolCalls(thread)).find((c) => c.name === 'ExitPlanMode')!.result).toMatchObject({ isError: false })
    }, 60_000)

    it('applies bypassPermissions only when the profile says so, not from Claude Code\'s own settings', async () => {
      mkdirSync(join(dir, 'config'), { recursive: true })
      writeFileSync(join(dir, 'config', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      const d = await start()
      const cwd = folder()
      const thread = await d.thread(undefined, { cwd })
      const { approval } = await ask(d, thread, 'Run touch asked.txt')
      expect(approval.tool).toBe('Bash')
      await d.dispatch(ANSWER, { id: approval.id, choice: 'deny' })
      await d.idle(thread)
      await d.close()

      const bypassing = await start({ profile: profileOf({ permissionMode: 'bypassPermissions' }) })
      const other = await bypassing.thread(undefined, { cwd })
      const done = await bypassing.send(other, 'Run touch bypassed.txt')
      expect(done.status.state).toBe('done')
      expect(existsSync(join(cwd, 'bypassed.txt'))).toBe(true)
    }, 60_000)
  })

  describe("Superego's tools, bound to the thread", () => {
    it('thread_start starts a child of the calling thread, whose report comes back to it', async () => {
      const d = await start()
      const parent = await d.thread(undefined, { cwd: folder() })
      const done = await d.send(parent, 'Use thread_start {"prompt":"Say hi","title":"Its child"}')
      expect(done.status.state).toBe('done')
      const child = (await d.call<ThreadInfo[]>('thread.list', {})).find((t) => t.title === 'Its child')
      expect(child).toMatchObject({ parent: parent.id, cwd: parent.cwd })
      // Its row is thread_start's, as a Superego thread's is, with its result.
      const call = (await d.toolCalls(parent)).find((c) => c.name === 'thread_start')!
      expect(call.result!.text).toContain(`thread:${child!.id}`)
      // The child's report comes back to its parent, as its next message.
      await d.until(async () => (await d.transcript(parent)).includes(`From [Its child](thread:${child!.id}): finished.`), 'the report', 20_000)
    }, 60_000)

    it('pane_open opens a pane beside the calling thread', async () => {
      const d = await start()
      const thread = await d.thread(undefined, { cwd: folder() })
      const done = await d.send(thread, 'Use pane_open {"kind":"editor","params":{"path":"notes.txt"}}')
      expect(done.status.state).toBe('done')
      expect((await d.info(thread)).panes).toMatchObject([{ kind: 'editor', params: { path: 'notes.txt' } }])
    }, 60_000)

    it("appends Superego's prompt to Claude Code's: its tools a line each, its sections and the profile's instructions", async () => {
      const d = await start({ profile: profileOf(undefined, 'Always answer in haiku.') })
      const before = api.requests.length
      await d.thread('Say hi', { cwd: folder() })
      const system = api.requests.slice(before).map((r) => r.system).find((s) => s.includes('superego_tools'))
      expect(system).toBeDefined()
      // Claude Code's own prompt is kept, with Superego's after it.
      expect(system!.indexOf('Claude')).toBeLessThan(system!.indexOf('superego_tools'))
      expect(system).toContain('mcp__superego__<name>')
      expect(system).toMatch(/^- thread_start: Start a thread of its own/m)
      expect(system).toMatch(/^- pane_open: /m)
      expect(system).toMatch(/^- ask_user: /m)
      expect(system).toContain('<panes>')
      expect(system).toContain('<threads>')
      expect(system).toContain('<instructions>\nAlways answer in haiku.\n</instructions>')
    }, 60_000)
  })

  describe("Superego's skill and command line", () => {
    const bypass = profileOf({ permissionMode: 'bypassPermissions' })
    /** The messages of a thread's that came from another thread (`from`, its id), by their text. */
    const fromOf = async (d: TestDaemon, thread: string) => {
      const { sub, value } = await d.call<{ sub: string; value: { entries: { data?: { from?: string } }[] } }>('thread.watch', { thread })
      await d.call('unwatch', { sub })
      return value.entries.flatMap((e) => e.data?.from ? [e.data.from] : [])
    }

    it("gives Claude Code the superego skill, as a plugin of the daemon's", async () => {
      const d = await start({ cli: true })
      const before = api.requests.length
      expect((await d.thread('Say hi', { cwd: folder() })).status.state).toBe('done')
      const said = JSON.stringify(api.requests.slice(before).map((r) => [r.system, r.messages]))
      // Claude Code tells its model of the skill (by its plugin's name), and Superego's prompt of the command line.
      expect(said).toContain('superego:superego')
      expect(said).toContain('superego_cli')
      // The plugin is the daemon's, linking the skill of the build it runs.
      expect(realpathSync(join(d.dataDir, 'claude-agent', 'plugin', 'skills', 'superego'))).toBe(realpathSync(SKILL_DIR))
    }, 60_000)

    it("leaves the user's ~/.claude alone", async () => {
      const home = mkdtempSync(join(dir, 'home-'))
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), '{"theme":"dark"}\n')
      const d = await start({ cli: true, home })
      const cwd = folder()
      const before = api.requests.length
      expect((await d.thread('Say hi', { cwd })).status.state).toBe('done')
      // It had the skill, with its own config at ~/.claude (its sessions are there)…
      expect(JSON.stringify(api.requests.slice(before).map((r) => [r.system, r.messages]))).toContain('superego:superego')
      expect(existsSync(join(home, '.claude', 'projects'))).toBe(true)
      // …without Superego writing a skill or a plugin there, or in the thread's folder.
      expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n')
      expect(existsSync(join(home, '.claude', 'skills'))).toBe(false)
      // (Its sessions are kept by the folder's path, which may say superego: the tests' folders are in this checkout.)
      const written = readdirSync(join(home, '.claude'), { recursive: true }).map(String).filter((path) => !path.startsWith('projects'))
      expect(JSON.stringify(written)).not.toMatch(/superego/)
      expect(existsSync(join(cwd, '.claude'))).toBe(false)
    }, 60_000)

    it('`superego` in its Bash runs as the thread: a child of it with --parent "$SUPEREGO_THREAD", what it starts and sends signed from it', async () => {
      const d = await start({ cli: true, profile: bypass })
      const parent = await d.thread(undefined, { cwd: folder() })
      const marked = await d.send(parent, 'Run echo "thread=$SUPEREGO_THREAD"')
      expect(marked.status.state).toBe('done')
      expect((await d.toolCalls(parent)).at(-1)!.result!.text).toContain(`thread=${parent.id}`)

      const child = await d.send(parent, 'Run superego do thread.start --parent "$SUPEREGO_THREAD" --title "Its child" --prompt "Say hi"')
      expect(child.status.state).toBe('done')
      const made = (await d.call<ThreadInfo[]>('thread.list', {})).find((t) => t.title === 'Its child')
      expect(made).toMatchObject({ parent: parent.id })
      expect(await fromOf(d, made!.id)).toEqual([parent.id])

      const started = await d.send(parent, 'Run superego start -p "Say hello"')
      expect(started.status.state).toBe('done')
      const other = (await d.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id !== parent.id && t.id !== made!.id)!
      expect(await fromOf(d, other.id)).toEqual([parent.id])

      await d.idle(made!)
      const sent = await d.send(parent, `Run superego send ${made!.id} Hello again`)
      expect(sent.status.state).toBe('done')
      await d.until(async () => (await fromOf(d, made!.id)).length === 2, 'the message, signed', 20_000)
    }, 120_000)
  })

  it("nests a subagent's steps under its Agent call", async () => {
    const d = await start()
    const cwd = folder()
    const thread = await d.thread(undefined, { cwd })
    const done = await d.send(thread, `Delegate Read ${join(cwd, 'notes.txt')}`)
    expect(done.status.state).toBe('done')
    const calls = await d.toolCalls(thread)
    // The subagent's Read isn't a step of the thread's own…
    expect(calls.map((c) => c.name)).toEqual(['Agent'])
    // …but of its Agent call's, kept with the thread (it may run on after its call returned).
    const kept = await d.watch<Kept>(KEPT, { scope: thread.id })
    const { steps, results: stepResults, status } = (await kept.until((all) => all.subagents?.[calls[0]!.id]?.status === 'completed', 'the subagent done')).subagents![calls[0]!.id]!
    expect(status).toBe('completed')
    const read = steps.find((s) => s.type === 'toolCall')
    expect(read).toMatchObject({ type: 'toolCall', name: 'read', arguments: { path: join(cwd, 'notes.txt') } })
    expect(stepResults[(read as { id: string }).id]!.text).toContain('The answer is 42.')
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
