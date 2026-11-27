// The scheduler on its own, on a clock the test turns: what fires when, what waits for a busy thread, catching up after
// sleep, archived threads, the guards.
import { beforeEach, expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { scheduler, type SchedulerHost } from '../src/scheduler.ts'
import type { Schedule } from '../src/shared.ts'
import { HOUR, MINUTE } from '../src/when.ts'

// Tuesday 5 May 2026, 14:00 local.
const START = new Date(2026, 4, 5, 14, 0).getTime()

const thread = (id: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title: id, cwd: '/p', createdAt: 0, activeAt: 1, project: { root: '/p', name: 'p' }, status: { state: 'idle' }, ...extra })

let world: ReturnType<typeof setUp>
function setUp() {
  let now = START
  const threads = new Map<string, ThreadInfo>([['1', thread('1')], ['2', thread('2')]])
  const woken: [string, string][] = []
  const notices: { thread: string; text: string; agent: boolean; actions?: unknown[] }[] = []
  let saved: Schedule[] = []
  const changed: string[][] = []
  const host: SchedulerHost = {
    now: () => now,
    started: START - HOUR,
    info: async (id) => threads.get(id),
    busy: (t) => t.status.state === 'working' || t.status.state === 'blocked',
    wake: async (s, { message, context }) => { woken.push([s.thread, `${message}\n---\n${context}`]) },
    notice: async (id, text, { agent, actions }) => { notices.push({ thread: id, text, agent, ...(actions ? { actions } : {}) }) },
    save: async (all) => { saved = structuredClone(all) },
    changed: (ids) => { changed.push(ids) },
    limits: () => ({ minInterval: 5, maxRuns: 48, days: 7, perThread: 10 }),
  }
  const sched = scheduler(host)
  return {
    sched, host, threads, woken, notices, changed, get saved() { return saved },
    /** Move the clock on, then tick as the daemon's timer would. */
    async advance(ms: number) { now += ms; await sched.tick() },
    set(id: string, extra: Partial<ThreadInfo>) { threads.set(id, { ...threads.get(id)!, ...extra }) },
    get now() { return now },
  }
}
beforeEach(() => { world = setUp() })

it('fires a one-shot once, at its time, into a free thread, and ends', async () => {
  const { sched, woken, advance } = world
  const s = await sched.add({ thread: '1', when: 'in 30m', message: 'Check the deploy.' }, 'agent')
  expect(s).toMatchObject({ label: 'Check the deploy', next: START + 30 * MINUTE, maxRuns: 1, by: 'agent' })
  expect(sched.facts('1')).toEqual({ next: START + 30 * MINUTE, label: 'Check the deploy', count: 1, paused: 0, pending: 0 })
  await advance(29 * MINUTE)
  expect(woken).toEqual([])
  await advance(MINUTE)
  expect(woken).toEqual([['1', `Check the deploy.\n---\n⏰ Scheduled: Check the deploy (once, for 14:30). The message is this schedule's (${s.id}), sent for the user, not typed by them.`]])
  expect(sched.get(s.id)).toMatchObject({ runs: 1, ended: { why: 'done' }, next: null })
  expect(sched.facts('1')).toBeUndefined()
  await advance(HOUR)
  expect(woken).toHaveLength(1)
  expect(world.saved.find((x) => x.id === s.id)?.ended?.why).toBe('done')
})

it('repeats every interval, counting runs, saying when to stop, and stops after its runs', async () => {
  const { sched, woken, notices, advance } = world
  const s = await sched.add({ thread: '1', when: 'every 30m', message: 'Look at CI on #212.', label: 'Check CI', until: 'CI is green', maxRuns: 2 }, 'agent')
  await advance(30 * MINUTE)
  expect(woken[0]![1]).toBe([
    'Look at CI on #212.',
    '---',
    `⏰ Scheduled: Check CI (run 1 of up to 2, every 30 min; next 15:00). The message is this schedule's (${s.id}), sent for the user, not typed by them.`,
    `Stop when: CI is green. If that now holds, call schedule_cancel({ id: "${s.id}", reason }) after you've checked.`,
  ].join('\n'))
  await sched.turnEnded(world.threads.get('1')!)
  await advance(30 * MINUTE)
  expect(woken[1]![1]).toMatch(/\n⏰ Scheduled: Check CI \(run 2 of up to 2, every 30 min; its last run\)\./)
  expect(sched.get(s.id)?.ended?.why).toBe('maxRuns')
  expect(notices).toEqual([{ thread: '1', text: 'Check CI stopped after 2 runs.', agent: false }])
})

it('waits while its thread works or asks the user, once at most, and counts from when it went', async () => {
  const { sched, woken, advance, set } = world
  const s = await sched.add({ thread: '1', when: 'every 10m', message: 'Poll.' }, 'user')
  set('1', { status: { state: 'working' } })
  await advance(10 * MINUTE)
  expect(woken).toEqual([])
  expect(sched.facts('1')).toMatchObject({ pending: 1 })
  // Due again meanwhile: missed, not stacked.
  await advance(10 * MINUTE)
  set('1', { status: { state: 'blocked', kind: 'question', msg: 'Which branch?' } })
  await advance(5 * MINUTE)
  expect(woken).toEqual([])
  // Free: it goes once, and the next is ten minutes from now.
  set('1', { status: { state: 'done' } })
  await sched.turnEnded(world.threads.get('1')!)
  expect(woken).toHaveLength(1)
  expect(sched.get(s.id)).toMatchObject({ runs: 1, missed: 1, next: world.now + 10 * MINUTE })
  await advance(9 * MINUTE)
  expect(woken).toHaveLength(1)
  await advance(MINUTE)
  expect(woken).toHaveLength(2)
})

it('fires a missed run once after sleep, saying how late and how many it skipped', async () => {
  const { sched, woken, notices, advance } = world
  const s = await sched.add({ thread: '1', when: 'every 30m', message: 'Poll.', label: 'Check CI' }, 'agent')
  // Asleep from 14:00 to 16:31: due 14:30, then 15:00, 15:30, 16:00 and 16:30 missed.
  await advance(151 * MINUTE)
  expect(woken).toHaveLength(1)
  expect(notices).toEqual([{ thread: '1', text: 'Check CI ran 2h 1m late, as this machine was asleep. 4 runs skipped.', agent: false }])
  expect(woken[0]![1]).toContain('Late: it was due 14:30 and ran 16:31; 4 runs missed.')
  expect(sched.get(s.id)).toMatchObject({ runs: 1, missed: 4, next: world.now + 30 * MINUTE })
})

it('says Superego wasn’t running when the run came due before it started', async () => {
  const { sched, notices, host } = world
  const s = await sched.add({ thread: '1', when: 'in 5m', message: 'Ping.', label: 'Ping' }, 'agent')
  // As if loaded at a start well after it was due.
  const later = scheduler({ ...host, now: () => START + 3 * HOUR, started: START + 3 * HOUR - MINUTE })
  later.load([structuredClone(sched.get(s.id)!)])
  await later.tick()
  expect(notices.at(-1)?.text).toBe("Ping ran 2h 55m late, as Superego wasn't running.")
  expect(later.get(s.id)?.ended?.why).toBe('done')
})

it('ends a repeating one whose end passed while away, without firing', async () => {
  const { sched, woken, notices, advance } = world
  const s = await sched.add({ thread: '1', when: 'every 1h', message: 'Poll.', label: 'Watch', ends: 'in 3h' }, 'agent')
  await advance(4 * HOUR)
  expect(woken).toEqual([])
  expect(sched.get(s.id)?.ended?.why).toBe('ends')
  expect(notices[0]).toMatchObject({ thread: '1', agent: true })
  expect(notices[0]!.text).toMatch(/^Watch ended: its end, 17:00, passed while this machine was asleep\.$/)
})

it("holds an archived thread's schedules, and on its return goes on, asking about a one-shot it missed", async () => {
  const { sched, woken, notices, advance } = world
  const every = await sched.add({ thread: '1', when: 'every 30m', message: 'Poll.' }, 'agent')
  const once = await sched.add({ thread: '1', when: 'in 1h', message: 'Review the PR.', label: 'Review PR' }, 'user')
  await sched.archived('1')
  expect(sched.facts('1')).toBeUndefined()
  await advance(2 * HOUR)
  expect(woken).toEqual([])
  await sched.unarchived('1')
  expect(sched.get(every.id)).toMatchObject({ next: world.now + 30 * MINUTE })
  expect(sched.get(once.id)).toMatchObject({ paused: true })
  expect(notices).toEqual([{
    thread: '1', agent: false, text: "Review PR was due 15:00, while this thread was archived. It's paused: run it now, or cancel it.",
    actions: [{ label: 'Run now', action: 'schedules.run', params: { id: once.id }, style: 'primary' }, { label: 'Cancel', action: 'schedules.cancel', params: { id: once.id } }],
  }])
  // Run now, paused as it is: it goes, and ends.
  await sched.run(once.id)
  expect(woken.at(-1)![1]).toContain('Review the PR.')
  expect(sched.get(once.id)?.ended?.why).toBe('done')
})

it('pauses after two failed runs in a row', async () => {
  const { sched, notices, advance, set } = world
  const s = await sched.add({ thread: '1', when: 'every 10m', message: 'Poll.', label: 'Poll' }, 'agent')
  for (let i = 0; i < 2; i++) {
    await advance(10 * MINUTE)
    set('1', { status: { state: 'error', msg: '503' } })
    await sched.turnEnded(world.threads.get('1')!)
    set('1', { status: { state: 'idle' } })
  }
  expect(sched.get(s.id)).toMatchObject({ paused: true, failures: 2, runs: 2 })
  expect(notices.at(-1)?.text).toMatch(/^Poll paused: the runs it started failed twice in a row\./)
  await advance(HOUR)
  expect(sched.get(s.id)?.runs).toBe(2)
})

it('pauses, resumes from now, runs now and cancels, saying so', async () => {
  const { sched, woken, notices, advance } = world
  const s = await sched.add({ thread: '1', when: 'every 30m', message: 'Poll.', label: 'Poll' }, 'agent')
  await sched.pause(s.id)
  await advance(HOUR)
  expect(woken).toEqual([])
  await sched.resume(s.id)
  expect(sched.get(s.id)?.next).toBe(world.now + 30 * MINUTE)
  await sched.run(s.id)
  expect(woken).toHaveLength(1)
  expect(sched.get(s.id)?.runs).toBe(1)
  await sched.cancel(s.id, { who: 'user' })
  expect(notices.at(-1)).toEqual({ thread: '1', text: 'Poll stopped: cancelled by you.', agent: true })
  const other = await sched.add({ thread: '1', when: 'every 30m', message: 'Poll.', label: 'Watch staging' }, 'agent')
  await sched.cancel(other.id, { who: 'agent', reason: 'staging is healthy.' })
  expect(notices.at(-1)).toEqual({ thread: '1', text: 'Watch staging stopped: staging is healthy.', agent: false })
})

it('fires a paused one-shot resumed after its time at once, not as late', async () => {
  const { sched, woken, notices, advance } = world
  const s = await sched.add({ thread: '1', when: 'in 10m', message: 'Ping.' }, 'user')
  await sched.pause(s.id)
  await advance(HOUR)
  await sched.resume(s.id)
  expect(woken).toHaveLength(1)
  expect(notices).toEqual([])
  expect(sched.get(s.id)?.ended?.why).toBe('done')
})

it('follows its thread where it continues', async () => {
  const { sched, woken, advance, set } = world
  const s = await sched.add({ thread: '1', when: 'in 10m', message: 'Hi.' }, 'agent')
  set('1', { continuedIn: '2' })
  await advance(10 * MINUTE)
  expect(woken).toEqual([['2', expect.stringContaining('Hi.')]])
  expect(sched.get(s.id)?.thread).toBe('2')
})

it('keeps to the guards', async () => {
  const { sched } = world
  await expect(sched.add({ thread: '1', when: 'every 2m', message: 'x' }, 'agent')).rejects.toThrow('every 2 min is too often: at least every 5 min.')
  await expect(sched.add({ thread: '1', when: 'every 30m', message: 'x', maxRuns: 501 }, 'agent')).rejects.toThrow(/500 at most/)
  await expect(sched.add({ thread: '1', when: 'every 30m', message: 'x', ends: 'in 40 days' }, 'agent')).rejects.toThrow(/30 days ahead at most/)
  await expect(sched.add({ thread: '1', when: 'in 1h', message: 'x', until: 'done' }, 'agent')).rejects.toThrow(/for a repeating schedule/)
  await expect(sched.add({ thread: '1', when: 'soonish', message: 'x' }, 'agent')).rejects.toThrow(/isn't a time I understand/)
  await expect(sched.add({ thread: '1', when: 'in 1h', message: '  ' }, 'agent')).rejects.toThrow(/needs a message/)
  const every = await sched.add({ thread: '1', when: 'every 30m', message: 'x' }, 'agent')
  expect(every).toMatchObject({ maxRuns: 48, ends: START + 7 * 24 * HOUR })
  for (let i = 1; i < 10; i++) await sched.add({ thread: '1', when: `in ${i}h`, message: 'x' }, 'agent')
  await expect(sched.add({ thread: '1', when: 'in 1h', message: 'x' }, 'agent')).rejects.toThrow(/has 10 schedules already/)
  await sched.add({ thread: '2', when: 'in 1h', message: 'x' }, 'agent')
})
