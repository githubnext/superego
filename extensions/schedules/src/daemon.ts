// schedules, daemon half: the machine's schedules, kept in a file of its own (`superego.dir`/schedules.json), fired by
// one timer to the soonest (re-armed on every change) and a minute's tick besides, as a timer doesn't count the time a
// machine sleeps: a run missed while it slept fires within a minute of waking, once, saying how late. Starting, the
// daemon catches up the same way. The scheduler (scheduler.ts) decides; this wires it to the daemon: threads, hooks,
// the agent's tools, actions for the window and the command line, facts for the sidebar and a live value per thread.
//
// The agent gets `schedule`, `schedule_list` and `schedule_cancel`, for its own thread's schedules only; the user's
// actions (`schedules.*`, from the window, `superego do`, another extension's `dispatch`) reach any, and change them
// (`schedules.update`). A wake is the user's words sent by the clock (`threads.send`, with what the agent alone is told
// as its `context`, within the thread's wake budget); a reminder, and what happened around a firing (late, stopped,
// paused), a notice in the thread (`threads.notice`: unread, notified, no run).
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { int, obj, oneOf, opt, str } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension, type DaemonApi } from '@superego/daemon'
import { RpcError, stuck, WAKES_PER_HOUR, type Json } from '@superego/protocol'
import { scheduler, upcoming, type Limits, type NewSchedule, type ScheduleChange } from './scheduler.ts'
import { about, ACTIONS, ALL_VALUE, CAPS, DEFAULTS, LIST_METHOD, PROBLEM_VALUE, SECTION, SETTINGS, SPLIT_METHOD, THREAD_VALUE, TOOLS, UNDERSTAND_METHOD, type Schedule, type ScheduleDetails } from './shared.ts'
import { clockTime, dayWord, FORMS, howWords, localWords, repeats, splitSaid, timezone } from './when.ts'

/** The time, and a way to be called back: the real ones, or a test's. */
export type Clock = { now(): number; after(ms: number, run: () => void): () => void }
const REAL: Clock = { now: () => Date.now(), after(ms, run) { const timer = setTimeout(run, ms); return () => clearTimeout(timer) } }

/** How often it looks, whatever its timer says: a slept machine's missed runs fire within this of waking. */
export const TICK = 60_000

const FILE = 'schedules.json'
type Stored = { version: 1; schedules: Schedule[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A one-shot's time, as a date that doesn't move: "2026-05-06 09:00". */
const dateTime = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clockTime(at)}` }

/** A schedule as the prompt has it: what it is, which stays put while it runs. */
export function stableLine(s: Schedule) {
  const when = 'at' in s.when ? `once, ${dateTime(s.when.at)}` : howWords(s.when)
  const does = s.action === 'notify' ? ', reminds the user' : s.action === 'both' ? ', reminds the user and wakes you' : ''
  return `- ${s.id} "${s.label}": ${when}${does}${s.until ? `, until: ${s.until}` : ''}`
}

/** A schedule as the agent reads it, in a line. */
function line(s: Schedule, now: number) {
  const when = `${howWords(s.when)}${s.action === 'notify' ? ', reminds the user' : s.action === 'both' ? ', reminds the user and wakes you' : ''}`
  const next = s.ended ? `ended (${s.ended.why}${s.ended.reason ? `: ${s.ended.reason}` : ''})`
    : s.paused ? 'paused' : s.pending ? 'due, waiting for this thread to be free'
    : s.next !== null ? `next ${dayWord(s.next, now)} ${clockTime(s.next)}` : ''
  const runs = repeats(s.when) ? `, run ${s.runs} of up to ${s.maxRuns}` : ''
  return `- ${s.id} "${s.label}": ${when}, ${next}${runs}${s.until ? `, until: ${s.until}` : ''}`
}

const SCHEDULE_DESCRIPTION = `Schedule something for this thread: once ("in 30m", "tomorrow 9am"), repeating ("every 30m") or on the calendar ("every weekday at 9", cron). ` +
  `\`action\` says what it does when due. "wake" (default): you're sent the message as a new turn, to do something ("check CI", "look at the deploy"). ` +
  `"notify": the user is reminded of the message (a notice in the thread, notified, no turn for you): for "remind me …", "ping me …", where nothing needs doing but telling them; write the message to them ("Review Mia's PR"). ` +
  `"both": reminds them and wakes you. Pick from the user's wording. ` +
  `Pass the user's words for the time nearly as they said them; they're read in this machine's timezone (${timezone()}), ` +
  `and the answer says what was understood, so check it. Accepted: ${FORMS}. ` +
  `A repeating one needs a way to stop: give \`until\` (a condition you check on each run, then call ${TOOLS.cancel} once it holds), ` +
  `and it stops anyway after maxRuns (default ${DEFAULTS.maxRuns}) or at \`ends\` (default ${DEFAULTS.days} days). ` +
  `A wake runs at most every ${DEFAULTS.minIntervalMinutes} minutes, a one-shot wake is at least that far ahead, and a thread is woken ${WAKES_PER_HOUR} times an hour at most: to repeat, use "every …", not one-shot after one-shot.`

/** The extension, on `clock` (the real one unless a test gives its own; `id`, its schedules' ids, for a test too). */
export const schedulesExtension = ({ clock = REAL, id }: { clock?: Clock; id?: () => string } = {}) => defineDaemonExtension({
  ...about,
  async setup(superego) {
    const value = superego.scopedValue<Json>(THREAD_VALUE, [])
    const everything = superego.value<Json>(ALL_VALUE, [])
    const problem = superego.value<string | null>(PROBLEM_VALUE, null)
    // What's wrong with its file (unread, kept aside, a save that failed) is said in Settings → Schedules.
    const store = superego.jsonFile<Stored>(FILE, {
      empty: { version: 1, schedules: [] },
      check: (data) => Array.isArray((data as Partial<Stored> | null)?.schedules) ? undefined : 'it has no list of schedules',
      trouble: (message) => problem.set(message ?? null),
    })
    // The threads in a run, as the hooks tell it; one resumed after a restart (no turnStart) shows working.
    const running = new Set<string>()
    let stopped = false

    superego.settings.register({
      id: SECTION, title: 'Schedules', description: 'Threads woken at a time, or every so often. What a repeating one may cost at most.',
      ui: SECTION, value: PROBLEM_VALUE,
      settings: [
        { key: SETTINGS.minInterval, title: 'Shortest interval', description: 'Minutes between wakes, at least.', default: DEFAULTS.minIntervalMinutes, type: { type: 'number', min: CAPS.minIntervalMinutes, max: 24 * 60, step: 1 } },
        { key: SETTINGS.maxRuns, title: 'Runs, unless it says', description: `How many times a repeating schedule runs at most, unless it says (up to ${CAPS.maxRuns}).`, default: DEFAULTS.maxRuns, type: { type: 'number', min: 1, max: CAPS.maxRuns, step: 1 } },
        { key: SETTINGS.days, title: 'Days, unless it says', description: `How long a repeating schedule lasts, unless it says (up to ${CAPS.days}).`, default: DEFAULTS.days, type: { type: 'number', min: 1, max: CAPS.days, step: 1 } },
        { key: SETTINGS.perThread, title: 'Per thread', description: 'How many schedules a thread may have at once.', default: DEFAULTS.perThread, type: { type: 'number', min: 1, max: 50, step: 1 } },
      ],
    })
    const setting = (key: string, fallback: number, max: number) => {
      const n = superego.settings.get<number>(key)
      return typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : fallback
    }
    const limits = (): Limits => ({
      minInterval: Math.max(setting(SETTINGS.minInterval, DEFAULTS.minIntervalMinutes, 24 * 60), CAPS.minIntervalMinutes),
      maxRuns: setting(SETTINGS.maxRuns, DEFAULTS.maxRuns, CAPS.maxRuns),
      days: setting(SETTINGS.days, DEFAULTS.days, CAPS.days),
      perThread: setting(SETTINGS.perThread, DEFAULTS.perThread, 50),
    })

    const info = (id: string) => superego.threads.get(id).catch((error: unknown) => {
      if (error instanceof RpcError && error.kind === 'not_found') return undefined
      throw error
    })
    let timer: (() => void) | undefined
    const sched = scheduler({
      now: () => clock.now(),
      started: clock.now(),
      info,
      // Not while it works or waits on the user (a question, a permission, a sign-in), or can't take messages.
      busy: (thread) => running.has(thread.id) || thread.status.state === 'working' || thread.status.state === 'blocked' || stuck(thread),
      // The words go as the message; what the agent alone needs goes with it.
      wake: (s, { message, context, budgeted }) => superego.threads.send(s.thread, message, { whenBusy: 'followUp', context, ...(budgeted ? { wake: true } : {}) }),
      async notice(thread, text, { agent, actions, kind, data }) {
        await superego.threads.notice(thread, {
          text, ...(agent === true ? {} : { agent }), ...(actions ? { actions } : {}), ...(kind ? { kind } : {}), ...(data ? { data: data as unknown as Json } : {}),
        })
      },
      tz: timezone,
      save: (all) => store.save({ version: 1, schedules: all }),
      changed(threads) {
        for (const thread of threads) value.set(thread, sched.active(thread) as unknown as Json)
        everything.set(sched.going() as unknown as Json)
        superego.invalidate()
        arm()
      },
      limits,
      ...(id ? { id } : {}),
    })
    const failed = (what: string) => (error: unknown) => console.error(`schedules: ${what} failed:`, error)
    /** The timer, to the soonest run or the minute's tick, whichever is sooner. */
    function arm() {
      timer?.()
      if (stopped) return
      const soonest = sched.soonest()
      // A second at least: a tick that fails on something due doesn't spin.
      const wait = Math.max(1000, Math.min(TICK, soonest === undefined ? TICK : soonest - clock.now()))
      timer = clock.after(wait, () => { timer = undefined; sched.tick().catch(failed('a tick')).finally(arm) })
    }

    // What was kept. A file that doesn't read is kept aside, said in Settings (the store) and in each thread it names.
    sched.load((await store.read()).schedules)
    if (store.bad) {
      const threads = new Set([...(store.bad.text ?? '').matchAll(/"thread":\s*"([^"]+)"/g)].map((m) => m[1]!))
      const where = store.bad.keptAs ? `kept as ${store.bad.keptAs}` : `left as it was, at ${store.path}`
      for (const thread of threads) {
        await superego.threads.notice(thread, { text: `This thread's schedules couldn't be read, and are gone for now: the file is ${where}.`, agent: false })
          .catch(failed(`telling ${thread} its schedules are gone`))
      }
    }
    for (const thread of new Set(sched.list().map((s) => s.thread))) value.set(thread, sched.active(thread) as unknown as Json)
    everything.set(sched.going() as unknown as Json)
    superego.invalidate()
    superego.signal.addEventListener('abort', () => { stopped = true; timer?.() })
    // Catch up on what came due while Superego wasn't running, then keep time.
    sched.tick().catch(failed('catching up')).finally(arm)

    superego.facts(({ id }) => sched.facts(id) as Json | undefined)
    superego.thread({
      turnStart: (thread) => { running.add(thread.id) },
      turnEnd: async (thread) => { running.delete(thread.id); await sched.turnEnded(thread) },
      archived: (thread) => sched.archived(thread.id),
      unarchived: async (thread) => { await sched.unarchived(thread.id); await sched.tick() },
    })

    /** Who's asking: the thread's agent (its shell), another extension, or the user. */
    const byOf = (context: { from?: string; by?: string }) => context.from ? 'agent' : context.by ?? 'user'

    const ACTION_PARAM = oneOf(['wake', 'notify', 'both'] as const, { description: 'wake: a message that starts a run; notify: a reminder for the user, no run; both' })
    const NEW_PARAMS = {
      when: str({ minLength: 1, description: `When, in words: ${FORMS}` }),
      message: str({ minLength: 1, description: 'What the agent is told (wake), or the user reminded of (notify), when it fires' }),
      action: opt(ACTION_PARAM),
      label: opt(str({ maxLength: 60, description: 'A short name for the UI ("Check CI"); default: the first words of the message' })),
      until: opt(str({ description: 'Repeating: a condition the agent checks each run, cancelling it once it holds ("CI is green")' })),
      maxRuns: opt(int({ minimum: 1, maximum: CAPS.maxRuns, description: `Repeating: how many runs at most (default ${DEFAULTS.maxRuns})` })),
      ends: opt(str({ description: `Repeating: when it stops, in words ("in 8h", "friday 17:00"; default ${DEFAULTS.days} days)` })),
    }
    const ID = { id: str({ minLength: 1 }) }
    superego.action(defineAction({
      id: ACTIONS.add, title: 'Schedule a wake or a reminder', expose: ['ui', 'cli'],
      description: 'Wake a thread with a message, or remind you of it, at a time, every so often or on the calendar.',
      params: obj({ thread: str({ minLength: 1 }), ...NEW_PARAMS }),
      async run(params, context) {
        await superego.threads.get(params.thread)
        return await sched.add(params as NewSchedule, byOf(context)) as unknown as Json
      },
    }))
    superego.action(defineAction({
      id: ACTIONS.update, title: 'Change a schedule', expose: ['ui', 'cli'],
      description: 'Change what a schedule says, when it runs, what it does, its runs or its end: what\'s given changes. A new time counts from now.',
      params: obj({
        ...ID, when: opt(str({ minLength: 1 })), message: opt(str({ minLength: 1 })), label: opt(str({ maxLength: 60 })), action: opt(ACTION_PARAM),
        until: opt(str({ description: 'Empty: no condition' })), maxRuns: opt(int({ minimum: 1, maximum: CAPS.maxRuns })), ends: opt(str({ minLength: 1 })),
      }),
      run: async ({ id, ...change }) => await sched.update(id, change as ScheduleChange) as unknown as Json,
    }))
    superego.action(defineAction({
      id: ACTIONS.pause, title: 'Pause a schedule', expose: ['ui', 'cli'], params: obj(ID),
      run: async ({ id }) => await sched.pause(id) as unknown as Json,
    }))
    superego.action(defineAction({
      id: ACTIONS.resume, title: 'Resume a schedule', expose: ['ui', 'cli'], params: obj(ID),
      run: async ({ id }) => await sched.resume(id) as unknown as Json,
    }))
    superego.action(defineAction({
      id: ACTIONS.run, title: 'Run a schedule now', expose: ['ui', 'cli'], params: obj(ID),
      description: 'Fire it now, once its thread is free, whatever its time.',
      run: async ({ id }) => await sched.run(id) as unknown as Json,
    }))
    superego.action(defineAction({
      id: ACTIONS.cancel, title: 'Cancel a schedule', expose: ['ui', 'cli'], params: obj({ ...ID, reason: opt(str()) }),
      run: async ({ id, reason }, context) => await sched.cancel(id, { ...(reason ? { reason } : {}), who: byOf(context) }) as unknown as Json,
    }))
    superego.method(LIST_METHOD, ({ thread }) => sched.list(thread) as unknown as Json, { params: obj({ thread: opt(str()) }) })
    superego.method(UNDERSTAND_METHOD, ({ when, action }) => sched.understand(when, action ?? 'wake') as unknown as Json, { params: obj({ when: str({ minLength: 1 }), action: opt(ACTION_PARAM) }) })
    superego.method(SPLIT_METHOD, ({ text }) => (splitSaid(text, clock.now()) ?? null) as Json, { params: obj({ text: str() }) })

    superego.agent(agentPart(superego, sched, () => clock.now()))

    // Torn down (a reload, the daemon closing): no more ticks, and what's under way (a firing) finishes first; its last
    // save lands before the next instance reads the file (the store's).
    return async () => {
      stopped = true
      timer?.()
      await sched.settled()
    }
  },
})

/** The agent's tools, for its own thread's schedules, and what it's told of them. */
function agentPart(superego: DaemonApi, sched: ReturnType<typeof scheduler>, now: () => number) {
  const threadOf = (conversationId: unknown) => {
    const thread = superego.threads.of(Number(conversationId))
    if (!thread) throw new Error('Schedules are for threads; this conversation isn\'t one.')
    return thread
  }
  const own = (thread: string, id: string) => {
    const s = sched.get(id)
    if (!s || s.thread !== thread) throw new Error(`No schedule ${id} in this thread. ${TOOLS.list} lists them.`)
    return s
  }
  return defineExtension({
    name: about.name,
    tools: [
      defineTool({
        name: TOOLS.schedule,
        description: SCHEDULE_DESCRIPTION,
        parameters: obj({
          when: str({ minLength: 1, description: `When, in the user's words: ${FORMS}` }),
          message: str({ minLength: 1, description: "What you're told when it fires (wake: what to do, as a note to yourself), or what the user is reminded of (notify: to them)" }),
          action: opt(oneOf(['wake', 'notify', 'both'] as const, { description: '"wake" (default): a turn for you, to do something; "notify": remind the user, no turn ("remind me …"); "both"' })),
          label: opt(str({ maxLength: 60, description: 'A short name the user sees ("Check CI"); default: the first words of the message' })),
          until: opt(str({ description: 'Repeating: a condition you check on each run, cancelling it once it holds ("CI is green")' })),
          maxRuns: opt(int({ minimum: 1, maximum: CAPS.maxRuns, description: `Repeating: how many runs at most (default ${DEFAULTS.maxRuns}, at most ${CAPS.maxRuns})` })),
          ends: opt(str({ description: `Repeating: when it stops, in words ("in 8h", "friday 17:00"; default ${DEFAULTS.days} days, at most ${CAPS.days})` })),
        }),
        executionMode: 'sequential',
        async execute(args, api) {
          const s = await sched.add({ ...args, thread: threadOf(api.conversationId) }, 'agent')
          const at = now()
          const times = upcoming(s)
          const details: ScheduleDetails = {
            id: s.id, label: s.label, said: s.said, action: s.action, next: s.next, times, how: howWords(s.when), maxRuns: s.maxRuns,
            ...('every' in s.when ? { every: s.when.every } : {}), ...(s.until ? { until: s.until } : {}), ...(s.ends !== undefined ? { ends: s.ends } : {}),
          }
          const does = s.action === 'notify' ? 'a reminder for the user' : s.action === 'both' ? 'a reminder for the user that wakes you too' : 'a wake'
          const zone = 'cron' in s.when && s.when.tz !== timezone() ? s.when.tz : timezone()
          const text = repeats(s.when)
            ? `Scheduled ${s.id} "${s.label}", ${does}: ${howWords(s.when)}, first ${localWords(s.next!, at)}; then ${times.slice(1).map(clockTime).join(', ')}. ` +
              `At most ${plural(s.maxRuns, 'run')}, until ${localWords(s.ends!, at)}${s.until ? `, or until: ${s.until}` : ''}.`
            : `Scheduled ${s.id} "${s.label}", ${does}: once, ${localWords(s.next!, at)}.`
          return { output: [{ type: 'text', text: `${text} Times are ${zone}. If that's not what was meant, cancel it and schedule again.` }], details: details as unknown as Json }
        },
      }),
      defineTool({
        name: TOOLS.list,
        description: "List this thread's schedules: each one's id, what it does, when it next runs, and how many runs it has had.",
        parameters: obj({}),
        async execute(_args, api) {
          const list = sched.list(threadOf(api.conversationId))
          const at = now()
          return { output: [{ type: 'text', text: list.length ? list.map((s) => line(s, at)).join('\n') : 'This thread has no schedules.' }], details: { count: list.filter((s) => !s.ended).length } }
        },
      }),
      defineTool({
        name: TOOLS.cancel,
        description: 'Cancel one of this thread\'s schedules, by its id: when its `until` holds, or when it\'s no longer wanted. Say why in `reason`; the user sees it.',
        parameters: obj({ id: str({ minLength: 1 }), reason: opt(str({ description: 'Why, in a few words the user sees ("CI is green")' })) }),
        executionMode: 'sequential',
        async execute({ id, reason }, api) {
          const s = own(threadOf(api.conversationId), id)
          if (s.ended) return { output: [{ type: 'text', text: `${id} "${s.label}" had ended already (${s.ended.why}).` }], details: { id, label: s.label } }
          await sched.cancel(id, { ...(reason ? { reason } : {}), who: 'agent' })
          return { output: [{ type: 'text', text: `Cancelled ${id} "${s.label}" after ${plural(s.runs, 'run')}.` }], details: { id, label: s.label, runs: s.runs, ...(reason ? { reason } : {}) } }
        },
      }),
    ],
    sections: [section('schedules', async ({ conversationId }) => {
      const thread = superego.threads.of(Number(conversationId))
      const list = thread ? sched.active(thread) : []
      if (!list.length) return undefined
      // What each one is, not where it stands (its next run, its runs, paused): that changes with every firing, and the
      // prompt is cached as long as it doesn't. schedule_list, and each wake's own words, say where it stands.
      return `This thread's schedules (times are ${timezone()}; ${TOOLS.list} says when each runs next and how it stands):\n${[...list].sort((a, b) => a.created - b.created).map(stableLine).join('\n')}`
    })],
  })
}

export default schedulesExtension()
