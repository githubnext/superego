import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  expect(settings.sections.find((s) => s.id === 'extensions')!.settings.map((s) => s.key)).toContain('extensions.thread-tools')
  // A thread can be started as another's child directly, too; not of one that isn't there.
  expect(await peer.call<ThreadInfo>('thread.create', { parent: child.id })).toMatchObject({ parent: child.id })
  await expect(peer.call('thread.create', { parent: '999' })).rejects.toMatchObject({ kind: 'not_found' })

  socket.destroy(); server.close(); await daemon.close()
})

it('lets Ego hand work to a thread of its own: top-level in its project, listed, not under Ego', async () => {
  const project = join(dir, 'project')
  await mkdir(project)
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_start', arguments: { prompt: 'Turn on web access', title: 'Web', cwd: project } }], 'toolUse'),
    turn([{ type: 'text', text: 'Started it.' }], 'stop'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  const ego = await peer.call<ThreadInfo>('thread.meta', { prompt: 'turn on web access' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).length === 1)
  const [started] = await peer.call<ThreadInfo[]>('thread.list', {})
  expect(started).toMatchObject({ title: 'Web', cwd: project, session: { root: project } })
  expect(started!.parent).toBeUndefined()
  await until(async () => (await peer.call<{ value: ThreadInfo }>('meta.watch', {})).value.status.state === 'done')
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: ego.id })
  expect(JSON.stringify(value.entries)).toContain(`Started [Web](thread:${started!.id})`)

  socket.destroy(); server.close(); await daemon.close()
})

it("lets Ego change this machine's settings itself", async () => {
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'superego_set_setting', arguments: { key: 'web.port', value: 8888 } }], 'toolUse'),
    turn([{ type: 'text', text: 'Set.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  await peer.call<ThreadInfo>('thread.meta', { prompt: 'serve the app on port 8888' })
  await until(async () => (await peer.call<{ value: ThreadInfo }>('meta.watch', {})).value.status.state === 'done')
  expect((await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})).value.values['web.port']).toBe(8888)
  expect(await peer.call('thread.list', {})).toEqual([])

  socket.destroy(); server.close(); await daemon.close()
})

it('lets an agent archive another thread, and its own once its turn ends; never Ego', async () => {
  const { execFileSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', dir])
  await writeFile(join(dir, 'readme.md'), 'hi\n')
  await writeFile(join(dir, '.gitignore'), '*\n!readme.md\n!.gitignore\n')
  git('add', '.'); git('commit', '-q', '-m', 'start')
  const open = async () => {
    const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
    const server = await listen(daemon, join(dir, 's.sock'))
    const { peer, socket } = await connectSocket(join(dir, 's.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
  }
  // Ego and a child first, for their ids; then the thread that archives them.
  const first = await open()
  const ego = await first.peer.call<ThreadInfo>('thread.meta', {})
  const child = await first.peer.call<ThreadInfo>('thread.create', { cwd: dir, title: 'Child', worktree: true })
  await first.close()
  // Ego refused, the child archived, then itself; and it carries on to the end of its turn.
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_archive', arguments: { id: ego.id } }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c2', name: 'thread_archive', arguments: { id: child.id } }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c3', name: 'thread_archive', arguments: {} }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c4', name: 'bash', arguments: { command: 'ls' } }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const { peer, close } = await open()
  const self = await peer.call<ThreadInfo>('thread.create', { cwd: dir, title: 'Self', worktree: true, prompt: 'tidy up' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', { archived: true })).length === 2)
  const archived = await peer.call<ThreadInfo[]>('thread.list', { archived: true })
  expect(archived.map((t) => t.id)).toEqual([self.id, child.id])
  // Archived once its turn was over: it ran to the end, and isn't left working.
  expect(archived[0]!.status.state).toBe('done')
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: self.id })
  const entries = JSON.stringify(value.entries)
  expect(entries).toContain("test isn't archived")
  expect(entries).toContain(`Archived [Child](thread:${child.id}); its worktree is removed, its branch kept.`)
  expect(entries).toContain('This thread will be archived when this turn ends.')
  expect(entries).toContain('readme.md') // its worktree was still there for the rest of the turn
  expect(entries).toContain('Done.')
  // Both worktrees gone, both branches kept; Ego still there.
  for (const t of [child, self]) {
    expect(existsSync(t.worktree!.path)).toBe(false)
    expect(git('branch', '--list', t.worktree!.branch)).toContain(t.worktree!.branch)
  }
  expect((await peer.call<{ value: ThreadInfo }>('meta.watch', {})).value.archived).toBeUndefined()
  await expect(peer.call('thread.submit', { id: self.id, text: 'hi' })).rejects.toMatchObject({ kind: 'archived' })
  await close()
})

/** The tools against a made-up set of threads. */
function host(): ThreadsHost & { threads: ThreadInfo[]; sent: [string, string][]; archived: string[] } {
  const thread = (id: string, title: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
    ({ id, title, cwd: '/p', createdAt: 0, activeAt: 0, session: { root: '/p', name: 'p' }, status: { state: 'idle' }, ...extra })
  const threads = [thread('1', 'Parent'), thread('2', 'Child [one]', { parent: '1', status: { state: 'working' } }), thread('3', 'Elsewhere', { session: { root: '/q', name: 'q' } })]
  const sent: [string, string][] = []
  const archived: string[] = []
  return {
    threads, sent, archived,
    info: async (id) => threads.find((t) => t.id === id),
    list: async () => threads,
    start: async () => { throw new Error('not here') },
    send: async (id, text) => { sent.push([id, text]) },
    answer: async (id) => id === '2' ? 'The dates are UTC now.' : undefined,
    archive: async (id) => { archived.push(id); threads.find((t) => t.id === id)!.archived = true; return { worktree: 'kept' } },
    archiveWhenDone: async (id) => { archived.push(`${id} when done`) },
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

it("archives a thread that isn't working, and this one only when its turn ends", async () => {
  const h = host()
  // Working, it's left be.
  await expect(run(h, 'thread_archive', { id: '2' })).rejects.toThrow('[Child one](thread:2) is working: wait for it with thread_read (wait: true), then archive it')
  await expect(run(h, 'thread_archive', { id: '9' })).rejects.toThrow(/No thread 9/)
  expect(h.archived).toEqual([])
  h.threads[1]!.status = { state: 'done' }
  expect(await run(h, 'thread_archive', { id: '2' })).toBe('Archived [Child one](thread:2); its worktree has uncommitted changes, so it stays.')
  await expect(run(h, 'thread_archive', { id: '2' })).rejects.toThrow('[Child one](thread:2) is already archived')
  // Itself, by no id or its own.
  expect(await run(h, 'thread_archive', {})).toBe('This thread will be archived when this turn ends.')
  expect(await run(h, 'thread_archive', { id: '3' }, 3)).toBe('This thread will be archived when this turn ends.')
  expect(h.archived).toEqual(['2', '1 when done', '3 when done'])
})
