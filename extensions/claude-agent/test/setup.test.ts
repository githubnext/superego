// Setup's side of Claude Agent: whether Claude Code is installed and signed in (`claude auth status`, run on a fake
// `claude` here, never touching anyone's sign-in), as setup, Settings and the model menus tell it, and the "claude"
// profile it makes, left alone once there.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { arr, obj, str } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { testDaemon, type TestDaemon, type TestDaemonOptions } from '@superego/sdk/testing'
import { claudeAgent } from '../src/daemon.ts'
import type { ModelCatalog, SettingsSnapshot } from '@superego/protocol'
import { CHECK, CLAUDE, MAKE_PROFILE, SECTION, SETTINGS, TERMINAL } from '../src/shared.ts'

let dir: string | undefined
const dirs: string[] = []
let daemon: TestDaemon | undefined
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true })
})

/** A `claude` that answers `auth status` with `json` (`answer` changes it), and writes down the environment it got. */
function fakeClaude(json: object) {
  dir = mkdtempSync(join(tmpdir(), 'superego-claude-setup-'))
  dirs.push(dir)
  const file = join(dir, 'claude')
  answer(file, json)
  writeFileSync(file, `#!/bin/sh\nenv > "${dir}/env"\necho "$*" >> "${dir}/log"\n[ "$1" = "--version" ] && echo '2.1.325 (Claude Code)'\n[ "$1 $2" = "auth status" ] && cat "${dir}/status"\nexit 0\n`)
  chmodSync(file, 0o755)
  return file
}

/**
 * Have the fake `claude` answer `auth status` with `json` from now on: the same program, signed in or out since, as
 * a user's is (a new one's first run can take seconds on a busy Mac, scanned as it's opened).
 */
const answer = (claude: string, json: object) => writeFileSync(join(claude, '..', 'status'), `${JSON.stringify(json)}\n`)

/**
 * A daemon with Claude Agent on `claude`, once it has looked at it, as it does as it starts: a model menu waits only 3s
 * for that first look, which a busy machine's `claude` can take longer than.
 */
async function started(claude: () => Promise<string | undefined>, options: TestDaemonOptions = {}) {
  const made = await testDaemon({ ...options, extensions: [claudeAgent({ executable: claude }), ...options.extensions ?? []] })
  await (await made.watch(CLAUDE)).until((check) => check !== null, 'Claude Code looked at')
  return made
}

it('says Claude Code is signed in, asking it without Anthropic credentials', async () => {
  const claude = fakeClaude({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'not-kept@example.com' })
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-not-reach-claude'
  try {
    daemon = await started(async () => claude)
    expect(await daemon.dispatch(CHECK)).toEqual({ installed: true, path: claude, version: '2.1.325', loggedIn: true, how: 'claude.ai', plan: 'max' })
    expect(readFileSync(join(dir!, 'env'), 'utf8')).not.toContain('ANTHROPIC_API_KEY')
  } finally { delete process.env.ANTHROPIC_API_KEY }
})

it('says when Claude Code is signed out, or not installed', async () => {
  const claude = fakeClaude({ loggedIn: false, authMethod: 'none' })
  daemon = await started(async () => claude)
  expect(await daemon.dispatch(CHECK)).toEqual({ installed: true, path: claude, version: '2.1.325', loggedIn: false })
  await daemon.close()
  daemon = await started(async () => undefined)
  expect(await daemon.dispatch(CHECK)).toEqual({ installed: false })
})

it('makes a "claude" profile that picks Claude Agent, and leaves one already there', async () => {
  daemon = await started(async () => undefined)
  expect(await daemon.dispatch(MAKE_PROFILE)).toEqual({ name: 'claude' })
  const file = join(daemon.dataDir, 'profiles', 'claude', 'profile.ts')
  expect(readFileSync(file, 'utf8')).toContain("export default { agent: 'claude-agent' }")
  writeFileSync(file, "export default { agent: 'claude-agent', prompt: 'mine' }\n")
  await daemon.dispatch(MAKE_PROFILE)
  expect(readFileSync(file, 'utf8')).toContain("prompt: 'mine'")
})

it('offers Claude Agent in the model menus where Claude Code is installed, its models picked once it is signed in', async () => {
  const signedIn = fakeClaude({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' })
  daemon = await started(async () => signedIn)
  const models = await daemon.call<ModelCatalog>('agent.models', {})
  expect(models.agents).toEqual([{
    kind: 'claude-agent', title: 'Claude Agent', description: 'Runs your Claude Code', profile: 'claude',
    models: [
      { value: 'claude-agent/opus', label: 'Opus', thinking: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-agent/sonnet', label: 'Sonnet', thinking: ['low', 'medium', 'high', 'max'] },
      { value: 'claude-agent/haiku', label: 'Haiku', thinking: [] },
    ],
  }])
  // Settings has it, as last looked at, with the machine's permission mode and how many run at once.
  const settings = await daemon.call<{ value: SettingsSnapshot }>('settings.watch', {})
  const section = settings.value.sections.find((s) => s.id === SECTION)!
  expect(section).toMatchObject({ title: 'Claude Agent', ui: SECTION, value: CLAUDE })
  expect(section.settings.map((s) => s.key)).toEqual([SETTINGS.permissionMode, SETTINGS.parallel])
  expect(section.settings[0]).toMatchObject({ options: expect.arrayContaining([{ value: 'bypassPermissions', label: 'Allow all' }]) })
  expect(settings.value.values).toMatchObject({ [SETTINGS.permissionMode]: 'auto', [SETTINGS.parallel]: 3 })
  expect((await daemon.watch(CLAUDE)).value).toEqual({ installed: true, path: signedIn, version: '2.1.325', loggedIn: true, how: 'claude.ai', plan: 'pro' })
  await daemon.close()

  // Signed out: there, but its models can't be picked, saying why.
  const signedOut = fakeClaude({ loggedIn: false, authMethod: 'none' })
  let installed: string | undefined = signedOut
  daemon = await started(async () => installed)
  expect((await daemon.call<ModelCatalog>('agent.models', {})).agents).toMatchObject([{ kind: 'claude-agent', unavailable: "Claude Code isn't signed in here: run claude, then /login" }])
  // Made the default in setup, before it was signed out: new threads are refused, saying why.
  await daemon.call('settings.set', { key: 'agent.model', value: 'claude-agent/sonnet' })
  await expect(daemon.call('thread.start', {})).rejects.toMatchObject({ kind: 'model_unavailable', message: "Claude Code isn't signed in here: run claude, then /login" })
  // Then uninstalled.
  installed = undefined
  await daemon.dispatch(CHECK)
  await expect(daemon.call('thread.start', {})).rejects.toMatchObject({ kind: 'model_unavailable', message: "Claude Code isn't installed here" })
  await daemon.close()

  // Not installed: not offered, and its models aren't anyone's.
  daemon = await started(async () => undefined)
  expect((await daemon.call<ModelCatalog>('agent.models', {})).agents).toBeUndefined()
  await expect(daemon.call('thread.start', { model: 'claude-agent/opus' })).rejects.toThrow(/No model claude-agent\/opus here/)
  expect((await daemon.watch(CLAUDE)).value).toEqual({ installed: false })
})

it('keeps a thread on its kind of agent: a profile or model of another kind is refused, saying why', async () => {
  const claude = fakeClaude({ loggedIn: true, authMethod: 'claude.ai' })
  daemon = await started(async () => claude, { model: 'echo', profile: { 'profile.ts': 'export default {}\n' } })
  // Superego's own profile with a Claude Agent model, and the other way round.
  await expect(daemon.call('thread.start', { model: 'claude-agent/opus', profile: 'default' }))
    .rejects.toThrow("The default profile runs on Superego test's own agent, not Claude Agent: claude-agent/opus isn't one of its models")
  await daemon.dispatch(MAKE_PROFILE)
  const models = await daemon.call<ModelCatalog>('agent.models', {})
  await expect(daemon.call('thread.start', { model: models.models[0]!.value, profile: 'claude' }))
    .rejects.toThrow(`The claude profile runs on Claude Agent, not Superego test's own agent: ${models.models[0]!.value} isn't one of its models`)

  // A thread with no conversation yet takes a profile of another kind, and its turns run on it.
  const empty = await daemon.thread()
  expect(await daemon.call('thread.setProfile', { thread: empty.id, profile: 'claude' })).toMatchObject({ name: 'claude' })
  expect(await daemon.transcript(empty)).toContain('This thread runs the claude profile now')
  expect(await daemon.transcript(empty)).toContain('on Claude Agent')
  // Back again, while it still has none.
  expect(await daemon.call('thread.setProfile', { thread: empty.id })).toMatchObject({ name: 'default' })

  // Once it has one, not: each kind keeps its own conversation.
  const talked = await daemon.thread('Hello')
  expect((await daemon.idle(talked)).status.state).toBe('done')
  await expect(daemon.call('thread.setProfile', { thread: talked.id, profile: 'claude' }))
    .rejects.toThrow("This thread runs on Superego test's own agent, and the claude profile on Claude Agent: a thread can't move between them once it has a conversation, as each keeps its own")
})

it("opens Claude Code in a terminal beside a thread for the user's own /login, never signing in itself", async () => {
  const claude = fakeClaude({ loggedIn: false, authMethod: 'none' })
  const ran: unknown[] = []
  const terminal = defineDaemonExtension({
    name: 'terminal', setup(superego) {
      superego.action(defineAction({ id: 'terminal.run', title: 'Run', params: obj({ thread: str(), command: arr(str()) }), run: (params) => { ran.push(params); return { id: 'p1' } } }))
    },
  })
  daemon = await started(async () => claude, { extensions: [terminal] })
  const thread = await daemon.thread()
  expect(await daemon.dispatch(TERMINAL, { thread: thread.id })).toEqual({ id: 'p1' })
  expect(ran).toEqual([{ thread: thread.id, command: [claude] }])
  // Nothing but `--version` and `auth status` was run for it: no login.
  expect(readFileSync(join(dir!, 'log'), 'utf8').trim().split('\n').every((line) => line === '--version' || line === 'auth status --json')).toBe(true)
})

it("looks at Claude Code again before a new thread starts on it by default, once what it knew is old", async () => {
  const claude = fakeClaude({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' })
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    daemon = await started(async () => claude)
    await daemon.call<ModelCatalog>('agent.models', {})
    await daemon.call('settings.set', { key: 'agent.model', value: 'claude-agent/sonnet' })
    // Signed out since it was last looked at, a minute and more ago: the next start is refused, not run on what it knew.
    answer(claude, { loggedIn: false, authMethod: 'none' })
    vi.setSystemTime(Date.now() + 61_000)
    await expect(daemon.call('thread.start', {})).rejects.toMatchObject({ kind: 'model_unavailable', message: "Claude Code isn't signed in here: run claude, then /login" })
  } finally { vi.useRealTimers() }
})
