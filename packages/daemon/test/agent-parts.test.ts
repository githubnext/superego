// The seams an extension adds to whatever agent a thread has, and signs in with: `agentParts` (parts that add up, asked
// at submit with the profile as loaded now), `agent()`'s handle (a part replaced mid-run, or removed), `auth.flow`
// (a sign-in flow of an extension's own), and a profile's `mcp` and `mcpServers` (checked, and merged over `extends`).
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { defineApp, obj, PROTOCOL_VERSION, type AuthEvent, type Notifications, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { connectSocket, defineAction, defineDaemonExtension, listen, openDaemon, type AgentPartsThread, type DaemonApi, type DaemonExtension } from '../src/index.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-parts-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.SUPEREGO_REPLAY_SPEED })

async function open(extensions: DaemonExtension[] = [], options: { model?: string; agentPartsLimit?: number } = {}) {
  process.env.SUPEREGO_MODEL = options.model ?? 'faux'
  process.env.SUPEREGO_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions, ...(options.agentPartsLimit ? { agentPartsLimit: options.agentPartsLimit } : {}) })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const find = async (peer: RpcPeer, id: string) => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)
const done = (peer: RpcPeer, id: string) => until(async () => (await find(peer, id))?.status.state === 'done')
/** The extensions a thread's agent has, once a turn configured it. */
async function partsOf(peer: RpcPeer, id: string) {
  const { value } = await peer.call<{ value: { docs: Record<string, unknown> } }>('thread.watch', { id })
  return (value.docs['pi.agent'] as { extensions?: string[] } | undefined)?.extensions ?? []
}
/** The tool results in a thread's transcript, as text. */
async function results(peer: RpcPeer, id: string) {
  const { value } = await peer.call<{ value: { entries: { model?: { role?: string; content?: { text?: string }[]; isError?: boolean }[] }[] } }>('thread.watch', { id })
  return value.entries.map((e) => e.model?.[0]).filter((m) => m?.role === 'toolResult').map((m) => `${m!.isError ? 'error: ' : ''}${m!.content?.map((c) => c.text).join('')}`)
}
const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}
const profileTs = (spec: object) => `import { defineProfile } from 'superego'\nexport default defineProfile(${JSON.stringify(spec)})\n`

it("adds every extension's parts to whatever agent a thread has: after the chooser's, only their own, in time", async () => {
  const picked = defineExtension({ name: 'picked' })
  const extra = defineExtension({ name: 'extra' })
  const late = defineExtension({ name: 'late' })
  const asked: AgentPartsThread[] = []
  let api!: DaemonApi
  const picker = defineDaemonExtension({ name: 'picker', setup(s) { s.agent(picked, { always: false }); s.agentFor(() => ({ extensions: [picked] })) } })
  const adder = defineDaemonExtension({
    name: 'adder',
    setup(s) {
      api = s
      s.agent(extra, { always: false })
      // Another extension's part, or one it gives to every thread, isn't its to add.
      s.agentParts(async (thread) => { asked.push(thread); return [extra, picked] })
    },
  })
  const slow = defineDaemonExtension({
    name: 'slow',
    setup(s) { s.agent(late, { always: false }); s.agentParts(() => new Promise((resolve) => setTimeout(() => resolve([late]), 1_000))) },
  })
  const failing = defineDaemonExtension({ name: 'failing', setup(s) { s.agentParts(() => { throw new Error('no') }) } })
  const { peer, close } = await open([picker, adder, slow, failing], { agentPartsLimit: 200 })
  const thread = await peer.call<ThreadInfo>('thread.create', { prompt: 'hi' })
  await done(peer, thread.id)
  const parts = await partsOf(peer, thread.id)
  expect(parts.filter((name) => ['picked', 'extra', 'late'].includes(name))).toEqual(['picked', 'extra'])
  expect(parts).toContain('coding-tools')
  expect(asked).toEqual([{ id: thread.id, hidden: false }])
  // An extension's own thread says so.
  const own = await api.threads.create({ hidden: true, prompt: 'mine' })
  await until(() => asked.length === 2)
  expect(asked[1]).toEqual({ id: own.id, hidden: true, owner: 'adder' })
  // Switched off, it isn't asked, and adds nothing.
  await peer.call('settings.set', { key: 'extensions.adder', value: false })
  await peer.call('thread.submit', { id: thread.id, text: 'again' })
  await done(peer, thread.id)
  expect(asked).toHaveLength(2)
  expect(await partsOf(peer, thread.id)).not.toContain('extra')
  await close()
})

it('replaces a part mid-run: the next step of the run has its new tools, without configuring the thread again', async () => {
  const recording = join(dir, 'swap.jsonl')
  const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } }) + '\n'
  writeFileSync(recording,
    turn([{ type: 'toolCall', id: 'c1', name: 'swap', arguments: {} }], 'toolUse')
    + turn([{ type: 'toolCall', id: 'c2', name: 'after', arguments: {} }], 'toolUse')
    + turn([{ type: 'text', text: 'Done.' }], 'stop')
    + turn([{ type: 'text', text: 'Again.' }], 'stop'))
  const text = (t: string) => ({ output: [{ type: 'text' as const, text: t }] })
  let removeIt!: () => void
  const swapper = defineDaemonExtension({
    name: 'swapper',
    setup(s) {
      const after = defineExtension({ name: 'swapper', tools: [defineTool({ name: 'after', description: 'After.', parameters: obj({}), execute: async () => text('after ran') })] })
      const before = defineExtension({
        name: 'swapper',
        tools: [defineTool({ name: 'swap', description: 'Swap.', parameters: obj({}), execute: async () => { part.replace(after); return text('swapped') } })],
      })
      const part = s.agent(before, { always: false })
      removeIt = part.remove
      // The part as first given: it's the one installed under its name now that counts.
      s.agentParts(() => [before])
    },
  })
  const { peer, close } = await open([swapper], { model: `replay:${recording}` })
  const thread = await peer.call<ThreadInfo>('thread.create', { prompt: 'go' })
  await done(peer, thread.id)
  expect(await results(peer, thread.id)).toEqual(['swapped', 'after ran'])
  expect(await partsOf(peer, thread.id)).toContain('swapper')
  // Removed, the next turn goes without it.
  removeIt()
  await peer.call('thread.submit', { id: thread.id, text: 'again' })
  await done(peer, thread.id)
  expect(await partsOf(peer, thread.id)).not.toContain('swapper')
  await close()
})

it("runs an extension's own sign-in flow as a provider's: events, a prompt answered, cancelled, failed", async () => {
  const flowy = defineDaemonExtension({
    name: 'flowy',
    setup(s) {
      s.action(defineAction({
        id: 'flowy.login', title: 'Sign in',
        run: (_params, context) => s.auth.flow(context, async (flow) => {
          flow.emit({ type: 'auth_url', url: 'https://auth.example/authorize', callback: 'http://127.0.0.1:47123/callback' })
          const pasted = await flow.prompt({ type: 'manual_code', message: 'Paste the URL you were sent to' })
          if (!pasted.includes('code=')) throw new Error('That URL has no code')
          flow.emit({ type: 'progress', message: 'Signed in as ada' })
        }),
      }))
    },
  })
  const { peer, close } = await open([flowy])
  const events = new Map<string, AuthEvent[]>()
  peer.on('auth.event', ({ flow, event }: Notifications['auth.event']) => { events.set(flow, [...events.get(flow) ?? [], event]) })
  const start = () => peer.call<{ flow: string }>('action.run', { id: 'flowy.login', params: {} })
  const ended = (flow: string) => until(() => ['done', 'failed'].includes(events.get(flow)?.at(-1)?.type ?? ''))
  const promptOf = async (flow: string) => {
    await until(() => Boolean(events.get(flow)?.some((e) => e.type === 'prompt')))
    return (events.get(flow)!.find((e) => e.type === 'prompt') as Extract<AuthEvent, { type: 'prompt' }>).id
  }

  const { flow } = await start()
  await peer.call('auth.respond', { flow, prompt: await promptOf(flow), value: 'http://127.0.0.1:47123/callback?code=abc&state=x' })
  await ended(flow)
  const prompt = await promptOf(flow)
  expect(events.get(flow)).toEqual([
    { type: 'auth_url', url: 'https://auth.example/authorize', callback: 'http://127.0.0.1:47123/callback' },
    { type: 'prompt', id: prompt, prompt: { type: 'manual_code', message: 'Paste the URL you were sent to' } },
    // Answered, so every client showing it puts it away.
    { type: 'prompt_closed', id: prompt },
    { type: 'progress', message: 'Signed in as ada' },
    { type: 'done' },
  ])
  // An answer to a prompt that no longer waits.
  await expect(peer.call('auth.respond', { flow, prompt, value: 'x' })).rejects.toMatchObject({ kind: 'not_found' })

  const cancelled = (await start()).flow
  const waiting = await promptOf(cancelled)
  await peer.call('auth.cancel', { flow: cancelled })
  await ended(cancelled)
  expect(events.get(cancelled)!.slice(-2)).toEqual([{ type: 'prompt_closed', id: waiting }, { type: 'failed', message: 'Cancelled' }])

  const failed = (await start()).flow
  await peer.call('auth.respond', { flow: failed, prompt: await promptOf(failed), value: 'no code here' })
  await ended(failed)
  expect(events.get(failed)!.at(-1)).toEqual({ type: 'failed', message: 'That URL has no code' })
  await close()
})

it("gives agentParts the profile as loaded now: mcp and mcpServers merged over extends, and checked", async () => {
  const home = join(dir, 'profiles', 'default')
  const project = join(dir, 'acme')
  const projectProfile = join(project, '.superego', 'profiles', 'default')
  write(home, { 'profile.ts': profileTs({ mcp: ['linear', 'sentry'], mcpServers: { docs: { command: 'node', args: ['user.js'] }, status: { url: 'https://status.example/mcp' } } }) })
  write(projectProfile, { 'profile.ts': profileTs({ extends: 'user:default', mcp: ['sentry', 'github'], mcpServers: { docs: { command: 'node', args: ['project.js'] } } }) })
  const specs: unknown[] = []
  const reader = defineDaemonExtension({ name: 'reader', setup(s) { s.agentParts(({ profile }) => { specs.push(profile && { ref: profile.ref.scope, mcp: profile.spec.mcp, mcpServers: profile.spec.mcpServers }) }) } })
  const { peer, close } = await open([reader])
  await peer.call('profile.allow', { cwd: project })
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hi' })
  await done(peer, thread.id)
  expect(specs.at(-1)).toEqual({
    ref: 'project',
    mcp: ['linear', 'sentry', 'github'],
    mcpServers: { docs: { command: 'node', args: ['project.js'] }, status: { url: 'https://status.example/mcp' } },
  })
  // Edited (and allowed again), the next turn has it.
  write(projectProfile, { 'profile.ts': profileTs({ extends: 'user:default', mcp: [] }) })
  await peer.call('profile.allow', { cwd: project })
  await peer.call('thread.submit', { id: thread.id, text: 'again' })
  await done(peer, thread.id)
  expect(specs.at(-1)).toMatchObject({ mcp: ['linear', 'sentry'], mcpServers: { docs: { args: ['user.js'] } } })
  // Names a tool prefix can carry, and a command or a URL each.
  for (const [spec, error] of [
    [{ mcp: ['Linear'] }, /mcp: "Linear" isn't a server name/],
    [{ mcpServers: { my__docs: { command: 'node' } } }, /"my__docs" isn't a server name/],
    [{ mcpServers: { docs: { command: 'node', url: 'https://x' } } }, /mcpServers.docs needs one of command or url, not both/],
    [{ mcpServers: { docs: { args: ['x'] } } }, /mcpServers.docs needs one of command or url$/],
  ] as const) {
    write(projectProfile, { 'profile.ts': profileTs(spec) })
    await peer.call('profile.allow', { cwd: project })
    await expect(peer.call('thread.create', { cwd: project })).rejects.toThrow(error)
  }
  await close()
})
