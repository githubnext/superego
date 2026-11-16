import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { MemorySettingsStore } from '@superego/settings'
import { defineApp, NOTE_ENTRY, PROTOCOL_VERSION, type Json, type RpcPeer, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon } from '@superego/daemon'
import threadTools from '../src/daemon.ts'
import { linkTo, threadTools as tools, type ThreadsHost } from '../src/tools.ts'

const app = defineApp({ name: 'test', id: 'threadstest' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-threads-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.THREADSTEST_MODEL })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })

it('lets an agent start a thread of its own: a child, listed with its parent', async () => {
  // The parent starts a child, then both answer (in whichever order they ask).
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_start', arguments: { prompt: 'Look into the dates', title: 'Dates' } }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [threadTools] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  const parent = await peer.call<ThreadInfo>('thread.start', { prompt: 'split the work', title: 'Parent' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).length === 2)
  const child = (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id !== parent.id)!
  expect(child).toMatchObject({ title: 'Dates', parent: parent.id, cwd: parent.cwd })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).every((t) => t.status.state === 'done'))
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: parent.id })
  expect(JSON.stringify(value.entries)).toContain(`Started [Dates](thread:${child.id})`)
  // What the agents are given has threads, and it can be switched off like the rest.
  const { value: settings } = await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
  expect(settings.sections.find((s) => s.id === 'extensions')!.settings.map((s) => s.key)).toContain('extensions.thread-tools')
  // A thread can be started as another's child directly, too; not of one that isn't there.
  expect(await peer.call<ThreadInfo>('thread.start', { parent: child.id })).toMatchObject({ parent: child.id })
  await expect(peer.call('thread.start', { parent: '999' })).rejects.toMatchObject({ kind: 'not_found' })

  socket.destroy(); server.close(); await daemon.close()
})

it("lets an agent archive another thread, and its own once its turn ends; told what archiving did, or that it was refused", async () => {
  // Refuses to archive the thread titled Kept; says what it did when archiving another.
  const keeper = defineDaemonExtension({
    name: 'keeper',
    setup(superego) {
      superego.thread({
        archiving(t) { if (t.title === 'Kept') throw new Error('Kept is kept') },
        archived: () => ({ note: 'Tidied up.' }),
      })
    },
  })
  const open = async () => {
    const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [threadTools, keeper] })
    const server = await listen(daemon, join(dir, 's.sock'))
    const { peer, socket } = await connectSocket(join(dir, 's.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
  }
  // The other threads first, for their ids; then the thread that archives them.
  const first = await open()
  const kept = await first.peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'Kept' })
  const child = await first.peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'Child' })
  await first.close()
  // Kept refused, the child archived, then itself; and it carries on to the end of its turn.
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_archive', arguments: { thread: kept.id } }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c2', name: 'thread_archive', arguments: { thread: child.id } }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c3', name: 'thread_archive', arguments: {} }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c4', name: 'thread_list', arguments: {} }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const { peer, close } = await open()
  const self = await peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'Self', prompt: 'tidy up' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', { archived: true })).length === 2)
  const archived = await peer.call<ThreadInfo[]>('thread.list', { archived: true })
  expect(archived.map((t) => t.id)).toEqual([self.id, child.id])
  // Archived once its turn was over: it ran to the end, and isn't left working.
  expect(archived[0]!.status.state).toBe('done')
  // What archiving itself did is said in it, as Superego's note: its turn was over, so the agent wasn't there to say it.
  await until(async () => JSON.stringify((await peer.call<{ value: ConversationView }>('thread.watch', { thread: self.id })).value.entries).includes('Archived. Tidied up.'))
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: self.id })
  const entries = JSON.stringify(value.entries)
  expect(value.entries.find((e) => e.kind === NOTE_ENTRY)?.data).toEqual({ text: 'Archived. Tidied up.' })
  expect(entries).toContain('Kept is kept')
  expect(entries).toContain(`Archived [Child](thread:${child.id}). Tidied up.`)
  expect(entries).toContain('This thread will be archived when this turn ends.')
  expect(entries).toContain(`[Kept](thread:${kept.id})`) // thread_list, after it asked to be archived
  expect(entries).toContain('Done.')
  expect((await peer.call<ThreadInfo[]>('thread.list', {})).map((t) => t.id)).toEqual([kept.id])
  await expect(peer.call('thread.send', { thread: self.id, text: 'hi' })).rejects.toMatchObject({ kind: 'archived' })
  await close()
})

it("says in the thread when it couldn't archive itself, and doesn't try again", async () => {
  // An extension that keeps every thread: its own self-archive, at the end of its turn, is refused.
  const keeper = defineDaemonExtension({ name: 'keeper', setup: (s) => s.thread({ archiving() { throw new Error('Kept for the record') } }) })
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_archive', arguments: {} }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [threadTools, keeper] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'tidy up' })
  const notes = async () => (await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })).value.entries.filter((e) => e.kind === NOTE_ENTRY)
  await until(async () => (await notes()).length > 0)
  expect((await notes()).map((e) => e.data)).toEqual([{ text: "Couldn't archive this thread: keeper: Kept for the record" }])
  // Given up: the thread stays, and seeing it (a new watch value) doesn't try, and say so, again.
  await peer.call('thread.seen', { thread: thread.id })
  await new Promise((r) => setTimeout(r, 200))
  expect(await notes()).toHaveLength(1)
  expect((await peer.call<ThreadInfo[]>('thread.list', {})).map((t) => t.id)).toEqual([thread.id])
  socket.destroy(); server.close(); await daemon.close()
})

/** A daemon with the thread tools, its model faux; `settings` stored before it opens. */
async function open(settings: Record<string, Json> = {}) {
  process.env.THREADSTEST_MODEL = 'faux'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [threadTools], settingsStore: new MemorySettingsStore(settings) })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { daemon, peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}
/** The agent parts a thread's agent has, once it has run a turn. */
async function partsOf(peer: RpcPeer, prompt: string, cwd = dir) {
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd, prompt })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)?.status.state === 'done')
  const { value } = await peer.call<{ value: { docs: Record<string, { extensions?: string[] }> } }>('thread.watch', { thread: thread.id })
  return { thread: (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!, parts: value.docs['pi.agent']?.extensions ?? [] }
}

it('is a switch of its own in Settings: off, the agent goes without the tools', async () => {
  const { peer, close } = await open()
  expect((await partsOf(peer, 'hi')).parts).toContain('thread-tools')
  const { value } = await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
  expect(value.sections.find((s) => s.id === 'extensions')!.settings.find((s) => s.key === 'extensions.thread-tools')).toMatchObject({ title: 'Thread tools', default: true })
  await peer.call('settings.set', { key: 'extensions.thread-tools', value: false })
  const off = await partsOf(peer, 'hi again')
  expect(off.parts).not.toContain('thread-tools')
  expect(off.thread.without).toContain('thread-tools')
  await close()
})

/** The tools against a made-up set of threads. */
function host(): ThreadsHost & { threads: ThreadInfo[]; sent: [string, string][]; archived: string[] } {
  const thread = (id: string, title: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
    ({ id, title, cwd: '/p', createdAt: 0, activeAt: 0, project: { root: '/p', name: 'p' }, status: { state: 'idle' }, ...extra })
  const threads = [thread('1', 'Parent'), thread('2', 'Child [one]', { parent: '1', status: { state: 'working' } }), thread('3', 'Elsewhere', { project: { root: '/q', name: 'q' } })]
  const sent: [string, string][] = []
  const archived: string[] = []
  return {
    threads, sent, archived,
    info: async (id) => threads.find((t) => t.id === id),
    list: async () => threads,
    start: async () => { throw new Error('not here') },
    send: async (id, text) => { sent.push([id, text]) },
    answer: async (id) => id === '2' ? 'The dates are UTC now.' : undefined,
    archive: async (id) => { archived.push(id); threads.find((t) => t.id === id)!.archived = true; return { notes: { worktrees: 'Kept the worktree /w: it has uncommitted changes.' } } },
    archiveWhenDone: async (id) => { archived.push(`${id} when done`) },
  }
}
const tool = (h: ThreadsHost, name: string) => tools(h).tools!.find((t) => t.name === name)!
const run = async (h: ThreadsHost, name: string, args: unknown, conversationId = 1, signal?: AbortSignal) => {
  const result = await tool(h, name).execute(args as never, { conversationId } as never, { abortSignal: signal } as never)
  return (result.output as { text: string }[])[0]!.text
}

it('reads a thread: where it stands, who started it, and its last answer, waiting for it when asked', async () => {
  const h = host()
  expect(linkTo(h.threads[1]!)).toBe('[Child one](thread:2)')
  setTimeout(() => { h.threads[1]!.status = { state: 'done' } }, 100)
  const read = await run(h, 'thread_read', { thread: '2', wait: true })
  expect(read).toContain('[Child one](thread:2): done')
  expect(read).toContain('Started by [Parent](thread:1).')
  expect(read).toContain('The dates are UTC now.')
  expect(await run(h, 'thread_read', { thread: '1' })).toContain('Its threads:\n- [Child one](thread:2)')
  await expect(run(h, 'thread_read', { thread: '9' })).rejects.toThrow(/No thread 9/)
})

it('messages a thread from this one, and lists the threads in its project', async () => {
  const h = host()
  expect(await run(h, 'thread_send', { thread: '2', text: 'Also ISO dates.' })).toBe('Sent to [Child one](thread:2).')
  expect(h.sent).toEqual([['2', 'From [Parent](thread:1):\n\nAlso ISO dates.']])
  const listed = await run(h, 'thread_list', {})
  expect(listed).toContain('[Child one](thread:2)')
  expect(listed).not.toContain('Elsewhere')
})

it("archives a thread that isn't working, and this one only when its turn ends", async () => {
  const h = host()
  // Working, it's left be.
  await expect(run(h, 'thread_archive', { thread: '2' })).rejects.toThrow('[Child one](thread:2) is working: wait for it with thread_read (wait: true), then archive it')
  await expect(run(h, 'thread_archive', { thread: '9' })).rejects.toThrow(/No thread 9/)
  expect(h.archived).toEqual([])
  h.threads[1]!.status = { state: 'done' }
  expect(await run(h, 'thread_archive', { thread: '2' })).toBe('Archived [Child one](thread:2). Kept the worktree /w: it has uncommitted changes.')
  await expect(run(h, 'thread_archive', { thread: '2' })).rejects.toThrow('[Child one](thread:2) is already archived')
  // Itself, by no id or its own.
  expect(await run(h, 'thread_archive', {})).toBe('This thread will be archived when this turn ends.')
  expect(await run(h, 'thread_archive', { thread: '3' }, 3)).toBe('This thread will be archived when this turn ends.')
  expect(h.archived).toEqual(['2', '1 when done', '3 when done'])
})
