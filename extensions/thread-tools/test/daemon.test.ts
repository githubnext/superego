// The thread tools: end to end in a daemon with a scripted model, and each tool against a made-up set of threads.
import { expect, it } from 'vitest'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { defineDaemonExtension } from '@superego/daemon'
import { linkTo, NOTE_ENTRY, obj, type ThreadInfo, type SettingsSnapshot } from '@superego/protocol'
import { callTool, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import threadTools from '../src/daemon.ts'
import { listTool, threadTools as tools, type ThreadsHost } from '../src/tools.ts'

const list = (daemon: TestDaemon, archived = false) => daemon.call<ThreadInfo[]>('thread.list', { archived })
const notes = async (daemon: TestDaemon, id: string) => (JSON.parse(await daemon.transcript(id)) as { kind: string; data?: unknown }[]).filter((e) => e.kind === NOTE_ENTRY)

it('lets an agent start a thread of its own: a child, listed with its parent', async () => {
  // The parent starts a child, then both answer (in whichever order they ask).
  const daemon = await testDaemon({ extensions: [threadTools], model: [callTool('thread_start', { prompt: 'Look into the dates', title: 'Dates' }), say('Done.'), say('Done.')] })
  const parent = await daemon.thread('split the work', { title: 'Parent' })
  await daemon.until(async () => (await list(daemon)).length === 2, 'the child')
  const child = (await list(daemon)).find((t) => t.id !== parent.id)!
  expect(child).toMatchObject({ title: 'Dates', parent: parent.id, cwd: parent.cwd })
  await daemon.idle(child.id)
  expect(await daemon.transcript(parent.id)).toContain(`Started [Dates](thread:${child.id})`)
  // What the agents are given has threads, and it can be switched off like the rest.
  const { value: settings } = await daemon.call<{ value: SettingsSnapshot }>('settings.watch', {})
  expect(settings.sections.find((s) => s.id === 'extensions')!.settings.map((s) => s.key)).toContain('extensions.thread-tools')
  // A thread can be started as another's child directly, too; not of one that isn't there.
  expect(await daemon.call<ThreadInfo>('thread.start', { parent: child.id })).toMatchObject({ parent: child.id })
  await expect(daemon.call('thread.start', { parent: '999' })).rejects.toMatchObject({ kind: 'not_found' })
  await daemon.close()
})

it('waits on a thread with thread_read until its run ends, and reads its answer', async () => {
  // The child's run holds in a tool until the test lets it go.
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const holder = defineDaemonExtension({
    name: 'holder',
    setup(s) {
      s.agent(defineExtension({ name: 'holder', tools: [defineTool({ name: 'hold', description: 'Hold.', parameters: obj({}), execute: async () => { await held; return { output: [{ type: 'text', text: 'held' }] } } })] }))
    },
  })
  // The threads first, for their ids; then the child holds, and the parent waits on it.
  const first = await testDaemon({ extensions: [threadTools, holder] })
  const parent = await first.thread()
  const child = await first.call<ThreadInfo>('thread.start', { parent: parent.id })
  const daemon = await first.restart({ model: [callTool('hold'), callTool('thread_read', { thread: child.id, wait: true }), say('Dates are UTC.'), say('Read it.')] })
  await daemon.call('thread.send', { thread: child.id, text: 'go' })
  await daemon.until(async () => (await daemon.transcript(child.id)).includes('"hold"'), 'the child to hold')
  await daemon.call('thread.send', { thread: parent.id, text: 'wait for it' })
  await daemon.until(async () => (await daemon.transcript(parent.id)).includes('"thread_read"'), 'the parent to wait')
  release()
  await daemon.idle(child.id)
  await daemon.until(async () => (await daemon.transcript(parent.id)).includes('Read it.'), 'the parent to read it')
  expect(await daemon.transcript(parent.id)).toContain('Its last answer:\\nDates are UTC.')
  await daemon.close()
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
  // The other threads first, for their ids; then the thread that archives them.
  const first = await testDaemon({ extensions: [threadTools, keeper] })
  const kept = await first.thread(undefined, { title: 'Kept' })
  const child = await first.thread(undefined, { title: 'Child' })
  // Kept refused, the child archived, then itself; and it carries on to the end of its turn.
  const daemon = await first.restart({ model: [
    callTool('thread_archive', { thread: kept.id }), callTool('thread_archive', { thread: child.id }), callTool('thread_archive'), callTool('thread_list'), say('Done.'),
  ] })
  const self = await daemon.thread(undefined, { title: 'Self' })
  await daemon.call('thread.send', { thread: self.id, text: 'tidy up' })
  await daemon.until(async () => (await list(daemon, true)).length === 2, 'both archived')
  const archived = await list(daemon, true)
  expect(archived.map((t) => t.id)).toEqual([self.id, child.id])
  // Archived once its turn was over: it ran to the end, and isn't left working.
  expect(archived[0]!.status.state).toBe('done')
  // What archiving itself did is said in it, as Superego's note: its turn was over, so the agent wasn't there to say it.
  await daemon.until(async () => (await notes(daemon, self.id)).length > 0, 'the note')
  expect((await notes(daemon, self.id))[0]?.data).toEqual({ text: 'Archived. Tidied up.' })
  const entries = await daemon.transcript(self.id)
  expect(entries).toContain('Kept is kept')
  expect(entries).toContain(`Archived [Child](thread:${child.id}). Tidied up.`)
  expect(entries).toContain('This thread will be archived when this turn ends.')
  expect(entries).toContain(`[Kept](thread:${kept.id})`) // thread_list, after it asked to be archived
  expect(entries).toContain('Done.')
  expect((await list(daemon)).map((t) => t.id)).toEqual([kept.id])
  await expect(daemon.call('thread.send', { thread: self.id, text: 'hi' })).rejects.toMatchObject({ kind: 'archived' })
  await daemon.close()
})

it("says in the thread when it couldn't archive itself, and doesn't try again", async () => {
  // An extension that keeps every thread: its own self-archive, at the end of its turn, is refused.
  const keeper = defineDaemonExtension({ name: 'keeper', setup: (s) => s.thread({ archiving() { throw new Error('Kept for the record') } }) })
  const daemon = await testDaemon({ extensions: [threadTools, keeper], model: [callTool('thread_archive'), say('Done.')] })
  const thread = await daemon.thread('tidy up')
  await daemon.until(async () => (await notes(daemon, thread.id)).length > 0, 'the note')
  expect((await notes(daemon, thread.id)).map((e) => e.data)).toEqual([{ text: "Couldn't archive this thread: keeper: Kept for the record" }])
  // Given up: the thread stays, and seeing it (a new watch value) doesn't try, and say so, again.
  await daemon.call('thread.seen', { thread: thread.id })
  // Nothing to wait for: a second note would come within this.
  await new Promise((r) => setTimeout(r, 200))
  expect(await notes(daemon, thread.id)).toHaveLength(1)
  expect((await list(daemon)).map((t) => t.id)).toEqual([thread.id])
  await daemon.close()
})

it('is a switch of its own in Settings: off, the agent goes without the tools', async () => {
  const daemon = await testDaemon({ extensions: [threadTools], model: [say('hi'), say('hi again')] })
  const partsOf = async (id: string) => {
    const { value } = await daemon.call<{ value: { docs: Record<string, { extensions?: string[] }> } }>('thread.watch', { thread: id })
    return value.docs['pi.agent']?.extensions ?? []
  }
  expect(await partsOf((await daemon.thread('hi')).id)).toContain('thread-tools')
  const { value } = await daemon.call<{ value: SettingsSnapshot }>('settings.watch', {})
  expect(value.sections.find((s) => s.id === 'extensions')!.settings.find((s) => s.key === 'extensions.thread-tools')).toMatchObject({ title: 'Thread tools', default: true })
  await daemon.call('settings.set', { key: 'extensions.thread-tools', value: false })
  const off = await daemon.thread('hi again')
  expect(await partsOf(off.id)).not.toContain('thread-tools')
  expect(off.without).toContain('thread-tools')
  await daemon.close()
})

/** The tools against a made-up set of threads. */
function host(): ThreadsHost & { threads: ThreadInfo[]; sent: [string, string, string][]; archived: string[]; finish(id: string): void } {
  const thread = (id: string, title: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
    ({ id, title, cwd: '/p', createdAt: 0, activeAt: 0, project: { root: '/p', name: 'p' }, status: { state: 'idle' }, ...extra })
  const threads = [thread('1', 'Parent'), thread('2', 'Child [one]', { parent: '1', status: { state: 'working' } }), thread('3', 'Elsewhere', { project: { root: '/q', name: 'q' } })]
  const sent: [string, string, string][] = []
  const archived: string[] = []
  const waiting = new Map<string, () => void>()
  const find = (id: string) => threads.find((t) => t.id === id)!
  return {
    threads, sent, archived,
    finish(id) { find(id).status = { state: 'done' }; waiting.get(id)?.() },
    async idle(id, signal) {
      if (find(id).status.state === 'working') await new Promise<void>((resolve) => { waiting.set(id, resolve); if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve()) })
      return find(id)
    },
    info: async (id) => threads.find((t) => t.id === id),
    list: async () => threads,
    start: async () => { throw new Error('not here') },
    send: async (id, text, from) => { sent.push([id, text, from]) },
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
  const reading = run(h, 'thread_read', { thread: '2', wait: true })
  h.finish('2')
  const read = await reading
  expect(read).toContain('[Child one](thread:2): done')
  expect(read).toContain('Started by [Parent](thread:1).')
  expect(read).toContain('The dates are UTC now.')
  expect(await run(h, 'thread_read', { thread: '1' })).toContain('Its threads:\n- [Child one](thread:2)')
  await expect(run(h, 'thread_read', { thread: '9' })).rejects.toThrow(/No thread 9/)
  // Stopped while it waits.
  h.threads[1]!.status = { state: 'working' }
  const stop = new AbortController()
  const stopped = run(h, 'thread_read', { thread: '2', wait: true }, 1, stop.signal)
  stop.abort()
  await expect(stopped).rejects.toThrow('Stopped waiting')
})

it('notes what a thread read, for its reports (threads.noteRead)', async () => {
  const reads: [string, ThreadInfo][] = []
  const h = { ...host(), read: async (reader: string, read: ThreadInfo) => { reads.push([reader, read]) } }
  await run(h, 'thread_read', { thread: '2' })
  expect(reads).toEqual([['1', h.threads[1]]])
})

it('messages a thread from this one, and lists the threads in its project', async () => {
  const h = host()
  expect(await run(h, 'thread_send', { thread: '2', text: 'Also ISO dates.' })).toBe('Sent to [Child one](thread:2).')
  expect(h.sent).toEqual([['2', 'From [Parent](thread:1):\n\nAlso ISO dates.', '1']])
  const listed = await run(h, 'thread_list', {})
  expect(listed).toContain('[Child one](thread:2)')
  expect(listed).not.toContain('Elsewhere')
})

it("lists all of a machine's threads by project, for an agent that isn't one of them (listTool)", async () => {
  const h = host()
  const result = await listTool(h, 'all').execute({} as never, { conversationId: 99 } as never, {} as never)
  expect((result.output as { text: string }[])[0]!.text).toBe([
    'p (/p):\n- [Parent](thread:1): idle, in /p\n- [Child one](thread:2): working, in /p, started by [Parent](thread:1)',
    'q (/q):\n- [Elsewhere](thread:3): idle, in /p',
  ].join('\n\n'))
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
