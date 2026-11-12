import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { defineApp, PROTOCOL_VERSION, type Json, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { linkTo, threadTools, type ThreadsHost } from '../src/thread-tools.ts'

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
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  const parent = await peer.call<ThreadInfo>('thread.create', { prompt: 'split the work', title: 'Parent' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).length === 2)
  const child = (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id !== parent.id)!
  expect(child).toMatchObject({ title: 'Dates', parent: parent.id, cwd: parent.cwd })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).every((t) => t.status.state === 'done'))
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: parent.id })
  expect(JSON.stringify(value.entries)).toContain(`Started [Dates](thread:${child.id})`)
  // What the agents are given has threads, and it can be switched off like the rest.
  const { value: settings } = await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
  expect(settings.sections.find((s) => s.id === 'extensions')!.settings.map((s) => s.key)).toContain('extensions.threads')
  // A thread can be started as another's child directly, too; not of one that isn't there.
  expect(await peer.call<ThreadInfo>('thread.create', { parent: child.id })).toMatchObject({ parent: child.id })
  await expect(peer.call('thread.create', { parent: '999' })).rejects.toMatchObject({ kind: 'not_found' })

  socket.destroy(); server.close(); await daemon.close()
})

/** The tools against a made-up set of threads. */
function host(): ThreadsHost & { threads: ThreadInfo[]; sent: [string, string][] } {
  const thread = (id: string, title: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
    ({ id, title, cwd: '/p', createdAt: 0, activeAt: 0, session: { root: '/p', name: 'p' }, status: { state: 'idle' }, ...extra })
  const threads = [thread('1', 'Parent'), thread('2', 'Child [one]', { parent: '1', status: { state: 'working' } }), thread('3', 'Elsewhere', { session: { root: '/q', name: 'q' } })]
  const sent: [string, string][] = []
  return {
    threads, sent,
    info: async (id) => threads.find((t) => t.id === id),
    list: async () => threads,
    start: async () => { throw new Error('not here') },
    send: async (id, text) => { sent.push([id, text]) },
    answer: async (id) => id === '2' ? 'The dates are UTC now.' : undefined,
  }
}
const tool = (h: ThreadsHost, name: string) => threadTools(h).tools!.find((t) => t.name === name)!
const run = async (h: ThreadsHost, name: string, args: unknown, conversationId = 1, signal?: AbortSignal) => {
  const result = await tool(h, name).execute(args as never, { conversationId } as never, { abortSignal: signal } as never)
  return (result.output as { text: string }[])[0]!.text
}

it('reads a thread: where it stands, who started it, and its last answer, waiting for it when asked', async () => {
  const h = host()
  expect(linkTo(h.threads[1]!)).toBe('[Child one](thread:2)')
  setTimeout(() => { h.threads[1]!.status = { state: 'done' } }, 100)
  const read = await run(h, 'thread_read', { id: '2', wait: true })
  expect(read).toContain('[Child one](thread:2): done')
  expect(read).toContain('Started by [Parent](thread:1).')
  expect(read).toContain('The dates are UTC now.')
  expect(await run(h, 'thread_read', { id: '1' })).toContain('Its threads:\n- [Child one](thread:2)')
  await expect(run(h, 'thread_read', { id: '9' })).rejects.toThrow(/No thread 9/)
})

it('messages a thread from this one, and lists the threads in its project', async () => {
  const h = host()
  expect(await run(h, 'thread_send', { id: '2', text: 'Also ISO dates.' })).toBe('Sent to [Child one](thread:2).')
  expect(h.sent).toEqual([['2', 'From [Parent](thread:1):\n\nAlso ISO dates.']])
  const listed = await run(h, 'thread_list', {})
  expect(listed).toContain('[Child one](thread:2)')
  expect(listed).not.toContain('Elsewhere')
})
