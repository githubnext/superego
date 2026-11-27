// schedules, UI half: a thread's schedules where the user looks for them.
// - a chip in the header (`schedules.chip`): a clock whose hands show the next run, and when ("in 21m", "17:01"),
//   opening to the thread's schedules, each with Run now, Pause/Resume and Cancel; on a phone the same list as a sheet
// - a mark on the thread's row in the sidebar: the same clock, its tooltip the next run
// - the list again in thread details (⌘I)
// - the agent's calls as rows: what it scheduled with its next times, what it listed, what it cancelled
// It draws what the daemon half says (the thread's facts, the live value `schedules.thread`), so a machine without the
// extension shows none of it. A firing is a message from Schedules, and what happened around it a notice: the
// transcript draws both.
import { useEffect, useState } from 'react'
import {
  ArrowClockwiseIcon, Button, ChatCircleIcon, Chip, defineUiExtension, Dialog, factsOf, IconButton, PauseIcon, Popover, ThreadBadge, useDispatch, useMachines,
  useNarrow, useThreads, useValue, XIcon,
  type MachineEntry, type SentBlock, type SlotProps, type Store, type ThreadInfo, type ToolRowCall, type ViewProps,
} from '@superego/app/ui'
import { ClockFace, PlayGlyph } from './clock.tsx'
import { about, ACTIONS, readFiring, SCHEDULED, THREAD_VALUE, TOOLS, type Facts, type Schedule, type ScheduleDetails } from './shared.ts'
import { clockTime, dayWord, everyWords, relative, shortWhen, HOUR } from './when.ts'
import './styles.css'

/** The thread whose schedules show as a sheet (a phone's), if any: drawn over everything, so it outlives the menu it opened from. */
type Sheet = { machine: string; thread: string } | null

export default defineUiExtension({
  ...about,
  setup(superego) {
    const sheet = superego.store<Sheet>('sheet', null)
    superego.view('schedules.chip', {
      title: 'Schedules', icon: ClockIcon, context: 'thread', fits: ['header'], default: 'header',
      component: (props: ViewProps<'thread'>) => <ClockChip {...props} sheet={sheet} />, menuItem: MenuItem,
    })
    superego.slot('thread.badge', Mark)
    superego.slot('details.section', Details)
    superego.slot('overlay', () => <SheetOverlay sheet={sheet} />)
    // A firing's message: what the agent alone is told with it stays out of the bubble; under it, which schedule and run.
    superego.composer.sentWith({ read: readFirings, component: FiringChip })
    superego.tool(TOOLS.schedule, {
      icon: ClockIcon, verbs: ['Scheduled', 'Scheduling', 'Couldn’t schedule'],
      subject: (c) => { const label = scheduled(c)?.label ?? c.call.arguments.label; return typeof label === 'string' ? <span className="schedules-subject">{label}</span> : null },
      meta: (c) => <ScheduledMeta call={c} />,
      phrase: (k) => k === 1 ? 'scheduled a wake' : `scheduled ${k} wakes`,
    }, { fold: false })
    superego.tool(TOOLS.list, { icon: ClockIcon, verbs: ['Listed schedules', 'Listing schedules', 'Couldn’t list schedules'], subject: () => null, phrase: () => 'listed schedules' })
    superego.tool(TOOLS.cancel, {
      icon: ClockIcon, verbs: ['Cancelled', 'Cancelling', 'Couldn’t cancel'],
      subject: (c) => { const label = (c.result?.details as { label?: string } | undefined)?.label; return label ? <span className="schedules-subject">{label}</span> : typeof c.call.arguments.id === 'string' ? c.call.arguments.id : null },
      meta: (c) => typeof c.call.arguments.reason === 'string' ? c.call.arguments.reason : undefined,
      phrase: (k) => k === 1 ? 'cancelled a schedule' : `cancelled ${k} schedules`,
    }, { fold: false })
  },
})

/** The clock at rest, for where an icon goes (the view's, a row's). */
function ClockIcon({ size = 14, className }: { size?: number; className?: string }) {
  return <ClockFace size={size} aria-hidden {...(className ? { className } : {})} />
}

/** The time now, again every `ms`: for "in 21m" to count down. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

const factsIn = (thread: ThreadInfo) => factsOf<Facts>(thread, about)

/** When the next run is, short: "in 21m" within the hour, else "17:01" or "tomorrow 09:00"; "paused" when none is. */
export function nextWords(facts: Facts, now: number) {
  if (facts.next === null) return 'paused'
  if (facts.next <= now) return facts.pending ? 'waiting' : 'now'
  return facts.next - now < HOUR ? relative(facts.next, now) : shortWhen(facts.next, now)
}

const tooltip = (facts: Facts, now: number) => facts.next === null
  ? `${facts.count === 1 ? 'A schedule' : `${facts.count} schedules`}, paused`
  : `${facts.label} at ${shortWhen(facts.next, now)}${facts.count > 1 ? ` · ${facts.count} schedules` : ''}`

/** In the header: the clock at the next run, and when; opening to the thread's schedules. */
function ClockChip({ machine, thread, sheet }: ViewProps<'thread'> & { sheet: Store<Sheet> }) {
  const facts = factsIn(thread)
  const now = useNow()
  const narrow = useNarrow()
  if (!facts) return null
  const label = `Schedules: ${nextWords(facts, now)}`
  const face = (
    <button type="button" className={`schedules-chip ${facts.next === null ? 'is-paused' : ''}`} aria-label={label}
      {...(narrow ? { onClick: () => sheet.set({ machine: machine.id, thread: thread.id }) } : {})}>
      <ClockFace at={facts.next} size={13} aria-hidden /> {nextWords(facts, now)}
    </button>
  )
  if (narrow) return face
  return (
    <Popover tooltip={tooltip(facts, now)} trigger={face}>
      <div className="schedules-popup">
        <div className="schedules-popup__title">Schedules</div>
        <ScheduleList machine={machine} thread={thread} />
      </div>
    </Popover>
  )
}

/** The chip's row in the title bar's ··· menu and a phone's thread sheet. */
function MenuItem({ thread }: ViewProps<'thread'>) {
  const facts = factsIn(thread)
  const now = useNow()
  return <>Schedules: {facts ? nextWords(facts, now) : 'none'}</>
}

/** On a phone: the thread's schedules as a sheet. */
function SheetOverlay({ sheet }: { sheet: Store<Sheet> }) {
  const open = sheet.use()
  const threads = useThreads(open?.machine ?? '')
  const thread = open && threads?.find((t) => t.id === open.thread)
  const machine = useMachine(open?.machine)
  if (!open || !thread || !machine) return null
  return (
    <Dialog title="Schedules" onClose={() => sheet.set(null)} className="schedules-sheet">
      <ScheduleList machine={machine} thread={thread} sheet />
    </Dialog>
  )
}

/** A machine by id, as the window knows it. */
function useMachine(id: string | undefined): MachineEntry | undefined {
  const all = useMachines()
  return id ? all.find((m) => m.id === id) : undefined
}

/** In the sidebar: the clock at the next run, its tooltip what and when. */
function Mark({ thread }: SlotProps['thread.badge']) {
  const facts = factsIn(thread)
  const now = useNow(60_000)
  if (!facts) return null
  return <ThreadBadge label="Scheduled" title={tooltip(facts, now)}><ClockFace at={facts.next} size={12} aria-hidden /></ThreadBadge>
}

/** In thread details (⌘I): the same list. */
function Details({ machine, thread }: SlotProps['details.section']) {
  if (!factsIn(thread)) return null
  return <><h5>Schedules</h5><ScheduleList machine={machine} thread={thread} sheet /></>
}

/**
 * What a schedule's row says under its name: when it runs and where it stands (`when`), its runs and who made it
 * (`more`). `sheet`: the time stands at the row's end, so the line leaves it out.
 */
export function describe(s: Schedule, thread: ThreadInfo, now: number, { sheet = false } = {}) {
  const how = 'every' in s.when
    ? `${capital(everyWords(s.when.every))}${s.until ? ` until ${s.until}` : ''}`
    : capital(sheet ? dayWord(s.when.at, now) : `${dayWord(s.when.at, now)} ${clockTime(s.when.at)}`)
  const state = s.paused ? 'paused'
    : s.pending ? thread.status.state === 'blocked' ? 'waiting for your answer' : 'waiting for the thread'
    : 'every' in s.when && s.next !== null && !sheet ? `next ${shortWhen(s.next, now)}` : undefined
  const runs = 'every' in s.when ? s.runs ? `Run ${s.runs} of ${s.maxRuns}` : `Up to ${s.maxRuns} runs` : undefined
  const by = s.by === 'agent' ? 'made by the agent' : s.by !== 'user' ? `made by ${s.by}` : undefined
  return { when: [how, sheet && s.paused ? undefined : state].filter(Boolean).join(' · '), more: [runs, by].filter(Boolean).join(' · ') }
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A thread's schedules, each with its buttons: hover's icons, or (`sheet`) a row of buttons under it. */
function ScheduleList({ machine, thread, sheet = false }: { machine: MachineEntry; thread: ThreadInfo; sheet?: boolean }) {
  const list = useValue<Schedule[]>(machine, THREAD_VALUE, { scope: thread.id })
  const dispatch = useDispatch()
  const now = useNow()
  const [error, setError] = useState<string>()
  if (list === undefined) return <div className="schedules-list__empty">Loading…</div>
  if (!list?.length) return <div className="schedules-list__empty">No schedules.</div>
  const act = (id: string, action: string) => {
    setError(undefined)
    dispatch(action, { id }, { machine: machine.id }).catch((e: unknown) => {
      console.error(`schedules: ${action} failed:`, e)
      setError(e instanceof Error ? e.message : String(e))
    })
  }
  return (
    <div className={`schedules-list ${sheet ? 'schedules-list--sheet' : ''}`}>
      {list.map((s) => {
        const { when, more } = describe(s, thread, now, { sheet })
        const buttons = [
          { label: 'Run now', icon: <PlayGlyph size={13} />, run: () => act(s.id, ACTIONS.run) },
          s.paused
            ? { label: 'Resume', icon: <ArrowClockwiseIcon size={13} aria-hidden />, run: () => act(s.id, ACTIONS.resume) }
            : { label: 'Pause', icon: <PauseIcon size={13} aria-hidden />, run: () => act(s.id, ACTIONS.pause) },
          { label: 'Cancel', icon: <XIcon size={13} aria-hidden />, run: () => act(s.id, ACTIONS.cancel) },
        ]
        return (
          <div key={s.id} className={`schedules-row ${s.paused ? 'is-paused' : ''}`}>
            <ChatCircleIcon className="schedules-row__icon" size={14} aria-label="Wakes the agent" />
            <div className="schedules-row__text">
              <div className="schedules-row__label">{s.label}</div>
              <div className="schedules-row__when">{when}</div>
              {more && <div className="schedules-row__more">{more}</div>}
              {s.error && <div className="schedules-row__error">Couldn’t send: {s.error}</div>}
            </div>
            {sheet && <div className="schedules-row__time">{s.paused ? 'Paused' : s.next !== null ? clockTime(s.next) : ''}</div>}
            {sheet
              ? <div className="schedules-row__buttons">{buttons.map((b) => <Button key={b.label} onClick={b.run}>{b.label}</Button>)}</div>
              : <div className="schedules-row__actions">{buttons.map((b) => <IconButton key={b.label} label={b.label} variant="ghost" onClick={b.run}>{b.icon}</IconButton>)}</div>}
          </div>
        )
      })}
      {error && <div className="schedules-list__error" role="alert">{error}</div>}
    </div>
  )
}

type Firing = NonNullable<ReturnType<typeof readFiring>>

/** The block a firing's message carries for the agent (`⏰ Scheduled: …`), read. */
export function readFirings(blocks: readonly SentBlock[]) {
  const at = blocks.findIndex((b) => b.type === 'text' && b.text?.startsWith(SCHEDULED))
  const firing = at >= 0 ? readFiring(blocks[at]!.text!) : undefined
  return firing ? { items: [firing], blocks: [at] } : undefined
}

/** Under a firing's message: the clock, the schedule's name and its run ("Check CI · run 4 of up to 48 · late"). */
function FiringChip({ items }: { items: Firing[] }) {
  return items.map((f, i) => (
    <Chip key={i} icon={<ClockIcon size={13} />} title={f.late ? 'Sent late: Superego wasn’t running or the machine was asleep when it was due' : undefined}>
      {[f.label, f.what, f.late && 'late'].filter(Boolean).join(' · ')}
    </Chip>
  ))
}

/** A `schedule` call's details, once it answered. */
const scheduled = (c: ToolRowCall) => c.result?.details as ScheduleDetails | undefined

/** After what was scheduled: how often, and its next times (the agent's words while it's being made). */
function ScheduledMeta({ call }: { call: ToolRowCall }) {
  const details = scheduled(call)
  if (!details) return <>{typeof call.call.arguments.when === 'string' ? call.call.arguments.when : null}</>
  const now = Date.now()
  const how = [details.every !== undefined && everyWords(details.every), details.until && `until ${details.until}`].filter(Boolean).join(' ')
  return (
    <span className="schedules-times">
      {how && <span>{how}</span>}
      {details.times.map((at) => <span key={at} className="schedules-times__time">{shortWhen(at, now)}</span>)}
      {details.every !== undefined && <span>at most {details.maxRuns}</span>}
    </span>
  )
}
