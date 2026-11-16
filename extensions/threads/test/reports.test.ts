// Report-back: a child's run ending (or its question) told to its parent, batched, and not when the parent read it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Json, type ThreadInfo } from '@superego/protocol'
import threadTools from '../src/daemon.ts'
import { readLog } from '../src/reads.ts'
import threadReports, { excerpt, reporter, threadReports as withBatching, type ReportsHost } from '../src/reports.ts'
import { threadTools as tools } from '../src/tools.ts'

const thread = (id: string, title: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title, cwd: '/p', createdAt: 0, activeAt: 1, project: { root: '/p', name: 'p' }, status: { state: 'done' }, ...extra })

/** Threads 1 (the parent), 2 and 3 (its children) and 4 (2's child), with their answers; what's sent, by whom. */
function host() {
  const threads = [thread('1', 'Lead'), thread('2', 'Dates', { parent: '1' }), thread('3', 'Icons', { parent: '1' }), thread('4', 'Deep', { parent: '2' })]
  const answers: Record<string, string> = { 2: 'Dates are UTC now.\nAll tests pass.', 3: 'Icons swapped.', 4: 'Found it.' }
  const sent: [string, string][] = []
  const reads = readLog()
  const h: ReportsHost = {
    info: async (id) => threads.find((t) => t.id === id),
    answer: async (id) => answers[id],
    send: async (id, text) => { sent.push([id, text]) },
    read: (t) => reads.read(t),
  }
  return { threads, sent, reads, h, find: (id: string) => threads.find((t) => t.id === id)! }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it("tells a parent its child finished, with the answer's first lines, after a quiet moment", async () => {
  const { h, sent, find } = host()
  const reports = reporter(h, { quietMs: 5_000, maxMs: 30_000 })
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(4_000)
  expect(sent).toEqual([])
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sent).toEqual([['1', 'From [Dates](thread:2): finished.\n\nDates are UTC now.\nAll tests pass.']])
})

it('batches reports that come close together into one message, a later one of a thread replacing its earlier', async () => {
  const { h, sent, find } = host()
  const reports = reporter(h, { quietMs: 5_000, maxMs: 12_000 })
  await reports.report({ ...find('2'), status: { state: 'blocked', kind: 'question', msg: 'UTC or local?' } })
  await vi.advanceTimersByTimeAsync(4_000)
  await reports.report(find('3'))
  await vi.advanceTimersByTimeAsync(4_000)
  await reports.report(find('2'))
  expect(sent).toEqual([])
  await vi.advanceTimersByTimeAsync(5_000)
  expect(sent).toEqual([['1', 'From [Icons](thread:3): finished.\n\nIcons swapped.\n\n---\n\nFrom [Dates](thread:2): finished.\n\nDates are UTC now.\nAll tests pass.']])
  // Never held past maxMs from the first, however many keep coming.
  sent.length = 0
  for (let i = 0; i < 5; i++) { await reports.report(find('3')); await vi.advanceTimersByTimeAsync(3_000) }
  expect(sent).toHaveLength(1)
})

it('says when a child errored or waits on a question', async () => {
  const { h, sent, find } = host()
  const reports = reporter(h, { quietMs: 10, maxMs: 10 })
  await reports.report({ ...find('2'), status: { state: 'error', msg: 'provider 503\nretry later' } })
  await vi.advanceTimersByTimeAsync(10)
  await reports.report({ ...find('3'), status: { state: 'blocked', kind: 'question', msg: 'Which icon set?' } })
  await vi.advanceTimersByTimeAsync(10)
  expect(sent).toEqual([
    ['1', 'From [Dates](thread:2): errored (provider 503).'],
    ['1', 'From [Icons](thread:3): is waiting on a question:\n\nWhich icon set?'],
  ])
})

it("skips what the parent read already: by thread_read, waiting on it or after; not another's read, nor one from before", async () => {
  const { h, sent, find, reads } = host()
  const reports = reporter(h, { quietMs: 1_000, maxMs: 1_000 })
  // Read while it was still working: not the answer. Read by another thread: not the parent's.
  reads.note('1', { ...find('2'), status: { state: 'working' } })
  reads.note('3', find('2'))
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sent).toHaveLength(1)
  // Read by its parent once done (a wait returning), before or after the report: nothing more.
  reads.note('1', find('2'))
  await reports.report(find('2'))
  await reports.report(find('3'))
  reads.note('1', find('3'))
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sent).toHaveLength(1)
  // Its next answer is news again.
  find('2').activeAt = 2
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sent).toHaveLength(2)
})

it("goes to each thread's own parent: a grandchild reports to its parent, not further up; none to an archived parent or a top-level thread", async () => {
  const { h, sent, find } = host()
  const reports = reporter(h, { quietMs: 10, maxMs: 10 })
  await reports.report(find('4'))
  await reports.report(find('1'))
  await reports.report({ ...find('3'), status: { state: 'working' } })
  await vi.advanceTimersByTimeAsync(10)
  expect(sent).toEqual([['2', 'From [Deep](thread:4): finished.\n\nFound it.']])
  find('1').archived = true
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(10)
  expect(sent).toHaveLength(1)
})

it("doesn't relay to a parent that goes without reports; drops what's waiting when stopped", async () => {
  const { h, sent, find } = host()
  const reports = reporter(h, { quietMs: 10, maxMs: 10 })
  find('1').without = ['thread-reports']
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(10)
  find('1').without = undefined
  await reports.report(find('2'))
  reports.stop()
  await vi.advanceTimersByTimeAsync(10)
  expect(sent).toEqual([])
})

it('keeps a long answer to its first lines', () => {
  expect(excerpt('a\nb')).toBe('a\nb')
  expect(excerpt('1\n2\n3\n4\n5\n6\n7\n8')).toBe('1\n2\n3\n4\n5\n6\n\n(thread_read has the rest.)')
  expect(excerpt('x'.repeat(700))).toBe(`${'x'.repeat(600)}…\n\n(thread_read has the rest.)`)
})

it('notes a parent reading its child through thread_read', async () => {
  const { reads, find } = host()
  const h = {
    info: async (id: string) => [find('1'), find('2')].find((t) => t.id === id), list: async () => [find('1'), find('2')],
    answer: async () => 'ok', read: reads.note, start: async () => find('2'), send: async () => {},
    archive: async () => ({ notes: {} }), archiveWhenDone: async () => {},
  }
  const read = tools(h).tools!.find((t) => t.name === 'thread_read')!
  expect(reads.read(find('2'))).toBe(false)
  await read.execute({ id: '2' } as never, { conversationId: 1 } as never, {} as never)
  expect(reads.read(find('2'))).toBe(true)
})

// End to end: a daemon with the thread tools and reports, its model replayed.
it("relays a child's answer to the parent that started it, as a message from it", async () => {
  vi.useRealTimers()
  const dir = await mkdtemp(join(tmpdir(), 'superego-reports-'))
  const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  // The parent starts a child and ends its turn; the child answers; the parent answers the report.
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_start', arguments: { prompt: 'Look into the dates', title: 'Dates' } }], 'toolUse'),
    turn([{ type: 'text', text: 'Started it.' }], 'stop'),
    turn([{ type: 'text', text: 'Dates are UTC.' }], 'stop'),
    turn([{ type: 'text', text: 'Noted.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.REPORTSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.REPORTSTEST_REPLAY_SPEED = '0'
  const app = defineApp({ name: 'test', id: 'reportstest' })
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [threadTools, threadReports] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  try {
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    const parent = await peer.call<ThreadInfo>('thread.create', { prompt: 'split the work', title: 'Lead' })
    const entries = async () => JSON.stringify((await peer.call<{ value: ConversationView }>('thread.watch', { id: parent.id })).value.entries)
    for (let i = 0; i < 600 && !(await entries()).includes('Noted.'); i++) await new Promise((r) => setTimeout(r, 25))
    const child = (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id !== parent.id)!
    // The two run at once, so either may have taken either answer.
    expect(await entries()).toMatch(new RegExp(`From \\[Dates\\]\\(thread:${child.id}\\): finished\\.\\\\n\\\\n(Started it|Dates are UTC)\\.`))
    // Both are told how it works: the parent that its children report, the child that its answer is relayed.
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: child.id })
    expect(JSON.stringify(value)).toContain('relayed to [Lead]')
  } finally {
    socket.destroy(); server.close(); await daemon.close()
    delete process.env.REPORTSTEST_MODEL
    await rm(dir, { recursive: true, force: true })
  }
}, 40_000)

it("reports only what the parent asked for: not the user's own conversation in the child, until the parent sends it again", async () => {
  vi.useRealTimers()
  const dir = await mkdtemp(join(tmpdir(), 'superego-reports-'))
  const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  const say = (text: string) => turn([{ type: 'text', text }], 'stop')
  const turns = (...lines: string[]) => writeFile(join(dir, 'turns.jsonl'), lines.join('\n') + '\n')
  process.env.REPORTSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.REPORTSTEST_REPLAY_SPEED = '0'
  const app = defineApp({ name: 'test', id: 'reportstest' })
  async function open() {
    const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [threadTools, withBatching({ quietMs: 50, maxMs: 200 })] })
    const server = await listen(daemon, join(dir, 's.sock'))
    const { peer, socket } = await connectSocket(join(dir, 's.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
  }
  // The parent starts a child, which reports; then the user talks to the child.
  await turns(turn([{ type: 'toolCall', id: 'c1', name: 'thread_start', arguments: { prompt: 'Look into the dates', title: 'Dates' } }], 'toolUse'), say('zz-one'), say('zz-two'), say('zz-noted'), say('zz-icons'))
  let { peer, close } = await open()
  const entries = async (id: string) => JSON.stringify((await peer.call<{ value: ConversationView }>('thread.watch', { id })).value.entries)
  const idle = async (id: string) => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)?.status.state === 'done'
  const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 400 && !(await check()); i++) await new Promise((r) => setTimeout(r, 25)); expect(await check()).toBe(true) }
  try {
    const parent = await peer.call<ThreadInfo>('thread.create', { prompt: 'split the work', title: 'Lead' })
    await until(async () => (await entries(parent.id)).includes('zz-noted'))
    const child = (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.parent === parent.id)!
    const reports = async () => (await entries(parent.id)).split(`From [Dates](thread:${child.id})`).length - 1
    expect(await reports()).toBe(1)
    // Clients are told it works for its parent (so its finishing doesn't notify); the parent itself doesn't.
    const ext = async (id: string) => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)?.ext?.['thread-reports']
    expect(await ext(child.id)).toEqual({ toParent: true })
    expect(await ext(parent.id)).toBeUndefined()
    // The user's own message to the child, and its answer: not the parent's business.
    await peer.call('thread.submit', { id: child.id, text: 'and the icons?' })
    await until(async () => (await entries(child.id)).includes('zz-icons') && await idle(child.id))
    await new Promise((r) => setTimeout(r, 300))
    expect(await reports()).toBe(1)
    expect(await ext(child.id)).toBeUndefined()
    // The parent sends it more, after a restart (what the child does is kept): reported again.
    await close()
    await turns(turn([{ type: 'toolCall', id: 'c2', name: 'thread_send', arguments: { id: child.id, text: 'More?' } }], 'toolUse'), say('zz-three'), say('zz-four'), say('zz-thanks'))
    ;({ peer, close } = await open())
    await peer.call('thread.submit', { id: parent.id, text: 'ask it for more' })
    await until(async () => await reports() === 2)
    expect(await ext(child.id)).toEqual({ toParent: true })
  } finally {
    await close()
    delete process.env.REPORTSTEST_MODEL
    await rm(dir, { recursive: true, force: true })
  }
}, 40_000)

it("tells clients a child reports only while its parent hears: not once the parent is archived, again once it's back", async () => {
  vi.useRealTimers()
  const dir = await mkdtemp(join(tmpdir(), 'superego-reports-'))
  const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  const say = (text: string) => turn([{ type: 'text', text }], 'stop')
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_start', arguments: { prompt: 'Look into the dates', title: 'Dates' } }], 'toolUse'),
    say('zz-one'), say('zz-two'), say('zz-noted'),
  ].join('\n') + '\n')
  process.env.REPORTSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.REPORTSTEST_REPLAY_SPEED = '0'
  const app = defineApp({ name: 'test', id: 'reportstest' })
  async function open() {
    const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [threadTools, withBatching({ quietMs: 50, maxMs: 200 })] })
    const server = await listen(daemon, join(dir, 's.sock'))
    const { peer, socket } = await connectSocket(join(dir, 's.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
  }
  let { peer, close } = await open()
  const all = async () => [...await peer.call<ThreadInfo[]>('thread.list', {}), ...await peer.call<ThreadInfo[]>('thread.list', { archived: true })]
  const ext = async (id: string) => (await all()).find((t) => t.id === id)?.ext?.['thread-reports']
  const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 400 && !(await check()); i++) await new Promise((r) => setTimeout(r, 25)); expect(await check()).toBe(true) }
  const run = (id: string, params: Json) => peer.call('action.run', { id, params })
  try {
    const parent = await peer.call<ThreadInfo>('thread.create', { prompt: 'split the work', title: 'Lead' })
    await until(async () => JSON.stringify((await peer.call<{ value: ConversationView }>('thread.watch', { id: parent.id })).value.entries).includes('zz-noted'))
    const child = (await all()).find((t) => t.parent === parent.id)!
    expect(await ext(child.id)).toEqual({ toParent: true })
    // Its parent archived, its report would reach no one: it notifies for itself.
    await run('thread.archive', { id: parent.id })
    await until(async () => await ext(child.id) === undefined)
    await run('thread.unarchive', { id: parent.id })
    await until(async () => JSON.stringify(await ext(child.id)) === '{"toParent":true}')
    // Looked at again from the start, after a restart.
    await run('thread.archive', { id: parent.id })
    await close()
    ;({ peer, close } = await open())
    await until(async () => await ext(child.id) === undefined)
  } finally {
    await close()
    delete process.env.REPORTSTEST_MODEL
    await rm(dir, { recursive: true, force: true })
  }
}, 40_000)
