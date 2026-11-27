// schedules, daemon half: the machine's schedules, kept in a file of its own (`superego.dir`/schedules.json), fired by
// one timer to the soonest (re-armed on every change) and a minute's tick besides, as a timer doesn't count the time a
// machine sleeps: a run missed while it slept fires within a minute of waking, once, saying how late. Starting, the
// daemon catches up the same way. The scheduler (scheduler.ts) decides; this wires it to the daemon: threads, hooks,
// the agent's tools, actions for the window and the command line, facts for the sidebar and a live value per thread.
//
// The agent gets `schedule`, `schedule_list` and `schedule_cancel`, for its own thread's schedules only; the user's
// actions (`schedules.*`, from the window, `superego do`, another extension's `dispatch`) reach any. A firing is a
// message from Schedules (`threads.send`); what happened around it (late, stopped, paused) is a notice in the thread.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension, type DaemonApi } from '@superego/daemon'
import { RpcError, stuck, type Json, type ThreadInfo } from '@superego/protocol'
import { scheduler, upcoming, type Limits, type NewSchedule } from './scheduler.ts'
import { about, ACTIONS, CAPS, DEFAULTS, LIST_METHOD, SETTINGS, THREAD_VALUE, TOOLS, type Schedule, type ScheduleDetails } from './shared.ts'
import { clockTime, dayWord, everyWords, FORMS, localWords, timezone } from './when.ts'

/** The time, and a way to be called back: the real ones, or a test's. */
export type Clock = { now(): number; after(ms: number, run: () => void): () => void }
const REAL: Clock = { now: () => Date.now(), after(ms, run) { const timer = setTimeout(run, ms); return () => clearTimeout(timer) } }

/** How often it looks, whatever its timer says: a slept machine's missed runs fire within this of waking. */
export const TICK = 60_000

const FILE = 'schedules.json'
type Stored = { version: 1; schedules: Schedule[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A schedule as the agent reads it, in a line. */
function line(s: Schedule, now: number) {
  const when = 'every' in s.when ? everyWords(s.when.every) : 'once'
  const next = s.ended ? `ended (${s.ended.why}${s.ended.reason ? `: ${s.ended.reason}` : ''})`
    : s.paused ? 'paused' : s.pending ? 'due, waiting for this thread to be free'
    : s.next !== null ? `next ${dayWord(s.next, now)} ${clockTime(s.next)}` : ''
  const runs = 'every' in s.when ? `, run ${s.runs} of up to ${s.maxRuns}` : ''
  return `- ${s.id} "${s.label}": ${when}, ${next}${runs}${s.until ? `, until: ${s.until}` : ''}`
}

const SCHEDULE_DESCRIPTION = `Wake this thread later with a message: once ("in 30m", "tomorrow 9am") or repeating ("every 30m"). ` +
  `When it fires, you're sent the message as a new turn. Pass the user's words for the time nearly as they said them; they're read in this machine's timezone (${timezone()}), ` +
  `and the answer says what was understood, so check it. Accepted: ${FORMS}. Calendar repeats ("every weekday at 9") and cron aren't supported yet. ` +
  `A repeating one needs a way to stop: give \`until\` (a condition you check on each run, then call ${TOOLS.cancel} once it holds), ` +
  `and it stops anyway after maxRuns (default ${DEFAULTS.maxRuns}) or at \`ends\` (default ${DEFAULTS.days} days). At most every ${DEFAULTS.minIntervalMinutes} minutes. ` +
  `For "remind me …", schedule a message like "Remind the user: …" and answer it briefly when it fires.`

/** The extension, on `clock` (the real one unless a test gives its own; `id`, its schedules' ids, for a test too). */
export const schedulesExtension = ({ clock = REAL, id }: { clock?: Clock; id?: () => string } = {}) => defineDaemonExtension({
  ...about,
  async setup(superego) {
    const file = join(superego.dir, FILE)
    const value = superego.scopedValue<Json>(THREAD_VALUE, [])
    // The threads in a run, as the hooks tell it; one resumed after a restart (no turnStart) shows working.
    const running = new Set<string>()
    let stopped = false
    // What each firing sent but not yet given its message tells the agent, by thread, in the order they were sent.
    const contexts = new Map<string, string[]>()
    superego.beforeSend(({ thread, by, content }) => {
      if (by !== about.name) return undefined
      const [context, ...rest] = contexts.get(thread.id) ?? []
      if (rest.length) contexts.set(thread.id, rest)
      else contexts.delete(thread.id)
      return context === undefined ? undefined : [...content, { type: 'text', text: context }]
    })

    superego.settings.register({
      id: about.name, title: 'Schedules', description: 'Threads woken at a time, or every so often. What a repeating one may cost at most.',
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

    // Saved one at a time, through a file beside it, so a crash leaves the last whole one.
    let saving: Promise<unknown> = Promise.resolve()
    const save = (all: Schedule[]) => {
      const next = saving.then(async () => {
        await mkdir(superego.dir, { recursive: true })
        await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, schedules: all } satisfies Stored, null, 2))
        await rename(`${file}.tmp`, file)
      })
      saving = next.catch(() => undefined)
      return next
    }

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
      async wake(s, { message, context }) {
        // The words go as the message; what the agent alone needs goes with it (beforeSend, below).
        const waiting = contexts.get(s.thread) ?? []
        contexts.set(s.thread, [...waiting, context])
        try { await superego.threads.send(s.thread, message, { whenBusy: 'followUp' }) } catch (error) {
          contexts.set(s.thread, (contexts.get(s.thread) ?? []).filter((c) => c !== context))
          throw error
        }
      },
      notice: (thread, text, { agent, actions }) => superego.threads.notice(thread, { text, ...(agent ? {} : { agent: false }), ...(actions ? { actions } : {}) }),
      save,
      changed(threads) {
        for (const thread of threads) value.set(thread, sched.active(thread) as unknown as Json)
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

    // What was kept: a file that doesn't read is kept aside, and said, not dropped.
    try {
      const stored = JSON.parse(await readFile(file, 'utf8')) as Stored
      sched.load(stored.schedules ?? [])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`schedules: ${file} doesn't read; kept as ${file}.bad:`, error)
        await rename(file, `${file}.bad`).catch(failed('keeping the bad file'))
      }
    }
    for (const thread of new Set(sched.list().map((s) => s.thread))) value.set(thread, sched.active(thread) as unknown as Json)
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
    const names = () => new Set(superego.extensions().map((e) => e.name))
    const byOf = (context: { source: string; from?: string }) => context.from ? 'agent' : names().has(context.source) ? context.source : 'user'

    const NEW_PARAMS = {
      when: str({ minLength: 1, description: `When, in words: ${FORMS}` }),
      message: str({ minLength: 1, description: 'What the agent is told when it fires' }),
      label: opt(str({ maxLength: 60, description: 'A short name for the UI ("Check CI"); default: the first words of the message' })),
      until: opt(str({ description: 'Repeating: a condition the agent checks each run, cancelling it once it holds ("CI is green")' })),
      maxRuns: opt(int({ minimum: 1, maximum: CAPS.maxRuns, description: `Repeating: how many runs at most (default ${DEFAULTS.maxRuns})` })),
      ends: opt(str({ description: `Repeating: when it stops, in words ("in 8h", "friday 17:00"; default ${DEFAULTS.days} days)` })),
    }
    const ID = { id: str({ minLength: 1 }) }
    superego.action(defineAction({
      id: ACTIONS.add, title: 'Schedule a wake', expose: ['ui', 'cli'],
      description: 'Wake a thread at a time, or every so often, with a message.',
      params: obj({ thread: str({ minLength: 1 }), ...NEW_PARAMS }),
      async run(params, context) {
        await superego.threads.get(params.thread)
        return await sched.add(params as NewSchedule, byOf(context)) as unknown as Json
      },
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

    superego.agent(agentPart(superego, sched, () => clock.now()))
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
          message: str({ minLength: 1, description: "What you're told when it fires: say what to do, as a note to yourself" }),
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
            id: s.id, label: s.label, said: s.said, next: s.next, times, maxRuns: s.maxRuns,
            ...('every' in s.when ? { every: s.when.every } : {}), ...(s.until ? { until: s.until } : {}), ...(s.ends !== undefined ? { ends: s.ends } : {}),
          }
          const text = 'every' in s.when
            ? `Scheduled ${s.id} "${s.label}": ${everyWords(s.when.every)}, first ${localWords(s.next!, at)}; then ${times.slice(1).map(clockTime).join(', ')}. ` +
              `At most ${plural(s.maxRuns, 'run')}, until ${localWords(s.ends!, at)}${s.until ? `, or until: ${s.until}` : ''}.`
            : `Scheduled ${s.id} "${s.label}": once, ${localWords(s.next!, at)}.`
          return { output: [{ type: 'text', text: `${text} Times are ${timezone()}. If that's not what was meant, cancel it and schedule again.` }], details: details as unknown as Json }
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
      // Days and clock times, not "in 12m": the section changes only when they do.
      const at = now()
      return `This thread's schedules (times are ${timezone()}):\n${list.map((s) => line(s, at)).join('\n')}`
    })],
  })
}

export default schedulesExtension()
