// schedules against a real daemon, on a clock the test turns (fake timers for the scheduler alone: the daemon keeps
// real time): the agent's tools, a firing that wakes the thread, the user's actions, the sidebar's facts, and catching
// up on a run missed while Superego wasn't running.
import { afterEach, expect, it } from 'vitest'
import { callTool, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schedulesExtension, stableLine, type Clock } from '../src/daemon.ts'
import type { Facts, Schedule, ScheduleDetails } from '../src/shared.ts'
import { HOUR, MINUTE } from '../src/when.ts'

/** A clock that moves only when told: `advance` runs what came due, as the timers would. */
function testClock(start = Date.now()) {
  let now = start
  const timers = new Set<{ at: number; run(): void }>()
  return {
    now: () => now,
    after(ms, run) { const timer = { at: now + ms, run }; timers.add(timer); return () => timers.delete(timer) },
    advance(ms: number) {
      now += ms
      for (const timer of [...timers].filter((t) => t.at <= now)) { timers.delete(timer); timer.run() }
    },
  } satisfies Clock & { advance(ms: number): void }
}

let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

type Entry = { kind: string; data?: { text?: string; by?: string; actions?: unknown[] }; model?: { role: string; content?: string | { text?: string }[] }[] }
const entries = async (id: string) => JSON.parse(await daemon!.transcript(id)) as Entry[]
/** What the user sent the thread, and what extensions did, by whom. */
type Said = { message?: string; notice?: string; by?: string }
const said = async (id: string) => (await entries(id)).flatMap((e): Said[] => {
  const message = e.model?.[0]
  if (e.kind === 'superego.note') return [{ notice: e.data?.text, by: e.data?.by }]
  if (message?.role === 'user') return [{ message: typeof message.content === 'string' ? message.content : message.content?.map((c) => c.text).join(''), by: e.data?.by }]
  return []
})

it('schedules a wake from the agent, says what it understood, fires it into the thread, and stops when cancelled', async () => {
  const clock = testClock()
  daemon = await testDaemon({
    extensions: [schedulesExtension({ clock, id: () => 's_ci' })],
    model: [
      callTool('schedule', { when: 'every 30m', message: 'Check CI on #212.', label: 'Check CI', until: 'CI is green' }),
      say("I'll look at CI every 30 minutes."),
      // The firing's run: CI is green, so it stops itself.
      callTool('schedule_list', {}),
      callTool('schedule_cancel', { id: 's_ci', reason: 'CI is green' }),
      say('CI is green.'),
    ],
  })
  const thread = await daemon.thread('Open the PR and check CI every 30 min until green')
  const [call] = await daemon.toolCalls(thread)
  expect(call!.result!.isError).toBe(false)
  expect(call!.result!.text).toMatch(/^Scheduled s_ci "Check CI", a wake: every 30 min, first (today|tomorrow) \d\d:\d\d \(in 30m\); then \d\d:\d\d, \d\d:\d\d\. /)
  expect(call!.result!.text).toMatch(/At most 48 runs, until .+, or until: CI is green\. Times are /)
  const facts = (await daemon.facts(thread)).schedules as Facts
  expect(facts).toMatchObject({ count: 1, label: 'Check CI', next: clock.now() + 30 * MINUTE })
  const value = await daemon.watch<Schedule[]>('schedules.thread', { scope: thread.id })
  await value.until((list) => list.length === 1, 'the thread’s schedule published')
  expect(value.value[0]).toMatchObject({ label: 'Check CI', by: 'agent', until: 'CI is green', runs: 0 })
  const id = value.value[0]!.id

  // The script's cancel names the schedule it made.
  const details = (JSON.parse(await daemon.transcript(thread)) as { model?: { role: string; details?: ScheduleDetails }[] }[])
    .map((e) => e.model?.[0]).find((m) => m?.role === 'toolResult' && m.details?.id)?.details
  expect(details).toMatchObject({ id, label: 'Check CI', every: 30 * MINUTE, maxRuns: 48, until: 'CI is green' })
  expect(details!.times).toEqual([0, 1, 2].map((k) => clock.now() + (30 + 30 * k) * MINUTE))

  clock.advance(30 * MINUTE)
  await daemon.until(async () => (await daemon!.toolCalls(thread)).some((c) => c.name === 'schedule_cancel'), 'the firing’s run', 10_000)
  await daemon.idle(thread)
  const messages = await said(thread.id)
  // The words as the user sees them; with them, for the agent alone, which schedule and run it is, and when to stop.
  const firing = messages.find((m) => m.by === 'schedules')
  const next = new Date(clock.now() + 30 * MINUTE).toTimeString().slice(0, 5)
  expect(firing?.message).toBe('Check CI on #212.' +
    `⏰ Scheduled: Check CI (run 1 of up to 48, every 30 min; next ${next}). The message is this schedule's (s_ci), sent for the user, not typed by them.\n` +
    `Stop when: CI is green. If that now holds, call schedule_cancel({ id: "s_ci", reason }) after you've checked.`)
  // The agent stopped it: said in the thread, not told back to the agent.
  expect(messages.at(-1)).toEqual({ notice: 'Check CI stopped: CI is green.', by: 'schedules' })
  expect((await daemon.facts(thread)).schedules).toBeUndefined()
}, 30_000)

it('runs the user’s actions: add, list, pause, run now and cancel, with a notice', async () => {
  const clock = testClock()
  daemon = await testDaemon({ extensions: [schedulesExtension({ clock })], model: 'echo' })
  const thread = await daemon.thread()
  const s = await daemon.dispatch<Schedule>('schedules.add', { thread: thread.id, when: 'in 2h', message: 'Review Mia’s PR.', label: 'Review PR' })
  expect(s).toMatchObject({ by: 'user', label: 'Review PR', next: clock.now() + 2 * HOUR, maxRuns: 1 })
  await expect(daemon.dispatch('schedules.add', { thread: thread.id, when: 'every 1m', message: 'x' })).rejects.toThrow(/too often/)
  expect(await daemon.call<Schedule[]>('schedules.list', { thread: thread.id })).toHaveLength(1)

  await daemon.dispatch('schedules.pause', { id: s.id })
  expect((await daemon.facts(thread)).schedules).toMatchObject({ next: null, paused: 1 })
  await daemon.dispatch('schedules.run', { id: s.id })
  await daemon.until(async () => (await said(thread.id)).some((m) => m.message?.includes('Review Mia’s PR.')), 'run now')
  await daemon.idle(thread)
  expect((await daemon.call<Schedule[]>('schedules.list', { thread: thread.id }))[0]).toMatchObject({ runs: 1, ended: { why: 'done' } })
  expect((await daemon.facts(thread)).schedules).toBeUndefined()

  const again = await daemon.dispatch<Schedule>('schedules.add', { thread: thread.id, when: 'every 30m', message: 'Poll.', label: 'Poll' })
  await daemon.dispatch('schedules.cancel', { id: again.id })
  await daemon.until(async () => (await said(thread.id)).some((m) => m.notice === 'Poll stopped: cancelled by you.' && m.by === 'schedules'), 'the notice')
}, 30_000)

it('fires a run missed while Superego was down once it starts, saying how late', async () => {
  const clock = testClock()
  daemon = await testDaemon({ extensions: [schedulesExtension({ clock })], model: 'echo' })
  const thread = await daemon.thread()
  await daemon.dispatch('schedules.add', { thread: thread.id, when: 'in 10m', message: 'Check the deploy.', label: 'Deploy' })
  await daemon.restart({ whileStopped: () => clock.advance(2 * HOUR + 10 * MINUTE) })
  await daemon.until(async () => (await said(thread.id)).some((m) => m.message?.includes('Check the deploy.')), 'the late run', 10_000)
  const messages = await said(thread.id)
  expect(messages.find((m) => m.notice)).toEqual({ notice: "Deploy ran 2h late, as Superego wasn't running.", by: 'schedules' })
  expect(messages.find((m) => m.by === 'schedules' && m.message)?.message).toMatch(/^Check the deploy\.⏰ Scheduled: Deploy \(once, .+\nLate: it was due .+ and ran \d\d:\d\d\.$/)
}, 30_000)

it('reminds the user with a notice, no run, the thread made unread; changes a schedule; reads a time and what was said', async () => {
  const clock = testClock()
  daemon = await testDaemon({ extensions: [schedulesExtension({ clock })], model: 'echo' })
  const thread = await daemon.thread()
  const s = await daemon.dispatch<Schedule>('schedules.add', { thread: thread.id, when: 'in 2h', message: 'Review Mia’s PR.', action: 'notify' })
  // Changed: a reminder for another time, saying more.
  const changed = await daemon.dispatch<Schedule>('schedules.update', { id: s.id, when: 'in 30m', message: 'Review Mia’s PR (#209).' })
  expect(changed).toMatchObject({ action: 'notify', next: clock.now() + 30 * MINUTE, label: 'Review Mia’s PR (#209)' })
  clock.advance(30 * MINUTE)
  await daemon.until(async () => (await entries(thread.id)).some((e) => e.kind === 'superego.note'), 'the reminder', 10_000)
  const note = (await entries(thread.id)).find((e) => e.kind === 'superego.note')!
  expect(note.data).toMatchObject({ text: 'Review Mia’s PR (#209).', by: 'schedules', kind: 'schedules.reminder' })
  // No run: what the agent has of it is the notice, as context.
  expect((await said(thread.id)).filter((m) => m.message)).toEqual([])
  expect((await daemon.info(thread)).status).toMatchObject({ state: 'done' })

  expect(await daemon.call('schedules.understand', { when: 'every weekday at 9' })).toMatchObject({ how: 'every weekday at 09:00', repeats: true })
  await expect(daemon.call('schedules.understand', { when: 'whenever' })).rejects.toThrow(/isn't a time I understand/)
  expect(await daemon.call('schedules.split', { text: 'remind me in 1h to stretch' })).toEqual({ when: 'in 1h', message: 'Stretch', action: 'notify' })
  expect(await daemon.call('schedules.split', { text: 'check the deploy sometime' })).toBeNull()
}, 30_000)

it("keeps the prompt's line for a schedule the same as it runs: where it stands is schedule_list's", () => {
  const s: Schedule = {
    id: 's_1', thread: 't', label: 'Check CI', message: 'Check CI.', action: 'wake', when: { every: 30 * MINUTE, anchor: 0 }, said: 'every 30m',
    until: 'CI is green', maxRuns: 48, next: 30 * MINUTE, runs: 0, missed: 0, paused: false, by: 'agent', created: 0,
  }
  const line = stableLine(s)
  expect(line).toBe('- s_1 "Check CI": every 30 min, until: CI is green')
  expect(stableLine({ ...s, next: 90 * MINUTE, runs: 3, missed: 1, lastRun: HOUR, paused: true, pending: { since: 1, due: 1, missed: 0 }, awaiting: true })).toBe(line)
})

it("says when its file doesn't read: kept aside, the threads it names told, Settings shown it; and finishes a save before it's torn down", async () => {
  const clock = testClock()
  daemon = await testDaemon({ extensions: [schedulesExtension({ clock })], model: 'echo' })
  const thread = await daemon.thread()
  const file = join(daemon.dataDir, 'extensions', 'schedules', 'schedules.json')
  await daemon.dispatch('schedules.add', { thread: thread.id, when: 'in 2h', message: 'Later.' })
  // Torn down at once after a change: the change is in the file.
  await daemon.restart()
  expect(JSON.parse(await readFile(file, 'utf8')).schedules).toHaveLength(1)
  await daemon.restart({ whileStopped: () => writeFile(file, `{"version":1,"schedules":[{"id":"s_1","thread":"${thread.id}",`) })
  await daemon.until(async () => (await said(thread.id)).some((m) => m.notice?.includes("This thread's schedules couldn't be read")), 'the notice')
  const aside = (await readdir(join(daemon.dataDir, 'extensions', 'schedules'))).find((name) => /^schedules\.json\.bad-\d+$/.test(name))!
  expect(await readFile(join(daemon.dataDir, 'extensions', 'schedules', aside), 'utf8')).toContain(thread.id)
  const problem = await daemon.watch<string | null>('schedules.problem')
  await problem.until((p) => typeof p === 'string' && p.includes('kept as'), 'the problem')
  expect(await daemon.call('schedules.list', {})).toEqual([])
}, 30_000)
