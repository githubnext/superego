// Report-back: a child's run ending (or its question) told to its parent, batched, and not when the parent read it.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { defineDaemonExtension, type DaemonApi } from '@superego/daemon'
import { callTool, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import threadTools from '@superego/thread-tools/daemon'
import threadReports, { excerpt, reporter, threadReports as withBatching, type ReportsHost } from '../src/daemon.ts'

const thread = (id: string, title: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title, cwd: '/p', createdAt: 0, activeAt: 1, project: { root: '/p', name: 'p' }, status: { state: 'done' }, ...extra })

/**
 * What parents have read of their children, for `read` (`threads.parentRead`): `note(t)`, its parent read `t` as it
 * stands. Whose read counts, and when, is the daemon's to say (its own tests); the end-to-end case below runs both.
 */
function readLog() {
  const seen = new Map<string, number>()
  return {
    note(t: ThreadInfo) { seen.set(t.id, Math.max(seen.get(t.id) ?? 0, t.activeAt)) },
    read: (t: ThreadInfo) => (seen.get(t.id) ?? -1) >= t.activeAt,
  }
}

/** Threads 1 (the parent), 2 and 3 (its children) and 4 (2's child), with their answers; what's sent, by whom. */
function host() {
  const threads = [thread('1', 'Lead'), thread('2', 'Dates', { parent: '1' }), thread('3', 'Icons', { parent: '1' }), thread('4', 'Deep', { parent: '2' })]
  const answers: Record<string, string> = { 2: 'Dates are UTC now.\nAll tests pass.', 3: 'Icons swapped.', 4: 'Found it.' }
  const sent: [string, string][] = []
  const reads = readLog()
  const busy = new Set<string>()
  const h: ReportsHost = {
    busy: (t) => busy.has(t.id) || t.status.state === 'working',
    info: async (id) => threads.find((t) => t.id === id),
    answer: async (id) => answers[id],
    send: async (id, text) => { sent.push([id, text]) },
    read: (t) => reads.read(t),
  }
  return { threads, sent, reads, busy, h, find: (id: string) => threads.find((t) => t.id === id)! }
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

it("skips what the parent read already, before the report or after; not a read from before", async () => {
  const { h, sent, find, reads } = host()
  const reports = reporter(h, { quietMs: 1_000, maxMs: 1_000 })
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sent).toHaveLength(1)
  // Read by its parent once done (a wait returning), before or after the report: nothing more.
  reads.note(find('2'))
  await reports.report(find('2'))
  await reports.report(find('3'))
  reads.note(find('3'))
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

it("holds a busy parent's reports until its run ends, then sends what it hasn't read since", async () => {
  const { h, sent, find, reads, busy } = host()
  const reports = reporter(h, { quietMs: 10, maxMs: 10 })
  busy.add('1')
  await reports.report(find('2'))
  await reports.report(find('3'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sent).toEqual([])
  // Read during the run: it has that one already.
  reads.note(find('2'))
  busy.delete('1')
  reports.idle('1')
  await vi.advanceTimersByTimeAsync(0)
  expect(sent).toEqual([['1', 'From [Icons](thread:3): finished.\n\nIcons swapped.']])
})

it('sends a busy parent one report after its run, however long, and none for a child read or archived meanwhile', async () => {
  const { h, sent, find, reads, busy } = host()
  const reports = reporter(h, { quietMs: 10, maxMs: 10 })
  busy.add('1')
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  // Another run's end (a child's) isn't the parent's.
  reports.idle('2')
  await vi.advanceTimersByTimeAsync(0)
  expect(sent).toEqual([])
  busy.delete('1')
  reports.idle('1')
  reports.idle('1')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sent).toHaveLength(1)
  // Its run ending while a batch is looked at, found working as it was: it goes all the same.
  sent.length = 0
  busy.add('1')
  let found!: () => void
  const info = h.info
  h.info = async (id) => { const t = await info(id); if (id === '1') { h.info = info; await new Promise<void>((r) => { found = r }) } return { ...t!, status: { state: 'working' } } }
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(10)
  busy.delete('1')
  reports.idle('1')
  found()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent).toEqual([['1', 'From [Dates](thread:2): finished.\n\nDates are UTC now.\nAll tests pass.']])
  // Archived while it waited: dropped. Read while it waited, all of it: nothing sent.
  sent.length = 0
  busy.add('1')
  await reports.report(find('3'))
  await vi.advanceTimersByTimeAsync(10)
  find('3').archived = true
  busy.delete('1')
  reports.idle('1')
  await vi.advanceTimersByTimeAsync(0)
  find('2').activeAt = 2
  busy.add('1')
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(10)
  reads.note(find('2'))
  busy.delete('1')
  reports.idle('1')
  await vi.advanceTimersByTimeAsync(0)
  expect(sent).toEqual([])
})

it("sends an idle parent's reports as soon as they're batched", async () => {
  const { h, sent, find } = host()
  const reports = reporter(h, { quietMs: 10, maxMs: 10 })
  await reports.report(find('2'))
  await vi.advanceTimersByTimeAsync(10)
  expect(sent).toHaveLength(1)
})

it("says a run that answered the parent's thread_send replied", async () => {
  const { h, sent, find } = host()
  const reports = reporter(h, { quietMs: 10, maxMs: 10 })
  await reports.report(find('3'), { replied: true })
  await vi.advanceTimersByTimeAsync(10)
  expect(sent).toEqual([['1', 'From [Icons](thread:3): replied.\n\nIcons swapped.']])
})

it('says a child was stopped, and how many of the messages its parent queued for it the stop withdrew, whichever is told first', async () => {
  const { h, sent, find } = host()
  const reports = reporter(h, { quietMs: 10, maxMs: 10 })
  // The run's end, then its stop.
  await reports.report(find('3'))
  await reports.report(find('3'), { stopped: { withdrawn: 2 } })
  // The stop told first.
  await reports.report(find('2'), { stopped: { withdrawn: 1 } })
  await reports.report(find('2'), { replied: true })
  await vi.advanceTimersByTimeAsync(10)
  expect(sent).toEqual([['1', [
    "From [Icons](thread:3): was stopped, withdrawing the 2 messages you'd queued for it.\n\nIcons swapped.",
    "From [Dates](thread:2): was stopped, withdrawing the message you'd queued for it.\n\nDates are UTC now.\nAll tests pass.",
  ].join('\n\n---\n\n')]])
})

it('keeps a long answer to its first lines', () => {
  expect(excerpt('a\nb')).toBe('a\nb')
  expect(excerpt('1\n2\n3\n4\n5\n6\n7\n8')).toBe('1\n2\n3\n4\n5\n6\n\n(thread_read has the rest.)')
  expect(excerpt('x'.repeat(700))).toBe(`${'x'.repeat(600)}…\n\n(thread_read has the rest.)`)
})

// End to end: a daemon with the thread tools and reports, its model scripted.
const list = async (daemon: TestDaemon) => [...await daemon.call<ThreadInfo[]>('thread.list', {}), ...await daemon.call<ThreadInfo[]>('thread.list', { archived: true })]
const quiet = async (daemon: TestDaemon, id: string) => (await list(daemon)).find((t) => t.id === id)?.quiet
const startsDates = callTool('thread_start', { prompt: 'Look into the dates', title: 'Dates' })

it("relays a child's answer to the parent that started it, as a message from it", async () => {
  vi.useRealTimers()
  // The parent starts a child and ends its turn; the child answers; the parent answers the report.
  const daemon = await testDaemon({ extensions: [threadTools, threadReports], model: [startsDates, say('Started it.'), say('Dates are UTC.'), say('Noted.')] })
  try {
    const parent = await daemon.thread('split the work', { title: 'Lead' })
    await daemon.until(async () => (await daemon.transcript(parent.id)).includes('Noted.'), 'the parent to answer the report')
    const child = (await list(daemon)).find((t) => t.parent === parent.id)!
    // The two run at once, so either may have taken either answer.
    expect(await daemon.transcript(parent.id)).toMatch(new RegExp(`From \\[Dates\\]\\(thread:${child.id}\\): finished\\.\\\\n\\\\n(Started it|Dates are UTC)\\.`))
    // Both are told how it works: the parent that its children report, the child that its answer is relayed.
    const { value } = await daemon.call<{ value: unknown }>('thread.watch', { thread: child.id })
    expect(JSON.stringify(value)).toContain('relayed to [Lead]')
  } finally {
    await daemon.close()
  }
}, 40_000)

it("reports only what the parent asked for: not the user's own conversation in the child, until the parent sends it again", async () => {
  vi.useRealTimers()
  const batching = { quietMs: 50, maxMs: 200 }
  // The parent starts a child, which reports; then the user talks to the child.
  let daemon = await testDaemon({ extensions: [threadTools, withBatching(batching)], model: [startsDates, say('zz-one'), say('zz-two'), say('zz-noted'), say('zz-icons')] })
  try {
    const parent = await daemon.thread('split the work', { title: 'Lead' })
    await daemon.until(async () => (await daemon.transcript(parent.id)).includes('zz-noted'), 'the parent to answer the report')
    const child = (await list(daemon)).find((t) => t.parent === parent.id)!
    const reports = async () => (await daemon.transcript(parent.id)).split(`From [Dates](thread:${child.id})`).length - 1
    expect(await reports()).toBe(1)
    // Quiet while it works for its parent (so its finishing isn't unread); the parent isn't.
    expect(await quiet(daemon, child.id)).toBe(true)
    expect(await quiet(daemon, parent.id)).toBeUndefined()
    // The user's own message to the child, and its answer: not the parent's business.
    await daemon.send(child.id, 'and the icons?')
    expect(await daemon.transcript(child.id)).toContain('zz-icons')
    // Nothing to wait for: a report would have gone well within this (maxMs).
    await new Promise((r) => setTimeout(r, batching.maxMs + 100))
    expect(await reports()).toBe(1)
    expect(await quiet(daemon, child.id)).toBeUndefined()
    // The parent sends it more, after a restart (what the child does is kept): reported again.
    daemon = await daemon.restart({ model: [callTool('thread_send', { thread: child.id, text: 'More?' }), say('zz-three'), say('zz-four'), say('zz-thanks')] })
    await daemon.call('thread.send', { thread: parent.id, text: 'ask it for more' })
    await daemon.until(async () => await reports() === 2, 'the second report')
    expect(await daemon.transcript(parent.id)).toContain(`From [Dates](thread:${child.id}): replied.`)
    expect(await quiet(daemon, child.id)).toBe(true)
  } finally {
    await daemon.close()
  }
}, 40_000)

it("makes a child quiet only while its parent hears: not once the parent is archived, again once it's back", async () => {
  vi.useRealTimers()
  let daemon = await testDaemon({ extensions: [threadTools, withBatching({ quietMs: 50, maxMs: 200 })], model: [startsDates, say('zz-one'), say('zz-two'), say('zz-noted')] })
  try {
    const parent = await daemon.thread('split the work', { title: 'Lead' })
    await daemon.until(async () => (await daemon.transcript(parent.id)).includes('zz-noted'), 'the parent to answer the report')
    const child = (await list(daemon)).find((t) => t.parent === parent.id)!
    expect(await quiet(daemon, child.id)).toBe(true)
    // Its parent archived, its report would reach no one: it notifies for itself.
    await daemon.dispatch('thread.archive', { thread: parent.id })
    await daemon.until(async () => await quiet(daemon, child.id) === undefined, 'the child to be unquiet')
    await daemon.dispatch('thread.unarchive', { thread: parent.id })
    await daemon.until(async () => await quiet(daemon, child.id) === true, 'the child to be quiet')
    // Looked at again from the start, after a restart.
    await daemon.dispatch('thread.archive', { thread: parent.id })
    daemon = await daemon.restart()
    await daemon.until(async () => await quiet(daemon, child.id) === undefined, 'the child to be unquiet after a restart')
  } finally {
    await daemon.close()
  }
}, 40_000)

it('sends no report of a run its parent read with thread_read; one it didn\'t read is reported', async () => {
  vi.useRealTimers()
  // The parent's own messages to its child (`from`, as thread_send's), sent from here so each turn has one thread to go to.
  let threads!: DaemonApi['threads']
  const probe = defineDaemonExtension({ name: 'probe', version: '1.0.0', setup(s) { threads = s.threads } })
  const batching = { quietMs: 2_000, maxMs: 2_000 }
  let daemon = await testDaemon({ extensions: [threadTools, withBatching(batching), probe] })
  try {
    const parent = await daemon.thread(undefined, { title: 'Lead' })
    const child = await daemon.call<ThreadInfo>('thread.start', { cwd: parent.cwd, parent: parent.id, title: 'Dates' })
    daemon = await daemon.restart({ model: [say('zz-dates'), callTool('thread_read', { thread: child.id }), say('zz-read'), say('zz-more')] })
    const reports = async () => (await daemon.transcript(parent.id)).split(`From [Dates](thread:${child.id})`).length - 1
    // The child answers its parent; the parent reads it before the report goes: none goes.
    await threads.send(child.id, 'dates?', { from: parent.id })
    await daemon.until(async () => (await daemon.transcript(child.id)).includes('zz-dates'), 'the child to answer')
    await daemon.idle(child.id)
    await daemon.send(parent.id, 'how did Dates do?')
    expect(await daemon.transcript(parent.id)).toContain('zz-read')
    await new Promise((r) => setTimeout(r, batching.maxMs + 500))
    expect(await reports()).toBe(0)
    // Its next run, unread: reported.
    await threads.send(child.id, 'and more?', { from: parent.id })
    await daemon.until(async () => await reports() === 1, 'the report of the unread run')
  } finally {
    await daemon.close()
  }
}, 40_000)
