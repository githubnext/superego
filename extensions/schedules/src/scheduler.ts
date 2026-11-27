// schedules: the scheduler, apart from the daemon so tests drive it with their own clock and threads. It keeps every
// schedule of the machine, says which are due (`tick`, from the daemon's timer and its minute's tick), and wakes a
// thread once it's free: not in a run, not waiting on the user (a question, a permission, a sign-in), not stuck. A
// schedule due while its thread is busy waits (`pending`), one firing at most: what comes due meanwhile is missed, not
// stacked, and a repeating one's next run counts from when it went, so a long run doesn't bring two back to back.
//
// Missed runs (the machine asleep, Superego not running) fire once, late, saying how late and how many were skipped; a
// one-shot fires however late. A repeating one whose end passed meanwhile ends instead, saying so. An archived thread's
// schedules wait (`held`) until it's back: a repeating one goes on from then, a one-shot that came due meanwhile waits
// paused, the thread told. Two wakes in a row whose run failed pause it (no burning tokens on a broken thread).
//
// Every change is saved at once (`host.save`) and told (`host.changed`), so the window and the facts follow.
import { RpcError, type ThreadInfo } from '@superego/protocol'
import { CAPS, SCHEDULED, type EndedWhy, type Facts, type Schedule } from './shared.ts'
import { clockTime, DAY, everyWords, MINUTE, parseAt, parseWhen, shortDuration, shortWhen, WhenError } from './when.ts'

/** The guards, as this machine's settings say (`CAPS` bound them). */
export type Limits = { minInterval: number; maxRuns: number; days: number; perThread: number }

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
  /** Tell the user in the thread (a notice); `agent`: tell its agent too. */
  notice(thread: string, text: string, options: { agent: boolean; actions?: NoticeButton[] }): Promise<void>
  save(all: Schedule[]): Promise<void>
  /** The threads whose schedules changed. */
  changed(threads: string[]): void
  limits(): Limits
  /** A new schedule's id (`s_<rand>`, unless a test names them). */
  id?(): string
}

/** A notice's button: an action of ours, on a schedule. */
export type NoticeButton = { label: string; action: string; params: { id: string }; style?: 'primary' | 'danger' }

/** What `schedules.add` and the `schedule` tool take. */
export type NewSchedule = { thread: string; when: string; message: string; label?: string; until?: string; maxRuns?: number; ends?: string }

/** How late a run may go before it says so: a little over the minute's tick. */
export const LATE = 2 * MINUTE
/** How long an archived thread's schedules wait for it before they end. */
export const HELD_FOR = 30 * DAY
/** How long an ended schedule is kept (for `schedules.list`) before it's forgotten. */
export const KEPT_FOR = 7 * DAY

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A short name from a message: its first words. */
export function labelOf(message: string) {
  const words = message.trim().split(/\s+/).slice(0, 5).join(' ').replace(/[.,:;!?]+$/, '')
  return words.length > 40 ? `${words.slice(0, 39).trimEnd()}…` : words
}

/** Whether it's still going (paused or held too): not ended. */
export const live = (s: Schedule) => !s.ended

/** Its next runs from `next` on, `count` at most, within its runs and end. */
export function upcoming(s: Pick<Schedule, 'when' | 'next' | 'runs' | 'maxRuns' | 'ends'>, count = 3): number[] {
  if (s.next === null) return []
  if ('at' in s.when) return [s.next]
  const times: number[] = []
  for (let at = s.next; times.length < count && s.runs + times.length < s.maxRuns && (s.ends === undefined || at <= s.ends); at += s.when.every) times.push(at)
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
  const tell = (thread: string, text: string, options: Parameters<SchedulerHost['notice']>[2]) =>
    host.notice(thread, text, options).catch((error: unknown) => console.error(`schedules: telling ${thread} "${text}" failed:`, error))
  const of = (thread: string) => [...all.values()].filter((s) => s.thread === thread)

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

  /** What the agent is told with a firing's words: which schedule and run it is, how late, and when to stop. */
  function wakeContext(s: Schedule, { run, next, due, now, missed, late }: { run: number; next: number | null; due: number; now: number; missed: number; late: boolean }) {
    const what = 'every' in s.when
      ? `run ${run} of up to ${s.maxRuns}, ${everyWords(s.when.every)}; ${next !== null ? `next ${shortWhen(next, now)}` : 'its last run'}`
      : `once, for ${shortWhen(due, now)}`
    return [
      `${SCHEDULED} ${s.label} (${what}). The message is this schedule's (${s.id}), sent for the user, not typed by them.`,
      late && `Late: it was due ${shortWhen(due, now)} and ran ${clockTime(now)}${missed ? `; ${plural(missed, 'run')} missed` : ''}.`,
      s.until && `Stop when: ${s.until}. If that now holds, call schedule_cancel({ id: "${s.id}", reason }) after you've checked.`,
    ].filter(Boolean).join('\n')
  }

  /** Why a run was late, in words. */
  const lateWords = (due: number, now: number) => `${shortDuration(now - due)} late, ${due < host.started ? "as Superego wasn't running" : 'as this machine was asleep'}`

  /** Fire `s` (pending) into its thread, now free. */
  async function fire(s: Schedule, now: number) {
    const pending = s.pending!
    const every = 'every' in s.when ? s.when.every : undefined
    // Runs that came due while it waited for the thread are missed, not stacked.
    const missed = pending.missed + (every ? Math.floor((now - pending.since) / every) : 0)
    const late = pending.since - pending.due > LATE
    const run = s.runs + 1
    let next: number | null = every ? now + every : null
    let ended: EndedWhy | undefined = every ? undefined : 'done'
    if (every && run >= s.maxRuns) { ended = 'maxRuns'; next = null }
    else if (every && s.ends !== undefined && next! > s.ends) { ended = 'ends'; next = null }
    if (late && !pending.told) {
      pending.told = true
      await tell(s.thread, `${s.label} ran ${lateWords(pending.due, pending.since)}.${missed ? ` ${plural(missed, 'run')} skipped.` : ''}`, { agent: false })
    }
    try {
      await host.wake(s, { message: s.message, context: wakeContext(s, { run, next, due: pending.due, now, missed, late }) })
    } catch (error) {
      // It stays due, and goes again with the next tick; its row says why it didn't.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`schedules: waking ${s.thread} for ${s.id} failed:`, error)
      if (s.error !== message) { s.error = message; touch(s) }
      return
    }
    delete s.error
    delete s.pending
    s.runs = run
    s.lastRun = now
    s.missed += missed
    s.awaiting = true
    s.next = next
    touch(s)
    if (ended) end(s, ended)
    if (ended === 'maxRuns') await tell(s.thread, `${s.label} stopped after ${plural(s.runs, 'run')}.`, { agent: false })
    if (ended === 'ends') await tell(s.thread, `${s.label} stopped: it reached its end, ${shortWhen(s.ends!, now)}.`, { agent: false })
  }

  /** Fire what's pending for a thread, if it's free. */
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
    if (info.archived || info.without?.includes('schedules') || host.busy(info)) return
    for (const s of waiting) await fire(s, host.now())
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
      if ('every' in s.when && s.ends !== undefined && now >= s.ends) {
        end(s, 'ends')
        await tell(s.thread, `${s.label} ended: its end, ${shortWhen(s.ends, now)}, passed ${s.ends < host.started ? "while Superego wasn't running" : 'while this machine was asleep'}.`, { agent: true })
        continue
      }
      const missed = 'every' in s.when ? Math.floor((now - s.next) / s.when.every) : 0
      s.pending = { since: now, due: s.next, missed }
      touch(s)
    }
    for (const thread of new Set([...all.values()].filter((s) => s.pending).map((s) => s.thread))) {
      // One thread that can't be reached doesn't hold up the rest; it's tried again with the next tick.
      try { await deliver(thread) } catch (error) { console.error(`schedules: firing into ${thread} failed:`, error) }
    }
  }

  return {
    load(list: Schedule[]) { for (const s of list) all.set(s.id, s) },
    /** Every schedule, or a thread's, ended ones too. */
    list: (thread?: string) => [...all.values()].filter((s) => !thread || s.thread === thread),
    get: (id: string) => all.get(id),
    /** A thread's schedules that are going (paused ones too), soonest first. */
    active: (thread: string) => of(thread).filter((s) => live(s)).sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)),
    facts: (thread: string) => factsOf(of(thread)),
    /** The soonest a schedule comes due, for the timer. */
    soonest() {
      let soonest: number | undefined
      for (const s of all.values()) if (live(s) && !s.paused && s.held === undefined && !s.pending && s.next !== null && (soonest === undefined || s.next < soonest)) soonest = s.next
      return soonest
    },

    /** Make one, from the user's words; throws an `RpcError` saying what's wrong. */
    add: (input: NewSchedule, by: string) => serial(async () => {
      const now = host.now()
      const limits = host.limits()
      const message = input.message.trim()
      if (!message) throw invalid('A schedule needs a message: what the agent is told when it fires.')
      let when
      try { when = parseWhen(input.when, now) } catch (error) {
        if (error instanceof WhenError) throw invalid(error.message)
        throw error
      }
      const going = [...all.values()].filter(live)
      if (going.filter((s) => s.thread === input.thread).length >= limits.perThread) throw invalid(`This thread has ${limits.perThread} schedules already, the most it may: cancel one first.`)
      if (going.length >= CAPS.perMachine) throw invalid(`This machine has ${CAPS.perMachine} schedules already, the most it may: cancel one first.`)
      const s: Schedule = {
        id: newId(), thread: input.thread, label: input.label?.trim() || labelOf(message), message, action: 'wake', when, said: input.when.trim(),
        maxRuns: 1, next: 'at' in when ? when.at : when.anchor + when.every, runs: 0, missed: 0, paused: false, by, created: now,
      }
      if ('every' in when) {
        if (when.every < limits.minInterval * MINUTE) throw invalid(`${everyWords(when.every)} is too often: at least every ${limits.minInterval} min.`)
        const maxRuns = input.maxRuns ?? limits.maxRuns
        if (!Number.isInteger(maxRuns) || maxRuns < 1) throw invalid('maxRuns is a whole number of runs, 1 or more.')
        if (maxRuns > CAPS.maxRuns) throw invalid(`maxRuns is ${CAPS.maxRuns} at most.`)
        let ends = now + limits.days * DAY
        if (input.ends) {
          try { ends = parseAt(input.ends, now) } catch (error) {
            if (error instanceof WhenError) throw invalid(`ends: ${error.message}`)
            throw error
          }
        }
        if (ends > now + CAPS.days * DAY) throw invalid(`A schedule ends ${CAPS.days} days ahead at most.`)
        if (ends < s.next!) throw invalid(`It ends (${shortWhen(ends, now)}) before its first run (${shortWhen(s.next!, now)}).`)
        s.maxRuns = maxRuns
        s.ends = ends
        if (input.until?.trim()) s.until = input.until.trim()
      } else if (input.until?.trim() || input.maxRuns !== undefined || input.ends) {
        throw invalid('until, maxRuns and ends are for a repeating schedule ("every 30m"); this one runs once.')
      }
      all.set(s.id, s)
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
      if (s.next !== null && s.next <= now) s.next = 'every' in s.when ? now + s.when.every : now
      touch(s)
      await commit()
      await due()
      await commit()
      return s
    }),
    /** Fire it now (once its thread is free), whatever its time; paused, it stays paused after. */
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
        if ('every' in s.when) s.next = now + s.when.every
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
