// A Claude Agent thread on another machine: a hub daemon that reaches a box daemon (through a `via` command piping
// stdio to its socket, as `ssh <host> superego connect` would), each with Claude Agent on a `claude` of its own. The
// box's runs the box's turns against the mock API, signed in; the hub's isn't signed in and runs nothing but its check.
// So what the window sees of the box (its models, its Claude Code, its thread with Superego's tools and skill) is the
// box's. Skipped where `claude` isn't installed.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon, type MachineReach } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type MachineEntry, type ModelCatalog, type Notifications, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import agentUi from '@superego/agent-ui/daemon'
import threadTools from '@superego/thread-tools/daemon'
import { machineHub, MachineStore } from '../../../packages/client/src/index.ts'
import { claudeEnv } from '../src/claude.ts'
import { claudeAgent } from '../src/daemon.ts'
import { CHECK, type ClaudeCheck } from '../src/shared.ts'
import { mockAnthropic, type MockAnthropic } from './mock-anthropic.ts'

const SKILL_DIR = fileURLToPath(new URL('../../../packages/cli/skill/', import.meta.url))
const claude = (() => {
  try { return execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined } catch { return undefined }
})()
const hubApp = defineApp({ name: 'hub', id: 'claudehub' })
const boxApp = defineApp({ name: 'box', id: 'claudebox' })

let api: MockAnthropic
let dir: string
/** Sockets go where their paths are short enough. */
let sockets: string
const cleanups: (() => unknown)[] = []
beforeAll(async () => {
  api = await mockAnthropic()
  // Where no one but this user can write all the way up (see daemon.test.ts).
  const scratch = join(import.meta.dirname, '..', 'node_modules', '.tmp')
  mkdirSync(scratch, { recursive: true })
  dir = mkdtempSync(join(scratch, 'claude-remote-'))
  sockets = mkdtempSync(join(tmpdir(), 'cr-'))
  process.env.CLAUDEHUB_MODEL = 'faux'
  process.env.CLAUDEBOX_MODEL = 'faux'
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => {
  await api.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(sockets, { recursive: true, force: true })
  delete process.env.CLAUDEHUB_MODEL
  delete process.env.CLAUDEBOX_MODEL
})

/** A `claude` of a machine's own, writing down what it's asked: the box's signed in to the mock, the hub's to nothing. */
function wrapper(name: string, signedIn: boolean) {
  const file = join(dir, `${name}-claude`)
  const key = signedIn ? `ANTHROPIC_BASE_URL=${api.url} ANTHROPIC_API_KEY=sk-ant-api03-mock ` : ''
  writeFileSync(file, `#!/bin/sh\necho "$*" >> "${dir}/${name}.calls"\nexec env ${key}CLAUDE_CONFIG_DIR="${dir}/${name}-config" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "${claude}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}
const calls = (name: string) => existsSync(join(dir, `${name}.calls`)) ? readFileSync(join(dir, `${name}.calls`), 'utf8').trim().split('\n') : []

/** A daemon on a socket of its own, with Claude Agent on its own `claude`. */
async function start(app: typeof hubApp, name: string, executable: string, reach?: (self: Parameters<typeof machineHub>[0]['self']) => MachineReach) {
  const dataDir = join(dir, name)
  const extensions = [claudeAgent({ executable: async () => executable, env: () => claudeEnv(), skills: [SKILL_DIR] }), agentUi, threadTools]
  const daemon = await openDaemon({ app, dataDir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions, ...(reach ? { reach } : {}) })
  const socket = join(sockets, `${name}.sock`)
  const server = await listen(daemon, socket)
  cleanups.push(async () => { server.close(); await daemon.close() })
  return { daemon, dataDir, socket }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const relay = <T,>(peer: RpcPeer, machine: string, method: string, params: unknown) => peer.call<T>('relay.call', { machine, method, params })

it.skipIf(!claude)("runs a thread on another machine with that machine's claude, its sign-in, Superego's tools and skill", async () => {
  const boxClaude = wrapper('box', true)
  const hubClaude = wrapper('hub', false)
  const box = await start(boxApp, 'box', boxClaude)
  // The hub reaches the box through a command splicing stdio to its socket.
  const splice = join(dir, 'splice.cjs')
  writeFileSync(splice, "const s = require('net').connect(process.argv[2]); process.stdin.pipe(s); s.pipe(process.stdout); s.on('close', () => process.exit(0)); s.on('error', () => process.exit(1))\n")
  const hubDir = join(dir, 'hub')
  const store = new MachineStore(hubDir)
  const added = await store.add({ label: 'Box', via: `'${process.execPath}' '${splice}' '${box.socket}'` })
  store.close()
  const hub = await start(hubApp, 'hub', hubClaude, (self) => machineHub({ app: hubApp, dataDir: hubDir, self }))

  const { peer, socket } = await connectSocket(hub.socket)
  cleanups.push(() => socket.destroy())
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  let machines: MachineEntry[] = (await peer.call<{ sub: string; value: MachineEntry[] }>('machines.watch', {})).value
  peer.on('machines.changed', ({ value }: Notifications['machines.changed']) => { machines = value })
  await until(() => machines.find((m) => m.id === added.id)?.state === 'connected')

  // Each machine says what its own Claude Code is: the box's signed in, the hub's not.
  expect(await relay<ClaudeCheck>(peer, added.id, 'action.run', { id: CHECK, params: {} })).toMatchObject({ installed: true, path: boxClaude, loggedIn: true })
  expect(await peer.call<ClaudeCheck>('action.run', { id: CHECK, params: {} })).toMatchObject({ installed: true, path: hubClaude, loggedIn: false })
  expect((await relay<ModelCatalog>(peer, added.id, 'agent.models', {})).agents?.[0]?.unavailable).toBeUndefined()
  expect((await peer.call<ModelCatalog>('agent.models', {})).agents?.[0]?.unavailable).toBe('Not signed in: run claude, then /login')

  // A thread there, on Claude Agent's model, calling one of Superego's tools.
  const cwd = mkdtempSync(join(dir, 'work-'))
  await relay(peer, added.id, 'thread.start', { cwd, title: 'Box neighbour' })
  const before = api.requests.length
  const thread = await relay<ThreadInfo>(peer, added.id, 'thread.start', { cwd, model: 'claude-agent/sonnet', prompt: 'Use thread_list {}' })
  expect(thread.profile?.name).toBe('claude')
  await until(async () => (await relay<ThreadInfo[]>(peer, added.id, 'thread.list', {})).find((t) => t.id === thread.id)?.status.state === 'done')
  const { text } = await relay<{ text: string }>(peer, added.id, 'thread.lastAnswer', { thread: thread.id })
  // The tool ran on the box, for its thread: it lists the box's other threads.
  expect(text).toContain('Box neighbour')
  // Claude Code there had Superego's skill, as a plugin of the box daemon's.
  expect(JSON.stringify(api.requests.slice(before).map((r) => [r.system, r.messages]))).toContain('superego:superego')
  expect(existsSync(join(box.dataDir, 'claude-agent', 'plugin', 'skills', 'superego'))).toBe(true)
  // The box's claude ran the turn; the hub's was only asked what it is.
  expect(calls('box').some((line) => line.includes('--output-format'))).toBe(true)
  expect(calls('hub').every((line) => line === '--version' || line === 'auth status --json')).toBe(true)
  // Nothing of it is on the hub: the thread, its profile and its session are the box's.
  expect(await peer.call<ThreadInfo[]>('thread.list', {})).toEqual([])
  expect(existsSync(join(hub.dataDir, 'profiles', 'claude'))).toBe(false)
  expect(readdirSync(join(dir, 'box-config', 'projects')).length).toBeGreaterThan(0)
  expect(existsSync(join(dir, 'hub-config', 'projects'))).toBe(false)
}, 90_000)
