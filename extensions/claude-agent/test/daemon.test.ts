// A Claude Agent thread, end to end: a daemon with the extension, a profile that picks it, and the user's own `claude`
// (skipped where it isn't installed) talking to a mock Messages API instead of Anthropic's, so nothing needs an account
// or costs anything. `claude` is started through a wrapper that writes down the environment it was given (to check no
// Anthropic credential reached it), then points it at the mock with a key of the mock's, in a config folder of its own.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LiveState } from '@earendil-works/pi-durable'
import { testDaemon, type TestDaemon } from '@superego/sdk/testing'
import { claudeEnv } from '../src/claude.ts'
import { claudeAgent } from '../src/daemon.ts'
import { mockAnthropic, type MockAnthropic } from './mock-anthropic.ts'

const claude = (() => {
  try { return execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined } catch { return undefined }
})()

const PROFILE = { 'profile.ts': "export default { agent: 'claude-agent' }\n" }

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
    dir = mkdtempSync(join(tmpdir(), 'claude-agent-'))
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
