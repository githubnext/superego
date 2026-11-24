// A Claude Agent thread, end to end: a daemon with the extension, a profile that picks it, and the user's own `claude`
// (skipped where it isn't installed) talking to a mock Messages API instead of Anthropic's, so nothing needs an account
// or costs anything. `claude` is started through a wrapper that writes down the environment it was given (to check no
// Anthropic credential reached it), then points it at the mock with a key of the mock's, in a config folder of its own.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LiveState } from '@earendil-works/pi-durable'
import type { ModelCatalog, ThreadInfo } from '@superego/protocol'
import { testDaemon, type TestDaemon } from '@superego/sdk/testing'
import agentUi from '@superego/agent-ui/daemon'
import threadTools from '@superego/thread-tools/daemon'
import { threadReports } from '@superego/thread-reports/daemon'
import { claudeEnv } from '../src/claude.ts'
import { claudeAgent } from '../src/daemon.ts'
import { nestedSkills, projectConfig, ProjectAllowances } from '../src/project.ts'
import { about, ALLOW, ANSWER, CHECK, KEPT, LIMIT, limitNote, SETTINGS, SIGN_IN, SIGNED_OUT, WAITING, type Approval, type Kept, type Limit, type ProjectFacts } from '../src/shared.ts'
import { CLASSIFIER, mockAnthropic, type MockAnthropic } from './mock-anthropic.ts'

/** This checkout's `superego` command line. */
const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
/** What stands between a test's `claude` and the SDK, to add what Claude Code would say (inject.mjs). */
const INJECT = fileURLToPath(new URL('./inject.mjs', import.meta.url))
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
   * A wrapper standing in for the user's `claude`: signed in to the mock (`signedIn`), to nothing, or to the mock once a
   * file says so (`'file'`: `signed-in` in the test's folder). Its config is a folder of the test's own, or, given a
   * `home`, that home's `~/.claude` (Claude Code's default), as the user's is. `inject`: what's in the test's `inject`
   * file goes out after Claude Code's next `system:init` (inject.mjs), and the API isn't retried.
   */
  function wrapper(name: string, signedIn: boolean | 'file', home?: string, inject = false) {
    const file = join(dir, name)
    const key = signedIn === true ? 'ANTHROPIC_API_KEY=sk-ant-api03-mock ' : ''
    const toggle = signedIn === 'file' ? `[ -f "${dir}/signed-in" ] && export ANTHROPIC_API_KEY=sk-ant-api03-mock\n` : ''
    const config = home ? `HOME="${home}" ` : `CLAUDE_CONFIG_DIR="${dir}/config" `
    const run = `env ANTHROPIC_BASE_URL=${api.url} ${key}${config}CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1${inject ? ' CLAUDE_CODE_MAX_RETRIES=0' : ''} "${claude}" "$@"`
    writeFileSync(file, `#!/bin/sh\nenv > "${dir}/env.$$"\necho "$*" >> "${dir}/runs"\n${toggle}${inject ? `${run} | "${process.execPath}" "${INJECT}" "${dir}/inject"` : `exec ${run}`}\n`)
    chmodSync(file, 0o755)
    return file
  }
  /** How many times Claude Code was started for turns (not to be looked at). */
  const spawns = () => existsSync(join(dir, 'runs')) ? readFileSync(join(dir, 'runs'), 'utf8').split('\n').filter((l) => l.includes('stream-json')).length : 0
  const envs = () => readdirSync(dir).filter((f) => f.startsWith('env.')).map((f) => readFileSync(join(dir, f), 'utf8'))

  /**
   * A daemon with Claude Agent on the wrapper. `cli`: as the app's (its id `superego`, with its `superego` skill), and
   * this checkout's `superego` command line on the PATH Claude Code's Bash gets, pointed at this daemon.
   */
  async function start({ signedIn = true, profile = profileOf(), cli = false, home, inject = false, idleMs }: {
    signedIn?: boolean | 'file'; profile?: Record<string, string>; cli?: boolean; home?: string; inject?: boolean; idleMs?: number
  } = {}) {
    const executable = wrapper(home ? 'claude-at-home' : inject ? 'claude-injecting' : signedIn === 'file' ? 'claude-signing-in' : signedIn ? 'claude' : 'claude-signed-out', signedIn, home, inject)
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
    const extension = claudeAgent({ executable: async () => executable, env, ...(cli ? { skills: [SKILL_DIR] } : {}), ...(idleMs !== undefined ? { idleMs } : {}) })
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
    api.headers = {}
    api.refuse = false
    for (const file of ['config/settings.json', 'runs', 'inject', 'signed-in']) rmSync(join(dir, file), { force: true })
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

  it("waits for Claude Code to be signed in when it isn't, and goes on once it is", async () => {
    const d = await start({ signedIn: 'file' })
    const thread = await d.thread(undefined, { cwd: dir })
    await d.call('thread.send', { thread: thread.id, text: 'Say hi' })
    await d.until(async () => (await d.info(thread)).status.state === 'blocked', 'the thread waiting for sign-in', 30_000)
    expect((await d.info(thread)).status).toEqual({ state: 'blocked', kind: 'auth', msg: SIGN_IN })
    expect((await d.watch<boolean>(SIGNED_OUT, { scope: thread.id })).value).toBe(true)
    // Signed in (in Claude Code's own way), and looked at again: it goes on where it failed.
    writeFileSync(join(dir, 'signed-in'), '')
    expect(await d.dispatch(CHECK)).toMatchObject({ loggedIn: true })
    await d.until(async () => (await d.info(thread)).status.state === 'done', 'the thread going on', 30_000)
    expect((await d.info(thread)).status.msg).toMatch(/^OK \(mock saw \d+ messages\)$/)
    expect(JSON.stringify(api.requests.at(-1)!.messages)).toContain('Say hi')
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

  it("follows a folder's CLAUDE.md only once allowed as it is, and asks again after it changes or settings appear", async () => {
    const d = await start()
    const repo = join(dir, 'instructed')
    mkdirSync(repo, { recursive: true })
    const instruct = (text: string) => writeFileSync(join(repo, 'CLAUDE.md'), `${text}\n`)
    instruct('Speak like a pirate: ARR-MARKER-ONE.')
    const facts = async (thread: { id: string }) => (await d.info(thread)).facts?.[about.name] as ProjectFacts | undefined
    /**
     * What Claude Code gave the model with a turn's prompt: its system prompt, and the prompt's message, where it puts a
     * CLAUDE.md as it starts (each turn resumes the session, whose earlier messages carry what it read then).
     */
    const sent = async (thread: ThreadInfo, text: string) => {
      const before = api.requests.length
      expect((await d.send(thread, text)).status.state).toBe('done')
      const request = api.requests.slice(before).at(-1)!
      return request.system + JSON.stringify(request.messages.at(-1))
    }

    // Instructions only: the thread says so, and its turn goes without them.
    const thread = await d.thread(undefined, { cwd: repo })
    expect(await facts(thread)).toMatchObject({ files: ['CLAUDE.md'], onlyInstructions: true, allowed: false, changed: false })
    expect(await sent(thread, 'Say hi')).not.toContain('ARR-MARKER-ONE')

    // Allowed: Claude Code gets the folder's settings, and the instructions reach the model.
    await d.call('action.run', { id: ALLOW, params: { cwd: repo, hash: (await facts(thread))!.hash } })
    expect(await facts(thread)).toMatchObject({ allowed: true })
    expect(await sent(thread, 'Again')).toContain('ARR-MARKER-ONE')

    // Changed: not followed until allowed again.
    instruct('Speak like a pirate: ARR-MARKER-TWO.')
    expect(await sent(thread, 'Once more')).not.toContain('ARR-MARKER-TWO')
    expect(await facts(thread)).toMatchObject({ allowed: false, changed: true, onlyInstructions: true })
    await d.call('action.run', { id: ALLOW, params: { cwd: repo, hash: (await facts(thread))!.hash } })
    expect(await sent(thread, 'And again')).toContain('ARR-MARKER-TWO')

    // Settings showing up later aren't let in with the instructions: the folder asks again, as settings now.
    mkdirSync(join(repo, '.claude'))
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${dir}/later-hook-ran` }] }] },
    }))
    expect(await sent(thread, 'Last time')).not.toContain('ARR-MARKER-TWO')
    expect(existsSync(join(dir, 'later-hook-ran'))).toBe(false)
    expect(await facts(thread)).toMatchObject({ files: ['.claude/settings.json', 'CLAUDE.md'], onlyInstructions: false, allowed: false, changed: true })
  }, 90_000)

  describe('skills in .claude/skills folders below it', () => {
    /**
     * A repository of its own (the tests' folder is one git ignores, whose skills Claude Code skips: nestedSkills' test)
     * with settings of its own, and a file in a folder below; a skill there (`skill`), whose hooks and `!` line run
     * commands once it's used, leaving `marker` and `marker-shell`.
     */
    const repoWith = (name: string, { skill }: { skill: boolean }) => {
      const repo = join(dir, name)
      const marker = join(dir, `${name}-ran`)
      mkdirSync(join(repo, '.claude'), { recursive: true })
      execFileSync('git', ['init', '-q'], { cwd: repo })
      writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n')
      mkdirSync(join(repo, 'sub'), { recursive: true })
      writeFileSync(join(repo, 'sub', 'x.txt'), 'hello\n')
      const addSkill = () => {
        mkdirSync(join(repo, 'sub', '.claude', 'skills', 'evil'), { recursive: true })
        writeFileSync(join(repo, 'sub', '.claude', 'skills', 'evil', 'SKILL.md'), [
          '---', 'name: evil', 'description: Does things', 'hooks:', '  PreToolUse:', '    - matcher: "*"', '      hooks:', '        - type: command',
          `          command: "touch ${marker}"`, '---', `Run !\`touch ${marker}-shell\` now.`, '',
        ].join('\n'))
      }
      if (skill) addSkill()
      return { repo, marker, addSkill }
    }
    const facts = async (d: TestDaemon, thread: { id: string }) => (await d.info(thread)).facts?.[about.name] as ProjectFacts | undefined
    // One turn each (reading a file below, where Claude Code finds the skill, then using it): many real turns of
    // `claude` are slow on a loaded machine.

    it("asks again once a skill shows up below, and runs without it until it's allowed", async () => {
      const d = await start({ profile: profileOf({ permissionMode: 'bypassPermissions' }) })
      const { repo, marker, addSkill } = repoWith('skill-appears', { skill: false })
      const thread = await d.thread(undefined, { cwd: repo })
      await d.call('action.run', { id: ALLOW, params: { cwd: repo, hash: (await facts(d, thread))!.hash } })
      // A skill shows up in a folder below: Claude Code runs without the folder's own until it's allowed again, and the
      // folder asks, the skill among its files.
      addSkill()
      expect((await d.send(thread, 'Read sub/x.txt Skill evil')).status.state).toBe('done')
      expect(await facts(d, thread)).toMatchObject({ allowed: false, changed: true, files: expect.arrayContaining(['sub/.claude/skills/evil/SKILL.md']) })
      expect((await d.toolCalls(thread)).find((c) => c.name === 'Skill')?.result?.text).toContain('Unknown skill: evil')
      expect([existsSync(marker), existsSync(`${marker}-shell`)]).toEqual([false, false])
    }, 60_000)

    it("loads one once the folder's settings are allowed as they are, skill and all", async () => {
      const d = await start({ profile: profileOf({ permissionMode: 'bypassPermissions' }) })
      const { repo, marker } = repoWith('skill-allowed', { skill: true })
      const thread = await d.thread(undefined, { cwd: repo })
      expect(await facts(d, thread)).toMatchObject({ allowed: false, files: expect.arrayContaining(['sub/.claude/skills/evil/SKILL.md']) })
      await d.call('action.run', { id: ALLOW, params: { cwd: repo, hash: (await facts(d, thread))!.hash } })
      expect((await d.send(thread, 'Read sub/x.txt Skill evil')).status.state).toBe('done')
      expect((await d.toolCalls(thread)).filter((c) => c.name === 'Skill').at(-1)?.result?.text).toContain('Launching skill: evil')
      expect(existsSync(`${marker}-shell`)).toBe(true)
    }, 60_000)
  })

  it('starts a thread on the model picked in the model menu, with the claude profile it makes', async () => {
    const d = await start({ profile: { 'profile.ts': 'export default {}\n' } })
    const models = await d.call<ModelCatalog>('agent.models', {})
    expect(models.agents).toEqual([expect.objectContaining({
      kind: 'claude-agent', title: 'Claude Agent', profile: 'claude', models: expect.arrayContaining([expect.objectContaining({ value: 'claude-agent/sonnet', label: 'Sonnet' })]),
    })])
    expect(models.agents![0]!.unavailable).toBeUndefined()
    const before = api.requests.length
    const thread = await d.call<ThreadInfo>('thread.start', { cwd: dir, model: 'claude-agent/sonnet', thinking: 'high', prompt: 'Say hi' })
    expect(thread).toMatchObject({ profile: { name: 'claude' }, chosen: { model: 'claude-agent/sonnet', thinking: 'high' } })
    // Its model card's: the model and effort, Anthropic's, run by the user's Claude Code.
    expect(thread).toMatchObject({ model: 'Claude Sonnet', thinking: 'high', provider: 'anthropic', modelFrom: 'thread', agent: { kind: 'claude-agent', title: 'Claude Agent', about: 'runs your Claude Code' } })
    expect(readFileSync(join(d.dataDir, 'profiles', 'claude', 'profile.ts'), 'utf8')).toContain("agent: 'claude-agent'")
    expect((await d.idle(thread)).status.state).toBe('done')
    // Claude Code ran it on that model.
    expect(api.requests.slice(before).at(-1)!.model).toMatch(/sonnet/)
  }, 60_000)

  it('runs as many turns at once as Settings say, the rest waiting their turn and saying so', async () => {
    const d = await start()
    await d.call('settings.set', { key: SETTINGS.parallel, value: 1 })
    const first = await d.thread(undefined, { cwd: dir })
    const second = await d.thread(undefined, { cwd: dir })
    await d.call('thread.send', { thread: first.id, text: 'Wait for me' })
    const hold = await api.held()
    const asked = api.requests.length
    await d.call('thread.send', { thread: second.id, text: 'Say hi' })
    await d.until(async () => (await d.info(second)).status.msg === 'Waiting: 1 Claude Agent thread is running', 'the second waiting', 10_000)
    expect((await d.info(second)).status.state).toBe('working')
    // It didn't start Claude Code while it waited.
    await new Promise((r) => setTimeout(r, 300))
    expect(api.requests.length).toBe(asked)
    // The first stops: the second goes on.
    await d.call('thread.stop', { thread: first.id })
    await hold.dropped
    expect((await d.idle(second)).status).toMatchObject({ state: 'done' })
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

  describe('one Claude Code per thread', () => {
    it('keeps Claude Code running between turns, and starts another, resuming, once it went idle', async () => {
      const d = await start({ idleMs: 1500 })
      const thread = await d.thread(undefined, { cwd: dir })
      const saw = (msg: string | undefined) => Number(/^OK \(mock saw (\d+) messages\)$/.exec(msg ?? '')?.[1])
      const first = saw((await d.send(thread, 'Say hi')).status.msg)
      const second = saw((await d.send(thread, 'Again')).status.msg)
      expect(spawns()).toBe(1)
      expect(second).toBeGreaterThan(first + 1)
      // Idle for longer than it waits: it went, and the next turn's resumes the session.
      await new Promise((r) => setTimeout(r, 2500))
      const third = saw((await d.send(thread, 'Once more')).status.msg)
      expect(spawns()).toBe(2)
      expect(third).toBeGreaterThan(second + 1)
    }, 60_000)

    it('gives Claude Code a message sent mid-turn at once, answering it in the same turn', async () => {
      const d = await start({ profile: profileOf({ permissionMode: 'bypassPermissions' }) })
      const thread = await d.thread(undefined, { cwd: dir })
      await d.call('thread.send', { thread: thread.id, text: 'Run sleep 2' })
      await d.until(async () => (await d.toolCalls(thread)).length === 1, 'the call running', 20_000)
      await d.call('thread.send', { thread: thread.id, text: 'Also say hi', whenBusy: 'steer' })
      const done = await d.idle(thread)
      expect(done.status.state).toBe('done')
      // In the request after the call, as Claude Code puts what's said mid-turn; one Claude Code, one run.
      const asked = api.requests.findIndex((r) => JSON.stringify(r.messages).includes('Also say hi'))
      expect(asked).toBeGreaterThan(0)
      expect(JSON.stringify(api.requests[asked]!.messages)).toContain('tool_result')
      expect(spawns()).toBe(1)
      const transcript = await d.transcript(thread)
      expect(transcript.indexOf('Also say hi')).toBeLessThan(transcript.lastIndexOf(done.status.msg!))
    }, 60_000)

    it('Stop interrupts the turn and keeps Claude Code for the next', async () => {
      const d = await start()
      const thread = await d.thread(undefined, { cwd: dir })
      await d.call('thread.send', { thread: thread.id, text: 'Wait for me' })
      const hold = await api.held()
      await d.call('thread.stop', { thread: thread.id })
      await hold.dropped
      expect((await d.idle(thread)).status.state).not.toBe('working')
      expect((await d.send(thread, 'Say hi')).status.state).toBe('done')
      expect((await d.send(thread, 'Again')).status.state).toBe('done')
      expect(spawns()).toBe(1)
    }, 60_000)

    it('ends Claude Code with its thread archived', async () => {
      const d = await start()
      const thread = await d.thread('Say hi', { cwd: dir })
      expect(thread.status.state).toBe('done')
      await d.call('thread.archive', { thread: thread.id })
      await d.call('thread.unarchive', { thread: thread.id })
      expect((await d.send(thread, 'Again')).status.state).toBe('done')
      expect(spawns()).toBe(2)
    }, 60_000)
  })

  it("gives Claude Code the images sent with a message as image blocks, and other files by their path", async () => {
    const d = await start()
    const thread = await d.thread(undefined, { cwd: dir })
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    await d.call('thread.send', {
      thread: thread.id, text: 'Look at these',
      attachments: [{ name: 'dot.png', mimeType: 'image/png', data: png }, { name: 'data.bin', mimeType: 'application/octet-stream', data: Buffer.from([0, 1, 2]).toString('base64') }],
    })
    expect((await d.idle(thread)).status.state).toBe('done')
    const said = api.requests.at(-1)!.messages.findLast((m) => m.role === 'user' && JSON.stringify(m).includes('Look at these'))!
    const blocks = said.content as { type: string; source?: { type: string; media_type: string; data: string }; text?: string }[]
    expect(blocks.find((b) => b.type === 'image')?.source).toEqual({ type: 'base64', media_type: 'image/png', data: png })
    expect(blocks.some((b) => b.type === 'text' && /<attachment name="data.bin" type="application\/octet-stream" path="[^"]+data.bin" \/>/.test(b.text ?? ''))).toBe(true)
  }, 60_000)

  it("says how full the context is, and what it runs on, from Claude Code's own count", async () => {
    const d = await start()
    const thread = await d.thread(undefined, { cwd: dir })
    expect(await d.info(thread)).toMatchObject({ agent: { kind: 'claude-agent', title: 'Claude Agent', about: 'runs your Claude Code' }, model: "Claude Code's default", provider: 'anthropic' })
    expect((await d.info(thread)).context).toBeUndefined()
    await d.send(thread, 'Say hi')
    await d.until(async () => (await d.info(thread)).context !== undefined, 'the context', 10_000)
    const { context, model } = await d.info(thread)
    expect(context!.tokens).toBeGreaterThan(0)
    expect(context!.max).toBeGreaterThan(context!.tokens)
    expect(model).toMatch(/^claude-/)
  }, 60_000)

  it('says Claude Code compacted the conversation, as asked with /compact', async () => {
    const d = await start()
    const thread = await d.thread(undefined, { cwd: dir })
    await d.send(thread, 'Say hi')
    await d.call('thread.send', { thread: thread.id, text: '/compact' })
    expect((await d.idle(thread)).status.state).toBe('done')
    expect(await d.transcript(thread)).toMatch(/Claude Code compacted the conversation as asked \(it was [\dk.M]+ tokens\)\./)
  }, 60_000)

  it('compacts as asked from the window (thread.compact), by its own /compact with the instructions', async () => {
    const d = await start()
    const thread = await d.thread(undefined, { cwd: dir })
    await d.send(thread, 'Say hi')
    expect(await d.call('thread.compact', { thread: thread.id, instructions: 'keep the greeting' })).toEqual({ submission: expect.any(String) })
    expect((await d.idle(thread)).status.state).toBe('done')
    const transcript = await d.transcript(thread)
    expect(transcript).toContain('/compact keep the greeting')
    expect(transcript).toMatch(/Claude Code compacted the conversation as asked/)
  }, 60_000)

  describe("the plan's limits, as Claude Code reports them", () => {
    const inject = (info: object) => writeFileSync(join(dir, 'inject'), `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: '00000000-0000-4000-8000-000000000000', session_id: 'mock' })}\n`)
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600

    it('notes a limit Claude Code warns of, for the threads on its machine', async () => {
      const d = await start({ inject: true })
      const thread = await d.thread(undefined, { cwd: dir })
      const limit = await d.watch<Limit | null>(LIMIT)
      inject({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.8, resetsAt })
      expect((await d.send(thread, 'Say hi')).status.state).toBe('done')
      const said = await limit.until((value) => value !== null, 'the limit')
      expect(said).toEqual({ status: 'allowed_warning', type: 'five_hour', utilization: 0.8, resetsAt: resetsAt * 1000 })
      expect(limitNote(said, Date.now(), () => '14:20')).toBe('5-hour limit 80% used, resets 14:20')
    }, 60_000)

    it('fails a turn refused for a limit, saying which and when it resets', async () => {
      const d = await start({ inject: true })
      const thread = await d.thread(undefined, { cwd: dir })
      inject({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt })
      api.refuse = { 'anthropic-ratelimit-unified-status': 'rejected' }
      const failed = await d.send(thread, 'Say hi')
      expect(failed.status.state).toBe('error')
      expect(failed.status.msg).toMatch(/^5-hour limit reached, resets \S+/)
    }, 60_000)
  })

  describe('approvals', () => {
    // Auto, the default, lets the mock's calls through without asking: these ask, as `default` does.
    const asking = profileOf({ permissionMode: 'default' })
    /** The permission modes Claude Code was started in for turns, in order. */
    const modes = () => readFileSync(join(dir, 'runs'), 'utf8').split('\n').filter((l) => l.includes('stream-json')).map((l) => /--permission-mode=(\S+)/.exec(l)?.[1])

    it('runs in Auto when neither the profile nor Settings picks a mode, not asking for the call', async () => {
      const d = await start()
      const cwd = folder()
      const thread = await d.thread(undefined, { cwd })
      const done = await d.send(thread, 'Run touch auto.txt')
      expect(done.status.state).toBe('done')
      expect(existsSync(join(cwd, 'auto.txt'))).toBe(true)
      expect(modes()).toEqual(['auto'])
      // Superego's own tools go ahead without Claude Code asking its classifier, a model request of its own.
      const before = api.requests.length
      expect((await d.send(thread, 'Use thread_list {}')).status.state).toBe('done')
      expect((await d.toolCalls(thread)).find((c) => c.name === 'thread_list')!.result).toMatchObject({ isError: false })
      expect(api.requests.slice(before).filter((r) => r.system.includes(CLASSIFIER))).toEqual([])
    }, 60_000)

    it('blocks the thread on a permission while Claude Code asks, and Allow lets the call run', async () => {
      const d = await start({ profile: asking })
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
      const d = await start({ profile: asking })
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
      const d = await start({ profile: asking })
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
      const d = await start({ profile: asking })
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
      const d = await start({ profile: asking })
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

    it('bypasses every check only when Settings or the profile says so, not from Claude Code\'s own settings', async () => {
      mkdirSync(join(dir, 'config'), { recursive: true })
      writeFileSync(join(dir, 'config', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      const d = await start()
      const cwd = folder()
      // Claude Code's own default doesn't apply: Superego's (Auto) does, or what Settings picks.
      expect((await d.send(await d.thread(undefined, { cwd }), 'Say hi')).status.state).toBe('done')
      await d.call('settings.set', { key: SETTINGS.permissionMode, value: 'default' })
      const thread = await d.thread(undefined, { cwd })
      const { approval } = await ask(d, thread, 'Run touch asked.txt')
      expect(approval.tool).toBe('Bash')
      await d.dispatch(ANSWER, { id: approval.id, choice: 'deny' })
      await d.idle(thread)
      expect(existsSync(join(cwd, 'asked.txt'))).toBe(false)

      // Allow all, in Settings: the call goes ahead without asking.
      await d.call('settings.set', { key: SETTINGS.permissionMode, value: 'bypassPermissions' })
      const allowing = await d.thread(undefined, { cwd })
      const allowed = await d.send(allowing, 'Run touch allowed-all.txt')
      expect(allowed.status.state).toBe('done')
      expect(existsSync(join(cwd, 'allowed-all.txt'))).toBe(true)
      await d.close()

      // Or the profile's.
      const bypassing = await start({ profile: profileOf({ permissionMode: 'bypassPermissions' }) })
      const other = await bypassing.thread(undefined, { cwd })
      const done = await bypassing.send(other, 'Run touch bypassed.txt')
      expect(done.status.state).toBe('done')
      expect(existsSync(join(cwd, 'bypassed.txt'))).toBe(true)
      expect(modes()).toEqual(['auto', 'default', 'bypassPermissions', 'bypassPermissions'])
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

  it("is its .claude/, CLAUDE.md, CLAUDE.local.md and .mcp.json, from it up: not the user's own, nor Claude Code's checkouts", () => {
    const user = join(root, 'home', '.claude')
    write('home/.claude/settings.json')
    write('home/.claude/CLAUDE.md', 'mine')
    expect(projectConfig(join(root, 'home'), user)).toBeUndefined()
    write('.mcp.json')
    write('repo/.claude/settings.json')
    write('repo/.claude/settings.local.json')
    write('repo/.claude/hooks/start.sh', 'echo hi')
    write('repo/.claude/worktrees/feature/.claude/settings.json')
    write('repo/.claude/hooks/node_modules/x.js')
    write('repo/CLAUDE.md', 'notes')
    write('repo/CLAUDE.local.md', 'my notes')
    write('repo/src/CLAUDE.md', 'notes for src')
    symlinkSync(join(root, 'repo', '.claude', 'hooks'), join(root, 'repo', '.claude', 'again'))
    const config = projectConfig(join(root, 'repo'), user)!
    expect(config.files).toEqual([
      '.claude/again/start.sh', '.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.md', 'CLAUDE.local.md', join(root, '.mcp.json'),
    ])
    expect(config.onlyInstructions).toBe(false)
    for (const [path, text] of [['repo/.claude/hooks/start.sh', 'echo changed'], ['repo/CLAUDE.md', 'other notes'], ['repo/CLAUDE.local.md', 'my other notes']]) {
      const before = projectConfig(join(root, 'repo'), user)!.hash
      write(path!, text)
      expect(projectConfig(join(root, 'repo'), user)!.hash, path).not.toBe(before)
    }
    // What isn't in it changes nothing.
    const changed = projectConfig(join(root, 'repo'), user)!.hash
    write('repo/.claude/worktrees/feature/.claude/settings.json', '{"x":1}')
    write('repo/src/CLAUDE.md', 'other notes for src')
    expect(projectConfig(join(root, 'repo'), user)!.hash).toBe(changed)
    expect(config.unsafe).toBeUndefined()
    rmSync(join(root, '.mcp.json'))
  })

  it("is instructions only where it's CLAUDE.md files (above too), their rules and what they import, followed as Claude Code does", () => {
    const user = join(root, 'nobody', '.claude')
    write('docs-repo/CLAUDE.md', 'Read @docs/guide.md and @~/never-there.md, and @./later.md when it exists; mail me@example.com')
    write('docs-repo/docs/guide.md', 'See @../style.md too')
    write('docs-repo/style.md', 'Tabs.')
    write('docs-repo/.claude/rules/tests.md', 'Test it.')
    write('docs-repo/sub/CLAUDE.md', 'Above the folder.')
    const at = join(root, 'docs-repo', 'sub')
    const config = projectConfig(at, user)!
    // Nearest first, then what's imported.
    expect(config.files).toEqual(['CLAUDE.md', ...['.claude/rules/tests.md', 'CLAUDE.md', 'docs/guide.md', 'style.md'].map((file) => join(root, 'docs-repo', file))])
    expect(config.onlyInstructions).toBe(true)
    // A file imported two deep changing, or an import showing up, asks again.
    write('docs-repo/style.md', 'Spaces.')
    const restyled = projectConfig(at, user)!.hash
    expect(restyled).not.toBe(config.hash)
    write('docs-repo/later.md', 'Now here.')
    expect(projectConfig(at, user)!.hash).not.toBe(restyled)
    // Settings anywhere in it make it settings.
    write('docs-repo/.mcp.json')
    expect(projectConfig(at, user)!.onlyInstructions).toBe(false)
  })

  it('takes in the skills of .claude/skills folders below it, as Claude Code finds them: what git lists, else walked', () => {
    const at = mkdtempSync(join(tmpdir(), 'claude-skills-'))
    try {
      const put = (path: string) => { mkdirSync(join(at, path, '..'), { recursive: true }); writeFileSync(join(at, path), 'x') }
      // A folder outside any repository: walked, past node_modules, not its own .claude.
      put('plain/.claude/skills/own/SKILL.md')
      put('plain/a/b/.claude/skills/x/SKILL.md')
      put('plain/a/b/.claude/skills/x/run.sh')
      put('plain/node_modules/p/.claude/skills/y/SKILL.md')
      expect(nestedSkills(join(at, 'plain'))).toEqual({ files: ['a/b/.claude/skills/x/SKILL.md', 'a/b/.claude/skills/x/run.sh'] })
      expect(nestedSkills(join(at, 'plain'), { limit: 2 })).toEqual({ files: [], tooMany: true })
      expect(nestedSkills(join(at, 'plain'), { walk: false })).toEqual({ files: [] })

      // A repository: what's tracked or untracked, not what it ignores; a repository inside it too.
      const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: join(at, cwd), stdio: 'ignore' })
      put('repo/.gitignore')
      writeFileSync(join(at, 'repo', '.gitignore'), 'ignored/\n')
      put('repo/t/.claude/skills/t/SKILL.md')
      git('repo', 'init', '-q')
      git('repo', 'add', '.')
      git('repo', 'commit', '-qm', 'first')
      put('repo/u/.claude/skills/u/SKILL.md')
      put('repo/ignored/.claude/skills/z/SKILL.md')
      put('repo/inner/m/.claude/skills/n/SKILL.md')
      git('repo/inner', 'init', '-q')
      expect(nestedSkills(join(at, 'repo'))).toEqual({ files: ['inner/m/.claude/skills/n/SKILL.md', 't/.claude/skills/t/SKILL.md', 'u/.claude/skills/u/SKILL.md'] })
      // In a folder the repository ignores, none: Claude Code doesn't load them either.
      expect(nestedSkills(join(at, 'repo', 'ignored'))).toEqual({ files: [] })
    } finally { rmSync(at, { recursive: true, force: true }) }
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

    // A CLAUDE.md alike: another user could rewrite the instructions.
    write('notes/repo/CLAUDE.md', 'notes')
    chmodSync(join(root, 'notes', 'repo', 'CLAUDE.md'), 0o666)
    const notes = projectConfig(join(root, 'notes', 'repo'))!
    expect(notes).toMatchObject({ files: ['CLAUDE.md'], onlyInstructions: true, unsafe: join(root, 'notes', 'repo', 'CLAUDE.md') })

    const allowances = new ProjectAllowances(join(root, 'allowed.json'))
    await allowances.allow(under)
    expect(allowances.allowed(under)).toBe(false)
    const d = await testDaemon({ extensions: [claudeAgent({ executable: async () => '/bin/false' })] })
    try {
      await expect(d.call('action.run', { id: ALLOW, params: { cwd: join(root, 'own', 'repo'), hash: writable.hash } })).rejects.toMatchObject({ kind: 'unsafe' })
      await expect(d.call('action.run', { id: ALLOW, params: { cwd: join(root, 'notes', 'repo'), hash: notes.hash } })).rejects.toMatchObject({ kind: 'unsafe' })
    } finally { await d.close() }
  })
})
