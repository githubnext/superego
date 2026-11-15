// ego against a real daemon: one hidden thread per machine, its agent chosen for it alone, kept across restarts,
// cleared rather than archived; Ego threads from before taken up; and the old names (`thread.meta`, `meta.watch`) still
// answering older windows.
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon, type DaemonExtension } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Hello, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { ego as egoExtension } from '../src/daemon.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-ego-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

// Without the app's list of machines: no superego_machines tool (see tools.test.ts).
const open = async (more: DaemonExtension[] = [], model = 'faux') => {
  process.env.SUPEREGO_MODEL = model
  process.env.SUPEREGO_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [egoExtension(), ...more] })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { daemon, peer, hello, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}
const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const threads = (peer: RpcPeer) => peer.call<ThreadInfo[]>('thread.list', {})
/** Ego's thread as the window follows it: null until it's first opened. */
const egoOf = async (peer: RpcPeer) => (await peer.call<{ value: ThreadInfo | null }>('value.watch', { key: 'ego.thread' })).value

it("keeps superego's own agent as one hidden thread per machine, in its data folder, knowing superego, changing only its setup", async () => {
  const first = await open()
  const meta = await first.peer.call<ThreadInfo>('ego.ask', { prompt: 'help me add a machine' })
  expect(meta).toMatchObject({ ext: { ego: true }, hidden: true, cwd: dir, title: 'superego' })
  const ego = async (peer: RpcPeer) => await egoOf(peer)
  await until(async () => (await ego(first.peer))!.status.state === 'done')
  // The same thread again, not another; and in no list.
  expect((await first.peer.call<ThreadInfo>('ego.ask', {})).id).toBe(meta.id)
  expect(await threads(first.peer)).toEqual([])
  expect(await first.peer.call('thread.list', { archived: true })).toEqual([])
  expect((await first.peer.call<{ value: ThreadInfo[] }>('threads.watch', {})).value).toEqual([])
  // Never archived.
  await expect(first.peer.call('thread.archive', { id: meta.id })).rejects.toMatchObject({ kind: 'invalid' })
  const { value } = await first.peer.call<{ value: ConversationView }>('thread.watch', { id: meta.id })
  const all = JSON.stringify(value.entries)
  expect(all).toContain("You are superego's own agent")
  expect(all).toContain('What you change yourself is setup')
  // Tools that read, and thread_start; settings it changes itself (machines too, where the app gives it the list:
  // see meta.test.ts); nothing that writes files or runs commands.
  const tools = (value.entries.find((e) => e.kind === 'pi.system')!.model![0] as { toolsAdded: { name: string }[] }).toolsAdded.map((t) => t.name)
  expect(tools.sort()).toEqual(['ls', 'open_pane', 'read', 'superego_actions', 'superego_mcp_servers', 'superego_profiles', 'superego_set_setting', 'superego_settings', 'thread_list', 'thread_read', 'thread_start'])
  for (const tool of ['write', 'edit', 'bash', 'superego_run', 'thread_send']) expect(tools).not.toContain(tool)
  // Other threads don't get its tools or prompt, and don't see it.
  const plain = await first.peer.call<ThreadInfo>('thread.create', { cwd: dir, prompt: 'hi' })
  await until(async () => (await threads(first.peer)).find((t) => t.id === plain.id)!.status.state === 'done')
  expect((await threads(first.peer)).map((t) => t.id)).toEqual([plain.id])
  const other = JSON.stringify((await first.peer.call<{ value: ConversationView }>('thread.watch', { id: plain.id })).value.entries)
  expect(other).not.toContain('superego_settings')
  expect(other).not.toContain("You are superego's own agent")
  // A thread started with it as its parent (as from the command line) is top-level all the same.
  const started = await first.peer.call<ThreadInfo>('thread.create', { cwd: dir, parent: meta.id })
  expect(started.parent).toBeUndefined()
  await first.close()
  // Kept across restarts.
  const second = await open()
  expect((await second.peer.call<ThreadInfo>('ego.ask', {})).id).toBe(meta.id)
  expect((await ego(second.peer))!.id).toBe(meta.id)
  await second.close()
})

it('makes one Ego of the meta threads from before it was kept apart, and lists none of them', async () => {
  // A database as an older daemon left it: meta threads among the listed ones, the newest in use, one archived.
  const { Harness, createRegistry, defineDoc } = await import('@earendil-works/pi-durable')
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
  const { createModels } = await import('@earendil-works/pi-ai/models')
  const Catalog = defineDoc<{ ids: number[] }>({ kind: 'superego.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true })
  const ThreadDoc = defineDoc<{ title: string; cwd: string; createdAt: number; meta?: boolean; archived?: boolean }>({
    kind: 'superego.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ title: '', cwd: '', createdAt: 0 }), checkpointWhen: () => true,
  })
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context')
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'superego.sqlite')), { models: createModels(), registry: createRegistry() }, context)
  const ids: number[] = []
  for (const meta of [{ title: 'Set up superego', meta: true }, { title: 'Plain' }, { title: 'Set up superego', meta: true }, { title: 'Set up superego', meta: true, archived: true }]) {
    const conversation = await harness.createConversation({
      ownership: { kind: 'ownerless' }, agent: { cwd: dir },
      init: async (tx, created) => { Object.assign(await tx.doc(ThreadDoc, created), { cwd: dir, createdAt: 1, ...meta }); (await tx.doc(Catalog)).ids.push(created) },
    }, context)
    ids.push(Number(conversation.id))
  }
  await harness.close(context)
  const { peer, close } = await open()
  expect((await threads(peer)).map((t) => t.title)).toEqual(['Plain'])
  expect(await peer.call('thread.list', { archived: true })).toEqual([])
  expect(await peer.call<ThreadInfo>('ego.ask', {})).toMatchObject({ id: String(ids[2]), ext: { ego: true }, title: 'superego' })
  // The others stay out of sight: hidden (the archived one archived still), and not Ego.
  const hidden = (await peer.call<{ value: ThreadInfo[] }>('threads.watch', { hidden: true })).value
  expect(hidden.map((t) => t.id).sort()).toEqual([ids[0], ids[2]].map(String).sort())
  expect((await egoOf(peer))!.id).toBe(String(ids[2]))
  await close()
})

it("takes up the Ego the core kept apart in its catalog, as a hidden thread", async () => {
  const { Harness, createRegistry, defineDoc } = await import('@earendil-works/pi-durable')
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
  const { createModels } = await import('@earendil-works/pi-ai/models')
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context')
  const Catalog = defineDoc<{ ids: number[]; ego?: number }>({ kind: 'superego.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true })
  const ThreadDoc = defineDoc<{ title: string; cwd: string; createdAt: number; meta?: boolean }>({
    kind: 'superego.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ title: '', cwd: '', createdAt: 0 }), checkpointWhen: () => true,
  })
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'superego.sqlite')), { models: createModels(), registry: createRegistry() }, context)
  const ids: number[] = []
  for (const meta of [{ title: 'Plain' }, { title: 'superego', meta: true }]) {
    const conversation = await harness.createConversation({
      ownership: { kind: 'ownerless' }, agent: { cwd: dir },
      init: async (tx, created) => {
        Object.assign(await tx.doc(ThreadDoc, created), { cwd: dir, createdAt: 1, ...meta })
        const catalog = await tx.doc(Catalog)
        if (meta.meta) catalog.ego = created
        else catalog.ids.push(created)
      },
    }, context)
    ids.push(Number(conversation.id))
  }
  await harness.close(context)
  const { peer, close } = await open()
  expect((await threads(peer)).map((t) => t.title)).toEqual(['Plain'])
  await until(async () => (await egoOf(peer))?.id === String(ids[1]))
  expect(await peer.call<ThreadInfo>('ego.ask', {})).toMatchObject({ id: String(ids[1]), hidden: true, ext: { ego: true } })
  await close()
})

it("clears superego's own agent: the same thread, starting empty again", async () => {
  const { peer, close } = await open()
  expect(await egoOf(peer)).toBeNull()
  const meta = await peer.call<ThreadInfo>('ego.ask', { prompt: 'what is a profile?' })
  const state = async () => (await egoOf(peer))!.status.state
  await until(async () => await state() === 'done')
  const ended: string[] = []
  peer.on('watch.end', (params: { sub: string; reason: string }) => { ended.push(`${params.sub}:${params.reason}`) })
  const open1 = await peer.call<{ sub: string; value: ConversationView }>('thread.watch', { id: meta.id })
  expect(open1.value.entries.length).toBeGreaterThan(0)
  const cleared = await peer.call<ThreadInfo>('ego.clear', {})
  expect(cleared.id).toBe(meta.id)
  // Windows watching it are told to watch again; then it's empty, with nothing earlier to page back to.
  await until(() => ended.includes(`${open1.sub}:stopped`))
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: meta.id })
  expect(value.entries).toEqual([])
  expect(value.before).toBeUndefined()
  expect(await peer.call('thread.history', { id: meta.id, before: open1.value.entries.at(-1)!.id as number + 1000 })).toEqual({ entries: [], more: false })
  expect((await peer.call<ThreadInfo>('ego.ask', {})).id).toBe(meta.id)
  // It goes on from there.
  await peer.call('thread.submit', { id: meta.id, text: 'again' })
  await until(async () => await state() === 'done')
  const after = (await peer.call<{ value: ConversationView }>('thread.watch', { id: meta.id })).value.entries
  expect(JSON.stringify(after)).toContain('again')
  expect(JSON.stringify(after)).not.toContain('what is a profile?')
  await close()
})


it('answers older windows by the old names: thread.meta, thread.meta.clear, meta.watch and the ego feature', async () => {
  const { peer, hello, close } = await open()
  expect(hello.features).toEqual(expect.arrayContaining(['ext:ego', 'ego']))
  expect((await peer.call<{ value: ThreadInfo | null }>('meta.watch', {})).value).toBeNull()
  const meta = await peer.call<ThreadInfo>('thread.meta', { prompt: 'hi' })
  expect(meta.ext).toEqual({ ego: true })
  // What they tell Ego's thread by: Clear, not Archive.
  expect((meta as { meta?: boolean }).meta).toBe(true)
  await until(async () => (await peer.call<{ value: ThreadInfo | null }>('meta.watch', {})).value?.status.state === 'done')
  expect((await peer.call<ThreadInfo>('action.run', { id: 'thread.meta.clear', params: {}, exposure: 'cli' })).id).toBe(meta.id)
  await close()
})

it('takes no messages while switched off: its thread is never run as an ordinary one', async () => {
  const { peer, hello, close } = await open()
  expect(hello.features).toContain('ext:ego')
  const meta = await peer.call<ThreadInfo>('ego.ask', {})
  await peer.call('settings.set', { key: 'extensions.ego', value: false })
  await until(async () => !(await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })).features.includes('ext:ego'))
  await expect(peer.call('thread.submit', { id: meta.id, text: 'hi' })).rejects.toMatchObject({ kind: 'invalid' })
  await close()
})

it("runs as itself whatever the user's default profile says: none of its prompt, tools or without", async () => {
  const profile = join(dir, 'profiles', 'default')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'Answer in haiku.', extensions: ['./tool.ts'], without: ['ego'] })\n`)
  writeFileSync(join(profile, 'tool.ts'), `import { defineExtension, defineTool } from 'superego'
export default defineExtension({ name: 'haiku', tools: [defineTool({ name: 'haiku_tool', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) })] })
`)
  const { peer, close } = await open()
  const meta = await peer.call<ThreadInfo>('ego.ask', { prompt: 'hi' })
  expect(meta.profile).toBeUndefined()
  expect(meta.without ?? []).not.toContain('ego')
  expect(meta.ext).toEqual({ ego: true })
  await until(async () => (await egoOf(peer))!.status.state === 'done')
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: meta.id })
  const all = JSON.stringify(value.entries)
  expect(all).toContain("You are superego's own agent")
  expect(all).not.toContain('Answer in haiku.')
  const tools = (value.entries.find((e) => e.kind === 'pi.system')!.model![0] as { toolsAdded: { name: string }[] }).toolsAdded.map((t) => t.name)
  for (const tool of ['write', 'edit', 'bash', 'haiku_tool']) expect(tools).not.toContain(tool)
  // An ordinary thread still has the profile, and goes without Ego as it says.
  const plain = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
  expect(plain.profile).toMatchObject({ name: 'default' })
  expect(plain.without).toContain('ego')
  await close()
})

it('finds its thread again when switched on after starting off, instead of making another', async () => {
  const first = await open()
  const meta = await first.peer.call<ThreadInfo>('ego.ask', { prompt: 'hi' })
  expect(meta.owner).toBe('ego')
  await until(async () => (await egoOf(first.peer))!.status.state === 'done')
  await first.peer.call('settings.set', { key: 'extensions.ego', value: false })
  await first.close()
  const second = await open()
  expect(second.hello.features).not.toContain('ext:ego')
  await second.peer.call('settings.set', { key: 'extensions.ego', value: true })
  await until(async () => (await second.peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })).features.includes('ext:ego'))
  expect((await second.peer.call<ThreadInfo>('ego.ask', {})).id).toBe(meta.id)
  expect((await second.peer.call<{ value: ThreadInfo[] }>('threads.watch', { hidden: true })).value.map((t) => t.id)).toEqual([meta.id])
  await second.close()
})

it("isn't archived by another thread's thread_archive either", async () => {
  const { default: threadTools } = await import('@superego/threads/daemon')
  const first = await open()
  const meta = await first.peer.call<ThreadInfo>('ego.ask', {})
  await first.close()
  const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  writeFileSync(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_archive', arguments: { id: meta.id } }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  const { peer, close } = await open([threadTools], `replay:${join(dir, 'turns.jsonl')}`)
  const other = await peer.call<ThreadInfo>('thread.create', { cwd: dir, prompt: 'tidy up' })
  await until(async () => (await threads(peer)).find((t) => t.id === other.id)?.status.state === 'done')
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: other.id })
  expect(JSON.stringify(value.entries)).toContain("superego isn't archived")
  expect((await egoOf(peer))!.archived).toBeUndefined()
  await close()
})
