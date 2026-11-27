// schedules: the scheduler, apart from the daemon so tests drive it with their own clock and threads. It keeps every
// schedule of the machine, says which are due (`tick`, from the daemon's timer and its minute's tick), and fires them.
// A wake goes once its thread is free: not in a run, not waiting on the user (a question, a permission, a sign-in), not
// stuck. A wake due while its thread is busy waits (`pending`), one firing at most: what comes due meanwhile is missed,
// not stacked, and an interval's next run counts from when it went, so a long run doesn't bring two back to back. A
// reminder (notify) doesn't wait: a notice in the thread, no run, is fine while it works.
//
// Missed runs (the machine asleep, Superego not running) fire once, late, saying how late and how many were skipped; a
// one-shot fires however late. A repeating one whose end passed meanwhile ends instead, saying so. An archived thread's
// schedules wait (`held`) until it's back: a repeating one goes on from then, a one-shot that came due meanwhile waits
// paused, the thread told. Two wakes in a row whose run failed pause it (no burning tokens on a broken thread).
//
// Every change is saved at once (`host.save`) and told (`host.changed`), so the window and the facts follow.
import { RpcError, type ThreadInfo } from '@superego/protocol'
import { CAPS, REMINDER, SCHEDULED, type Action, type EndedWhy, type Facts, type Reminder, type Schedule, type When } from './shared.ts'
import { clockTime, DAY, firstRun, HOUR, howWords, MINUTE, nextAfter, parseAt, parseWhen, repeats, runsBetween, shortDuration, shortestGap, shortWhen, WhenError } from './when.ts'

/** The guards, as this machine's settings say (`CAPS` bound them). */
export type Limits = { minInterval: number; maxRuns: number; days: number; perThread: number }

/** What a notice in a thread says, beyond its text. */
export type NoticeOptions = {
  /** Tell the agent too: its text (`true`), or these words. */
  agent: boolean | string
  actions?: NoticeButton[]
  /** Drawn by the window as this kind (a reminder), given `data`. */
  kind?: string
  data?: Reminder
}

/** What the scheduler needs of the daemon. */
export type SchedulerHost = {
  now(): number
  /** When this daemon started: a run due before was missed while Superego wasn't running. */
  started: number
  /** A thread as it is now; undefined once it's gone. */
  info(thread: string): Promise<ThreadInfo | undefined>
  /** Whether it can't take a scheduled message now (in a run, waiting on the user, stuck). */
  busy(thread: ThreadInfo): boolean
  /**
   * Send the thread the firing's message (its words, as the user sees them), which starts its run; `context` goes with
   * it for the agent alone: which schedule, which run, how late, when to stop.
   */
  wake(schedule: Schedule, firing: { message: string; context: string }): Promise<void>
  /** Tell the user in the thread (a notice: unread, notified, no run). */
  notice(thread: string, text: string, options: NoticeOptions): Promise<void>
  save(all: Schedule[]): Promise<void>
  /** The threads whose schedules changed. */
  changed(threads: string[]): void
  limits(): Limits
  /** The machine's timezone now: a calendar schedule keeps the one it was made in. */
  tz?(): string
  /** A new schedule's id (`s_<rand>`, unless a test names them). */
  id?(): string
}

/** A notice's button: an action of ours, on a schedule. */
export type NoticeButton = { label: string; action: string; params: { id: string }; style?: 'primary' | 'danger' }

/** What `schedules.add` and the `schedule` tool take. */
export type NewSchedule = { thread: string; when: string; message: string; label?: string; action?: Action; until?: string; maxRuns?: number; ends?: string }
/** What `schedules.update` changes: what's given (`until: ''` clears it). */
export type ScheduleChange = Partial<Omit<NewSchedule, 'thread'>>

/** How late a run may go before it says so: a little over the minute's tick. */
export const LATE = 2 * MINUTE
/** How long an archived thread's schedules wait for it before they end. */
export const HELD_FOR = 30 * DAY
/** How long an ended schedule is kept (for `schedules.list`) before it's forgotten. */
export const KEPT_FOR = 7 * DAY

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const ACTIONS: readonly Action[] = ['wake', 'notify', 'both']

/** A short name from a message: its first words. */
export function labelOf(message: string) {
  const words = message.trim().split(/\s+/).slice(0, 5).join(' ').replace(/[.,:;!?]+$/, '')
  return words.length > 40 ? `${words.slice(0, 39).trimEnd()}…` : words
}

/** Whether it's still going (paused or held too): not ended. */
export const live = (s: Schedule) => !s.ended

/** Whether it wakes the agent (alone, or as well as reminding): what waits for its thread to be free. */
export const wakes = (s: Pick<Schedule, 'action'>) => s.action !== 'notify'

/** Its next runs from `next` on, `count` at most, within its runs and end. */
export function upcoming(s: Pick<Schedule, 'when' | 'next' | 'runs' | 'maxRuns' | 'ends'>, count = 3): number[] {
  if (s.next === null) return []
  if (!repeats(s.when)) return [s.next]
  const times: number[] = []
  for (let at: number | null = s.next; at !== null && times.length < count && s.runs + times.length < s.maxRuns && (s.ends === undefined || at <= s.ends); at = nextAfter(s.when, at)) times.push(at)
  return times
}

/** What its thread's facts say: its soonest run, and how many it has. */
export function factsOf(list: Schedule[]): Facts | undefined {
  const going = list.filter((s) => live(s) && !s.held)
  if (!going.length) return undefined
  const soonest = going.filter((s) => !s.paused && s.next !== null).sort((a, b) => a.next! - b.next!)[0]
  return {
    next: soonest?.next ?? null, ...(soonest ? { label: soonest.label } : {}), count: going.length,
    paused: going.filter((s) => s.paused).length, pending: going.filter((s) => s.pending && !s.paused).length,
  }
}

const invalid = (message: string) => new RpcError('invalid', message)

/** A time in words, read; a `WhenError` as an `invalid` one, saying `what` it was for. */
function read<T>(work: () => T, what?: string): T {
  try { return work() } catch (error) {
    if (error instanceof WhenError) throw invalid(what ? `${what}: ${error.message}` : error.message)
    throw error
  }
}

export function scheduler(host: SchedulerHost) {
  const all = new Map<string, Schedule>()
  // One change at a time: a tick, an action and a hook never interleave their reads and writes.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work)
    chain = next.catch(() => undefined)
    return next
  }
  const touched = new Set<string>()
  const touch = (s: Schedule) => touched.add(s.thread)
  async function commit() {
    if (!touched.size) return
    const threads = [...touched]
    touched.clear()
    await host.save([...all.values()])
    host.changed(threads)
  }
  const find = (id: string) => {
    const s = all.get(id)
    if (!s) throw new RpcError('not_found', `No schedule ${id}`)
    return s
  }
  /** A notice in the thread; one that can't be given (the thread archived meanwhile, say) is logged, and scheduling goes on. */
  const tell = (thread: string, text: string, options: NoticeOptions) =>
    host.notice(thread, text, options).catch((error: unknown) => console.error(`schedules: telling ${thread} "${text}" failed:`, error))
  const of = (thread: string) => [...all.values()].filter((s) => s.thread === thread)
  // When schedules last woke each thread, the past hour's: the wake budget (\`CAPS.wakesPerHour\`), whichever schedules did.
  const woke = new Map<string, number[]>()
  const wokeLately = (thread: string, now: number) => {
    const times = (woke.get(thread) ?? []).filter((at) => now - at < HOUR)
    woke.set(thread, times)
    return times
  }
  const tz = () => host.tz?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  function end(s: Schedule, why: EndedWhy, reason?: string) {
    s.ended = { at: host.now(), why, ...(reason ? { reason } : {}) }
    s.next = null
    delete s.pending
    touch(s)
  }

  const newId = () => {
    for (;;) {
      const id = host.id?.() ?? `s_${Math.random().toString(36).slice(2, 6)}`
      if (!all.has(id)) return id
    }
  }

  /**
   * What a schedule is from what was said (`input`), checked against the guards: its time read (unless `kept`, the
   * time it has, which stands), its runs and end. `was`: the schedule it changes, whose runs count. Throws `invalid`.
   */
  function shape(input: Omit<NewSchedule, 'thread'>, now: number, { kept, was, by }: { kept?: { when: When; next: number | null }; was?: Schedule; by?: string } = {}) {
    const limits = host.limits()
    const message = input.message.trim()
    if (!message) throw invalid('A schedule needs a message: what the agent is told, or you are reminded of, when it fires.')
    const action = input.action ?? 'wake'
    if (!ACTIONS.includes(action)) throw invalid(`action is wake, notify or both, not ${String(action)}.`)
    const when = kept?.when ?? read(() => parseWhen(input.when, now, tz()))
    const next = kept ? kept.next : firstRun(when, now)
    if (next === null) throw invalid(`"${input.when}" never comes.`)
    const out: Pick<Schedule, 'label' | 'message' | 'action' | 'when' | 'said' | 'next' | 'maxRuns' | 'until' | 'ends'> = {
      label: input.label?.trim() || labelOf(message), message, action, when, said: input.when.trim(), next, maxRuns: 1,
    }
    if (repeats(when)) {
      const min = action === 'notify' ? CAPS.minIntervalMinutes : limits.minInterval
      const gap = shortestGap(when, now)
      if (gap !== undefined && gap < min * MINUTE) throw invalid(`${howWords(when)} is too often: at most every ${min} min${action === 'notify' ? '' : ' for a wake'}.`)
      const maxRuns = input.maxRuns ?? was?.maxRuns ?? limits.maxRuns
      if (!Number.isInteger(maxRuns) || maxRuns < 1) throw invalid('maxRuns is a whole number of runs, 1 or more.')
      if (maxRuns > CAPS.maxRuns) throw invalid(`maxRuns is ${CAPS.maxRuns} at most.`)
      if (was && maxRuns <= was.runs) throw invalid(`It has run ${plural(was.runs, 'time')} already: give it more runs than that.`)
      let ends = was?.ends ?? now + limits.days * DAY
      if (input.ends) ends = read(() => parseAt(input.ends!, now), 'ends')
      if (ends > now + CAPS.days * DAY) throw invalid(`A schedule ends ${CAPS.days} days ahead at most.`)
      if (ends < next) throw invalid(`It ends (${shortWhen(ends, now)}) before its next run (${shortWhen(next, now)}).`)
      out.maxRuns = maxRuns
      out.ends = ends
      if (input.until?.trim()) out.until = input.until.trim()
    } else if (by === 'agent' && action !== 'notify' && !kept && next - now < limits.minInterval * MINUTE) {
      // A run that schedules the next one-shot, over and over, is a loop: the agent's wakes are as far apart as a repeat's.
      throw invalid(`A wake you schedule is ${limits.minInterval} min ahead at least. To repeat, schedule "every …" with \`until\`, not one-shot after one-shot.`)
    } else if (input.until?.trim() || input.maxRuns !== undefined || input.ends) {
      throw invalid('until, maxRuns and ends are for a repeating schedule ("every 30m", "every weekday at 9"); this one runs once.')
    }
    return out
  }

  /** What the agent is told with a firing's words: which schedule and run it is, how late, and when to stop. */
  function wakeContext(s: Schedule, { run, next, due, now, missed, late }: { run: number; next: number | null; due: number; now: number; missed: number; late: boolean }) {
    const what = repeats(s.when)
      ? `run ${run} of up to ${s.maxRuns}, ${howWords(s.when)}; ${next !== null ? `next ${shortWhen(next, now)}` : 'its last run'}`
      : `once, for ${shortWhen(due, now)}`
    return [
      `${SCHEDULED} ${s.label} (${what}). The message is this schedule's (${s.id}), sent for the user, not typed by them.`,
      s.action === 'both' && 'The user was shown it as a reminder too.',
      late && `Late: it was due ${shortWhen(due, now)} and ran ${clockTime(now)}${missed ? `; ${plural(missed, 'run')} missed` : ''}.`,
      s.until && `Stop when: ${s.until}. If that now holds, call schedule_cancel({ id: "${s.id}", reason }) after you've checked.`,
    ].filter(Boolean).join('\n')
  }

  /** Why a run was late, in words. */
  const lateWords = (due: number, now: number) => `${shortDuration(now - due)} late, ${due < host.started ? "as Superego wasn't running" : 'as this machine was asleep'}`

  /** Fire `s` (pending): its reminder, its wake (its thread free), or both. */
  async function fire(s: Schedule, now: number) {
    const pending = s.pending!
    // Runs that came due while it waited for the thread are missed, not stacked.
    const missed = pending.missed + runsBetween(s.when, pending.since, now)
    const late = pending.since - pending.due > LATE
    const run = s.runs + 1
    let next = nextAfter(s.when, now)
    let ended: EndedWhy | undefined = repeats(s.when) ? next === null ? 'done' : undefined : 'done'
    if (repeats(s.when) && run >= s.maxRuns) { ended = 'maxRuns'; next = null }
    else if (next !== null && s.ends !== undefined && next > s.ends) { ended = 'ends'; next = null }
    // Over the thread's wake budget: paused, said, not fired (a loop, or more schedules than a thread should run).
    if (wakes(s) && !pending.now && wokeLately(s.thread, now).length >= CAPS.wakesPerHour) {
      s.paused = true
      delete s.pending
      touch(s)
      await tell(s.thread, `${s.label} paused: schedules woke this thread ${CAPS.wakesPerHour} times in the last hour, the most they may. Resume it from the clock if that's meant.`, { agent: true })
      return
    }
    try {
      if (s.action !== 'wake' && !pending.reminded) {
        const data: Reminder = {
          id: s.id, label: s.label, message: s.message, run, ...(repeats(s.when) ? { maxRuns: s.maxRuns, how: howWords(s.when) } : {}), ...(late ? { late: pending.due } : {}),
        }
        await host.notice(s.thread, s.message, {
          // Doing both, the wake tells it; else it's told the user was reminded, as context.
          agent: s.action === 'both' ? false : `Reminded the user, as scheduled (${s.id}, "${s.label}"): ${s.message}`,
          kind: REMINDER, data,
        })
        pending.reminded = true
        pending.told = true
      }
      if (late && !pending.told) {
        pending.told = true
        await tell(s.thread, `${s.label} ran ${lateWords(pending.due, pending.since)}.${missed ? ` ${plural(missed, 'run')} skipped.` : ''}`, { agent: false })
      }
      if (wakes(s)) await host.wake(s, { message: s.message, context: wakeContext(s, { run, next, due: pending.due, now, missed, late }) })
    } catch (error) {
      // It stays due, and goes again with the next tick; its row says why it didn't.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`schedules: firing ${s.id} into ${s.thread} failed:`, error)
      if (s.error !== message) s.error = message
      touch(s)
      return
    }
    delete s.error
    delete s.pending
    s.runs = run
    s.lastRun = now
    s.missed += missed
    if (wakes(s)) { s.awaiting = true; wokeLately(s.thread, now).push(now) }
    s.next = next
    touch(s)
    if (ended) end(s, ended)
    if (ended === 'maxRuns') await tell(s.thread, `${s.label} stopped after ${plural(s.runs, 'run')}.`, { agent: false })
    if (ended === 'ends') await tell(s.thread, `${s.label} stopped: it reached its end, ${shortWhen(s.ends!, now)}.`, { agent: false })
  }

  /** Fire what's pending for a thread: its reminders at once, its wakes if it's free. */
  async function deliver(thread: string) {
    const waiting = of(thread).filter((s) => s.pending && live(s) && (!s.paused || s.pending.now) && s.held === undefined)
    if (!waiting.length) return
    const info = await host.info(thread)
    if (!info) {
      for (const s of waiting) end(s, 'cancelled', 'its thread is gone')
      return
    }
    // Continued in another thread: its schedules go with it.
    if (info.continuedIn) {
      for (const s of of(thread).filter(live)) { touch(s); s.thread = info.continuedIn; touch(s) }
      await deliver(info.continuedIn)
      return
    }
    if (info.archived || info.without?.includes('schedules')) return
    const busy = host.busy(info)
    for (const s of waiting) if (!busy || !wakes(s)) await fire(s, host.now())
  }

  async function due() {
    const now = host.now()
    for (const s of all.values()) {
      if (s.ended) {
        if (now - s.ended.at > KEPT_FOR) { all.delete(s.id); touch(s) }
        continue
      }
      if (s.held !== undefined) {
        if (now - s.held > HELD_FOR) end(s, 'archived', 'its thread stayed archived')
        continue
      }
      if (s.paused || s.pending || s.next === null || s.next > now) continue
      if (repeats(s.when) && s.ends !== undefined && now >= s.ends) {
        end(s, 'ends')
        await tell(s.thread, `${s.label} ended: its end, ${shortWhen(s.ends, now)}, passed ${s.ends < host.started ? "while Superego wasn't running" : 'while this machine was asleep'}.`, { agent: true })
        continue
      }
      s.pending = { since: now, due: s.next, missed: runsBetween(s.when, s.next, now) }
      touch(s)
    }
    for (const thread of new Set([...all.values()].filter((s) => s.pending).map((s) => s.thread))) {
      // One thread that can't be reached doesn't hold up the rest; it's tried again with the next tick.
      try { await deliver(thread) } catch (error) { console.error(`schedules: firing into ${thread} failed:`, error) }
    }
  }

  /** Its next run from now, going on (resumed, back from archived): an interval's from now, the calendar's next. */
  const goOn = (s: Schedule, now: number) => repeats(s.when) ? nextAfter(s.when, now) : now

  return {
    load(list: Schedule[]) {
      for (const s of list) {
        all.set(s.id, s)
        if (s.lastRun !== undefined && wakes(s)) woke.set(s.thread, [...woke.get(s.thread) ?? [], s.lastRun])
      }
    },
    /** Once what's under way is done: for teardown. */
    settled: () => chain.then(() => undefined),
    /** Every schedule, or a thread's, ended ones too. */
    list: (thread?: string) => [...all.values()].filter((s) => !thread || s.thread === thread),
    get: (id: string) => all.get(id),
    /** A thread's schedules that are going (paused ones too), soonest first. */
    active: (thread: string) => of(thread).filter((s) => live(s)).sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)),
    /** Every thread's schedules that are going, soonest first. */
    going: () => [...all.values()].filter((s) => live(s)).sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)),
    facts: (thread: string) => factsOf(of(thread)),
    /** The soonest a schedule comes due, for the timer. */
    soonest() {
      let soonest: number | undefined
      for (const s of all.values()) if (live(s) && !s.paused && s.held === undefined && !s.pending && s.next !== null && (soonest === undefined || s.next < soonest)) soonest = s.next
      return soonest
    },
    /** What `when` comes to now, as a form shows it while it's typed; throws `invalid` saying what's wrong. */
    understand(when: string, action: Action = 'wake') {
      const now = host.now()
      const s = shape({ when, message: '-', action }, now)
      return { how: repeats(s.when) ? howWords(s.when) : 'once', times: upcoming({ ...s, runs: 0 }), repeats: repeats(s.when), tz: 'cron' in s.when ? s.when.tz : tz() }
    },

    /** Make one, from the user's words; throws an `RpcError` saying what's wrong. */
    add: (input: NewSchedule, by: string) => serial(async () => {
      const now = host.now()
      const limits = host.limits()
      const shaped = shape(input, now, { by })
      const going = [...all.values()].filter(live)
      if (going.filter((s) => s.thread === input.thread).length >= limits.perThread) throw invalid(`This thread has ${limits.perThread} schedules already, the most it may: cancel one first.`)
      if (going.length >= CAPS.perMachine) throw invalid(`This machine has ${CAPS.perMachine} schedules already, the most it may: cancel one first.`)
      const s: Schedule = { id: newId(), thread: input.thread, ...shaped, runs: 0, missed: 0, paused: false, by, created: now }
      all.set(s.id, s)
      touch(s)
      await commit()
      return s
    }),

    /**
     * Change one: what's given of what it says, when, what it does, its runs and end (`until: ''` clears its
     * condition). A new time counts from now; the same words keep the time it has. Throws `invalid` saying what's wrong.
     */
    update: (id: string, change: ScheduleChange) => serial(async () => {
      const s = find(id)
      if (s.ended) throw invalid(`${s.label} has ended.`)
      const now = host.now()
      const said = change.when?.trim()
      const retimed = said !== undefined && said !== s.said
      const repeating = retimed ? repeats(read(() => parseWhen(said, now, tz()))) : repeats(s.when)
      const input: Omit<NewSchedule, 'thread'> = {
        when: said ?? s.said, message: change.message ?? s.message, action: change.action ?? s.action,
        // A new message names it anew, unless it had a name of its own.
        label: change.label ?? (change.message !== undefined && s.label === labelOf(s.message) ? '' : s.label),
        ...(repeating ? { until: change.until ?? s.until ?? '' } : change.until ? { until: change.until } : {}),
        ...(change.maxRuns !== undefined ? { maxRuns: change.maxRuns } : {}),
        ...(change.ends ? { ends: change.ends } : {}),
      }
      const shaped = shape(input, now, { ...(retimed ? {} : { kept: { when: s.when, next: s.next } }), ...(repeating ? { was: s } : {}) })
      Object.assign(s, shaped)
      if (!shaped.until) delete s.until
      if (!repeating) { delete s.ends; s.maxRuns = 1 }
      // Its error was the old one's; a firing waiting goes with the new time (a new time, it waits no longer).
      delete s.error
      if (retimed) delete s.pending
      touch(s)
      await commit()
      return s
    }),

    /** Cancel it: `reason` is said in the thread (and to the agent, unless it's the agent's own). */
    cancel: (id: string, { reason, who }: { reason?: string; who: 'agent' | 'user' | string }) => serial(async () => {
      const s = find(id)
      if (s.ended) return s
      end(s, 'cancelled', reason)
      await commit()
      const why = reason ? `: ${reason.replace(/\.$/, '')}` : who === 'user' ? ': cancelled by you' : ''
      await tell(s.thread, `${s.label} stopped${why}.`, { agent: who !== 'agent' })
      return s
    }),
    pause: (id: string) => serial(async () => {
      const s = find(id)
      if (s.ended) throw invalid(`${s.label} has ended.`)
      s.paused = true
      delete s.pending
      touch(s)
      await commit()
      return s
    }),
    resume: (id: string) => serial(async () => {
      const s = find(id)
      if (s.ended) throw invalid(`${s.label} has ended.`)
      const now = host.now()
      s.paused = false
      s.failures = 0
      // A repeating one goes on from now; a one-shot past its time fires now (not late: it waited on purpose).
      if (s.next !== null && s.next <= now) s.next = goOn(s, now)
      touch(s)
      await commit()
      await due()
      await commit()
      return s
    }),
    /** Fire it now (a wake once its thread is free), whatever its time; paused, it stays paused after. */
    run: (id: string) => serial(async () => {
      const s = find(id)
      if (s.ended) throw invalid(`${s.label} has ended.`)
      if (s.held !== undefined) throw invalid('Its thread is archived.')
      const now = host.now()
      s.pending ??= { since: now, due: now, missed: 0 }
      s.pending.now = true
      touch(s)
      await deliver(s.thread)
      await commit()
      return s
    }),

    /** Fire what's due and what waited: from the timer, the minute's tick, and as the daemon starts. */
    tick: () => serial(async () => { await due(); await commit() }),

    /** A thread's run ended: count a failed wake, then fire what waited for it. */
    turnEnded: (thread: ThreadInfo) => serial(async () => {
      for (const s of of(thread.id).filter((s) => s.awaiting)) {
        s.awaiting = false
        s.failures = thread.status.state === 'error' ? (s.failures ?? 0) + 1 : 0
        touch(s)
        if (s.failures >= 2 && live(s) && !s.paused) {
          s.paused = true
          await tell(s.thread, `${s.label} paused: the runs it started failed twice in a row. Resume it from the clock once the thread works again.`, { agent: false })
        }
      }
      await due()
      await commit()
    }),
    /** It's free again (a question answered, say): fire what waited. */
    free: (thread: string) => serial(async () => { await deliver(thread); await commit() }),

    archived: (thread: string) => serial(async () => {
      const now = host.now()
      for (const s of of(thread).filter(live)) { s.held = now; delete s.pending; touch(s) }
      await commit()
    }),
    unarchived: (thread: string) => serial(async () => {
      const now = host.now()
      const missed: Schedule[] = []
      for (const s of of(thread).filter((s) => live(s) && s.held !== undefined)) {
        delete s.held
        touch(s)
        if (s.next === null || s.next > now) continue
        if (repeats(s.when)) s.next = goOn(s, now)
        else if (!s.paused) { s.paused = true; missed.push(s) }
      }
      await commit()
      for (const s of missed) {
        await tell(thread, `${s.label} was due ${shortWhen(s.next!, now)}, while this thread was archived. It's paused: run it now, or cancel it.`, {
          agent: false, actions: [{ label: 'Run now', action: 'schedules.run', params: { id: s.id }, style: 'primary' }, { label: 'Cancel', action: 'schedules.cancel', params: { id: s.id } }],
        })
      }
    }),
  }
}

export type Scheduler = ReturnType<typeof scheduler>
