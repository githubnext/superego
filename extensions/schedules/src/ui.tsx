// schedules, UI half: a thread's schedules where the user looks for them, and ways to make and change them.
// - a chip in the header (`schedules.chip`): a clock whose hands show the next run, and when ("in 21m", "17:01"),
//   opening to the thread's schedules, each with Run now, Pause/Resume, Edit and Cancel, and New schedule…; on a phone
//   the same list as a sheet
// - a mark on the thread's row in the sidebar: the same clock, its tooltip the next run
// - the list again in thread details (⌘I)
// - the form (Edit, New schedule…, "Schedule…" in the thread's menu and ⌘K): what it says, when (and what that comes to,
//   as it's typed), until, and what it does: wake the agent, remind you, or both
// - every schedule on the machine, by thread (⌘K "All schedules", or a view placed in the rail)
// - `/schedule in 30m check the deploy` in the composer; what it can't find a time in goes to the agent
// - a reminder's notice (a bell, the words, which schedule and run), and the agent's calls as rows
// It draws what the daemon half says (the thread's facts, the live values `schedules.thread` and `schedules.all`), so a
// machine without the extension shows none of it.
import { useEffect, useState } from 'react'
import {
  ArrowClockwiseIcon, BellIcon, Button, call, ChatCircleIcon, Chip, defineAction, defineUiExtension, Dialog, factsOf, IconButton, PauseIcon,
  PencilSimpleIcon, PlusIcon, Popover, TextArea, TextField, ThreadBadge, ThreadMenuItem, useDispatch, useMachines, useMethod, useNarrow,
  useSelection, useThreads, useValue, XIcon,
  type EntryProps, type MachineEntry, type SentBlock, type SlotProps, type Store, type ThreadInfo, type ToolRowCall, type ViewProps,
} from '@superego/app/ui'
import { SegmentedControl } from '@superego/ui'
import { ClockFace, PlayGlyph } from './clock.tsx'
import {
  about, ACTION_WORDS, ACTIONS, ALL_VALUE, readFiring, REMINDER, SCHEDULED, SPLIT_METHOD, THREAD_VALUE, TOOLS, UNDERSTAND_METHOD,
  type Action, type Facts, type Reminder, type Schedule, type ScheduleDetails, type Understood,
} from './shared.ts'
import { clockTime, dayWord, howWords, relative, repeats, shortWhen, HOUR } from './when.ts'
import './styles.css'

/** The thread whose schedules show as a sheet (a phone's, or from its menu), if any: drawn over everything, so it outlives the menu it opened from. */
type Sheet = { machine: string; thread: string } | null
/** The form, open: for a new schedule in a thread, or changing one (`id`). */
type Form = { machine: string; thread: string; id?: string } | null
/** What's open over the window: the thread's sheet, the form, every schedule. */
type Open = { sheet: Store<Sheet>; form: Store<Form>; all: Store<boolean> }

export default defineUiExtension({
  ...about,
  setup(superego) {
    const open: Open = { sheet: superego.store<Sheet>('sheet', null), form: superego.store<Form>('form', null), all: superego.store<boolean>('all', false) }
    superego.view('schedules.chip', {
      title: 'Schedules', icon: ClockIcon, context: 'thread', fits: ['header'], default: 'header',
      component: (props: ViewProps<'thread'>) => <ClockChip {...props} open={open} />, menuItem: MenuItem,
    })
    // Every schedule on the machine: a button where it's put (the rail, a phone's drawer), opening them by thread.
    superego.view('schedules.all', {
      title: 'All schedules', icon: ClockIcon, context: 'window', fits: ['rail', 'drawer'],
      component: () => <AllButton open={open} />,
    })
    superego.slot('thread.badge', Mark)
    superego.slot('thread.menu', (props: SlotProps['thread.menu']) => <ThreadItems {...props} open={open} />)
    superego.slot('details.section', (props: SlotProps['details.section']) => <Details {...props} open={open} />)
    superego.slot('overlay', () => <Overlays open={open} />)
    superego.action(defineAction({
      id: ACTIONS.new, title: 'Schedule…', description: 'A wake or a reminder for this thread, at a time or repeating',
      when: (c) => Boolean(c.selection && !c.threadOf(c.selection)?.archived),
      run: (_params, c) => { if (c.selection) open.form.set({ machine: c.selection.machine, thread: c.selection.thread }) },
    }))
    superego.action(defineAction({
      id: ACTIONS.all, title: 'All schedules', description: "Every thread's schedules on this machine",
      run: () => open.all.set(true),
    }))
    // `/schedule in 30m check the deploy`: a time found, it's scheduled; none, the agent is asked instead.
    superego.composer.command({
      name: 'schedule', detail: 'Schedule a wake or a reminder: in 30m check the deploy',
      async run(rest, { machine, thread }) {
        if (!rest) { open.form.set({ machine: machine.id, thread: thread.id }); return }
        const found = await call<{ when: string; message: string; action?: Action } | null>(machine.id, SPLIT_METHOD, { text: rest })
        if (!found) return { send: `/schedule ${rest}` }
        await superego.dispatch(ACTIONS.add, { thread: thread.id, ...found }, { machine: machine.id })
      },
    })
    superego.entry(REMINDER, ReminderNotice)
    // A firing's message: what the agent alone is told with it stays out of the bubble; under it, which schedule and run.
    superego.composer.sentWith({ read: readFirings, component: FiringChip })
    superego.tool(TOOLS.schedule, {
      icon: ClockIcon, verbs: ['Scheduled', 'Scheduling', 'Couldn’t schedule'],
      verb: (c) => scheduled(c)?.action === 'notify' || (!c.result && c.call.arguments.action === 'notify') ? (c.result?.isError ? 'Couldn’t set a reminder' : 'Reminder') : undefined,
      subject: (c) => { const label = scheduled(c)?.label ?? c.call.arguments.label; return typeof label === 'string' ? <span className="schedules-subject">{label}</span> : null },
      meta: (c) => <ScheduledMeta call={c} />,
      phrase: (k) => k === 1 ? 'scheduled something' : `scheduled ${k} things`,
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

/** What a schedule does, as an icon: a speech bubble wakes the agent, a bell reminds you. */
function ActionIcon({ action, size = 14 }: { action: Action; size?: number }) {
  const label = action === 'wake' ? 'Wakes the agent' : action === 'notify' ? 'Reminds you' : 'Reminds you and wakes the agent'
  return action === 'wake'
    ? <ChatCircleIcon className="schedules-row__icon" size={size} aria-label={label} />
    : <span className={`schedules-row__icon ${action === 'both' ? 'schedules-row__icon--both' : ''}`} role="img" aria-label={label}><BellIcon size={size} aria-hidden /></span>
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
function ClockChip({ machine, thread, open }: ViewProps<'thread'> & { open: Open }) {
  const facts = factsIn(thread)
  const now = useNow()
  const narrow = useNarrow()
  const [shown, setShown] = useState(false)
  if (!facts) return null
  const label = `Schedules: ${nextWords(facts, now)}`
  const face = (
    <button type="button" className={`schedules-chip ${facts.next === null ? 'is-paused' : ''}`} aria-label={label}
      {...(narrow ? { onClick: () => open.sheet.set({ machine: machine.id, thread: thread.id }) } : {})}>
      <ClockFace at={facts.next} size={13} aria-hidden /> {nextWords(facts, now)}
    </button>
  )
  if (narrow) return face
  /** Leave the popover for something drawn over the window. */
  const then = (go: () => void) => () => { setShown(false); go() }
  return (
    <Popover tooltip={tooltip(facts, now)} trigger={face} open={shown} onOpenChange={setShown}>
      <div className="schedules-popup">
        <div className="schedules-popup__title">Schedules</div>
        <ScheduleList machine={machine} thread={thread} onEdit={(id) => then(() => open.form.set({ machine: machine.id, thread: thread.id, id }))()} />
        <div className="schedules-popup__foot">
          <button type="button" className="schedules-popup__item" onClick={then(() => open.form.set({ machine: machine.id, thread: thread.id }))}>
            <PlusIcon size={13} aria-hidden /> New schedule…
          </button>
          <button type="button" className="schedules-popup__item schedules-popup__item--quiet" onClick={then(() => open.all.set(true))}>All schedules</button>
        </div>
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

/** In a thread's menu (its row's, a phone's sheet): Schedule…, and its schedules when it has some. */
function ThreadItems({ machine, thread, open }: SlotProps['thread.menu'] & { open: Open }) {
  if (thread.archived) return null
  const facts = factsIn(thread)
  return (
    <>
      <ThreadMenuItem icon={PlusIcon} keys={ACTIONS.new} onClick={() => open.form.set({ machine: machine.id, thread: thread.id })}>Schedule…</ThreadMenuItem>
      {facts && <ThreadMenuItem icon={ClockIcon} onClick={() => open.sheet.set({ machine: machine.id, thread: thread.id })}>Schedules</ThreadMenuItem>}
    </>
  )
}

/** What's drawn over the window when asked: a thread's schedules (a sheet), the form, every schedule. */
function Overlays({ open }: { open: Open }) {
  return <><SheetOverlay open={open} /><FormOverlay open={open} /><AllOverlay open={open} /></>
}

/** A thread's schedules as a sheet: a phone's, or from its menu. */
function SheetOverlay({ open }: { open: Open }) {
  const shown = open.sheet.use()
  const threads = useThreads(shown?.machine ?? '')
  const thread = shown && threads?.find((t) => t.id === shown.thread)
  const machine = useMachine(shown?.machine)
  if (!shown || !thread || !machine) return null
  return (
    <Dialog title="Schedules" onClose={() => open.sheet.set(null)} className="schedules-sheet">
      <ScheduleList machine={machine} thread={thread} sheet onEdit={(id) => { open.sheet.set(null); open.form.set({ machine: machine.id, thread: thread.id, id }) }} />
      <div className="schedules-sheet__new">
        <Button onClick={() => { open.sheet.set(null); open.form.set({ machine: machine.id, thread: thread.id }) }}>New schedule…</Button>
      </div>
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
function Details({ machine, thread, open }: SlotProps['details.section'] & { open: Open }) {
  if (!factsIn(thread)) return null
  return <><h5>Schedules</h5><ScheduleList machine={machine} thread={thread} sheet onEdit={(id) => open.form.set({ machine: machine.id, thread: thread.id, id })} /></>
}

/** How it repeats, said for a row: "Every 30 min", "Every weekday at 09:00". */
const howOf = (s: Schedule) => capital(howWords(s.when))

/**
 * What a schedule's row says under its name: when it runs and where it stands (`when`), its runs and who made it
 * (`more`). `sheet`: the time stands at the row's end, so the line leaves it out.
 */
export function describe(s: Schedule, thread: Pick<ThreadInfo, 'status'>, now: number, { sheet = false } = {}) {
  const how = repeats(s.when)
    ? `${howOf(s)}${s.until ? ` until ${s.until}` : ''}`
    : capital(sheet ? dayWord(onceAt(s), now) : `${dayWord(onceAt(s), now)} ${clockTime(onceAt(s))}`)
  const state = s.paused ? 'paused'
    : s.pending ? thread.status.state === 'blocked' ? 'waiting for your answer' : 'waiting for the thread'
    : repeats(s.when) && s.next !== null && !sheet ? `next ${shortWhen(s.next, now)}` : undefined
  const runs = repeats(s.when) ? s.runs ? `Run ${s.runs} of ${s.maxRuns}` : `Up to ${s.maxRuns} runs` : undefined
  const by = s.by === 'agent' ? 'made by the agent' : s.by !== 'user' ? `made by ${s.by}` : undefined
  return { when: [how, sheet && s.paused ? undefined : state].filter(Boolean).join(' · '), more: [runs, by].filter(Boolean).join(' · ') }
}
/** A one-shot's time. */
const onceAt = (s: Schedule) => 'at' in s.when ? s.when.at : s.next ?? 0
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A thread's schedules, each with its buttons: hover's icons, or (`sheet`) a row of buttons under it. */
function ScheduleList({ machine, thread, sheet = false, onEdit }: { machine: MachineEntry; thread: ThreadInfo; sheet?: boolean; onEdit(id: string): void }) {
  const list = useValue<Schedule[]>(machine, THREAD_VALUE, { scope: thread.id })
  if (list === undefined) return <div className="schedules-list__empty">Loading…</div>
  if (!list?.length) return <div className="schedules-list__empty">No schedules.</div>
  return <Rows machine={machine} list={list} thread={() => thread} sheet={sheet} onEdit={onEdit} />
}

/** Schedules as rows, with their buttons; a button that fails says why under them. */
function Rows({ machine, list, thread, sheet, onEdit }: { machine: MachineEntry; list: Schedule[]; thread(s: Schedule): Pick<ThreadInfo, 'status'>; sheet: boolean; onEdit(id: string): void }) {
  const dispatch = useDispatch()
  const now = useNow()
  const [error, setError] = useState<string>()
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
        const { when, more } = describe(s, thread(s), now, { sheet })
        const buttons = [
          { label: 'Run now', icon: <PlayGlyph size={13} />, run: () => act(s.id, ACTIONS.run) },
          s.paused
            ? { label: 'Resume', icon: <ArrowClockwiseIcon size={13} aria-hidden />, run: () => act(s.id, ACTIONS.resume) }
            : { label: 'Pause', icon: <PauseIcon size={13} aria-hidden />, run: () => act(s.id, ACTIONS.pause) },
          { label: 'Edit', icon: <PencilSimpleIcon size={13} aria-hidden />, run: () => onEdit(s.id) },
          { label: 'Cancel', icon: <XIcon size={13} aria-hidden />, run: () => act(s.id, ACTIONS.cancel) },
        ]
        return (
          <div key={s.id} className={`schedules-row ${s.paused ? 'is-paused' : ''}`}>
            <ActionIcon action={s.action} />
            <div className="schedules-row__text">
              <div className="schedules-row__head">
                <div className="schedules-row__label">{s.label}</div>
                {/* Hover's icons, on the name's line: the lines under it keep the row's width. */}
                {!sheet && <div className="schedules-row__actions">{buttons.map((b) => <IconButton key={b.label} label={b.label} variant="ghost" onClick={b.run}>{b.icon}</IconButton>)}</div>}
              </div>
              <div className="schedules-row__when">{when}</div>
              {more && <div className="schedules-row__more">{more}</div>}
              {s.error && <div className="schedules-row__error">Couldn’t send: {s.error}</div>}
            </div>
            {sheet && <div className="schedules-row__time">{s.paused ? 'Paused' : s.next !== null ? clockTime(s.next) : ''}</div>}
            {sheet && <div className="schedules-row__buttons">{buttons.map((b) => <Button key={b.label} onClick={b.run}>{b.label}</Button>)}</div>}
          </div>
        )
      })}
      {error && <div className="schedules-list__error" role="alert">{error}</div>}
    </div>
  )
}

// ── The form ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ACTION_OPTIONS = (['wake', 'notify', 'both'] as const).map((value) => ({ value, label: ACTION_WORDS[value] }))

/** `value`, once it's stayed so for `ms`: what's typed, asked about when typing pauses. */
function useSettled<T>(value: T, ms = 250) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

function FormOverlay({ open }: { open: Open }) {
  const form = open.form.use()
  const machine = useMachine(form?.machine)
  if (!form || !machine) return null
  return <ScheduleForm key={`${form.machine}/${form.thread}/${form.id ?? 'new'}`} machine={machine} thread={form.thread} id={form.id} onClose={() => open.form.set(null)} />
}

/**
 * A schedule's form: new in a thread, or one to change (`id`). Its time says what it comes to as it's typed (the
 * machine reads it, in its timezone); Save says why it can't, there.
 */
export function ScheduleForm({ machine, thread, id, onClose }: { machine: MachineEntry; thread: string; id?: string | undefined; onClose(): void }) {
  const list = useValue<Schedule[]>(machine, THREAD_VALUE, { scope: thread })
  const was = id ? list?.find((s) => s.id === id) : undefined
  const [fields, setFields] = useState<{ label: string; message: string; when: string; until: string; action: Action } | undefined>(
    id ? undefined : { label: '', message: '', when: '', until: '', action: 'wake' })
  // Changing one: its fields, once it's come.
  useEffect(() => {
    if (was && !fields) setFields({ label: was.label, message: was.message, when: was.said, until: was.until ?? '', action: was.action })
  }, [was, fields])
  const dispatch = useDispatch()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const said = useSettled(fields?.when.trim() ?? '')
  const action = fields?.action ?? 'wake'
  const understood = useMethod<Understood>(machine.id, UNDERSTAND_METHOD, { when: said, action }, { enabled: Boolean(said) })
  const now = useNow()
  if (id && list !== undefined && !was) {
    return <Dialog title="Edit schedule" onClose={onClose} size="small"><div className="schedules-form__gone">This schedule has ended or is gone.</div></Dialog>
  }
  if (!fields) return null
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })
  const repeating = understood.data?.repeats ?? (was ? repeats(was.when) : false)
  const save = async () => {
    setError(undefined)
    setSaving(true)
    try {
      const params = { when: fields.when.trim(), message: fields.message.trim(), label: fields.label.trim(), action: fields.action, ...(repeating || was?.until ? { until: fields.until.trim() } : {}) }
      if (was) await dispatch(ACTIONS.update, { id: was.id, ...params }, { machine: machine.id })
      else await dispatch(ACTIONS.add, { thread, ...params, ...(params.until ? {} : { until: undefined }) }, { machine: machine.id })
      onClose()
    } catch (e) {
      console.error('schedules: saving failed:', e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  const hint = !said ? '' : understood.error ? understood.error.message
    : understood.data ? `${understood.data.repeats ? `${capital(understood.data.how)}: ` : ''}${understood.data.times.map((t) => `${dayWord(t, now)} ${clockTime(t)}`).join(', ')}${understood.data.tz !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` (${understood.data.tz})` : ''}`
    : '…'
  const footer = (
    <>
      {was && <span className="schedules-form__by">{[was.by === 'agent' ? 'Made by the agent' : was.by !== 'user' ? `Made by ${was.by}` : '', repeats(was.when) ? was.runs ? `run ${was.runs} of ${was.maxRuns}` : `up to ${was.maxRuns} runs` : ''].filter(Boolean).join(' · ')}</span>}
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={saving || !fields.message.trim() || !fields.when.trim()} onClick={() => void save()}>{was ? 'Save' : 'Schedule'}</Button>
    </>
  )
  return (
    <Dialog title={was ? 'Edit schedule' : 'New schedule'} onClose={onClose} size="small" footer={footer} unsaved className="schedules-form-dialog">
      <form className="schedules-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label htmlFor="schedules-message">Says</label>
        <TextArea id="schedules-message" className="superego-field schedules-form__says" value={fields.message} maxRows={6} placeholder={action === 'notify' ? "Review Mia's PR" : 'Check CI on #212, and say what still fails'}
          onChange={(e) => set({ message: e.target.value })} />
        <label htmlFor="schedules-when">When</label>
        <div className="schedules-form__when">
          <TextField id="schedules-when" value={fields.when} placeholder="in 30m, tomorrow 9:00, every weekday at 9" onChange={(e) => set({ when: e.target.value })} />
          <div className={`schedules-form__hint ${understood.error && said ? 'is-error' : ''}`} aria-live="polite">{hint}</div>
        </div>
        {(repeating || fields.until) && <>
          <label htmlFor="schedules-until">Until</label>
          <TextField id="schedules-until" value={fields.until} placeholder="CI is green (the agent checks each run)" onChange={(e) => set({ until: e.target.value })} />
        </>}
        <label>Then</label>
        <SegmentedControl label="What it does" options={ACTION_OPTIONS} value={fields.action} onChange={(next) => set({ action: next })} />
        <label htmlFor="schedules-label">Name</label>
        <TextField id="schedules-label" value={fields.label} maxLength={60} placeholder="The first words of what it says" onChange={(e) => set({ label: e.target.value })} />
        <button type="submit" hidden />
      </form>
      {error && <div className="schedules-form__error" role="alert">{error}</div>}
    </Dialog>
  )
}

// ── Every schedule ───────────────────────────────────────────────────────────────────────────────────────────────

/** In the rail (where it's put): the clock, and how many schedules the machines have; opening them all. */
function AllButton({ open }: { open: Open }) {
  return (
    <IconButton label="All schedules" variant="ghost" className="schedules-all-button" onClick={() => open.all.set(true)}>
      <ClockIcon size={16} />
    </IconButton>
  )
}

function AllOverlay({ open }: { open: Open }) {
  const shown = open.all.use()
  const machines = useMachines().filter((m) => m.state === 'connected')
  if (!shown) return null
  const edit = (machine: string, thread: string, id: string) => { open.all.set(false); open.form.set({ machine, thread, id }) }
  return (
    <Dialog title="All schedules" onClose={() => open.all.set(false)} className="schedules-all">
      {machines.map((m) => <MachineSchedules key={m.id} machine={m} named={machines.length > 1} onEdit={edit} onGo={() => open.all.set(false)} />)}
    </Dialog>
  )
}

/** A machine's schedules, by thread, soonest first: each thread's name goes to it. */
export function MachineSchedules({ machine, named, onEdit, onGo }: { machine: MachineEntry; named: boolean; onEdit(machine: string, thread: string, id: string): void; onGo(): void }) {
  const list = useValue<Schedule[]>(machine, ALL_VALUE)
  const threads = useThreads(machine.id)
  const { select } = useSelection()
  if (list === undefined && !named) return <div className="schedules-list__empty">Loading…</div>
  if (!list?.length) return named ? null : <div className="schedules-list__empty">No schedules on this machine.</div>
  const byThread = new Map<string, Schedule[]>()
  for (const s of list) byThread.set(s.thread, [...byThread.get(s.thread) ?? [], s])
  return (
    <section className="schedules-machine">
      {named && <h4 className="schedules-machine__name">{machine.label}</h4>}
      {[...byThread].map(([id, schedules]) => {
        const thread = threads?.find((t) => t.id === id)
        return (
          <div key={id} className="schedules-thread">
            <button type="button" className="schedules-thread__title" onClick={() => { select({ machine: machine.id, thread: id }); onGo() }}>
              {thread?.title ?? (schedules[0]!.held !== undefined ? 'An archived thread' : id)}
            </button>
            <Rows machine={machine} list={schedules} thread={() => thread ?? { status: { state: 'idle' } }} sheet={false} onEdit={(sid) => onEdit(machine.id, id, sid)} />
          </div>
        )
      })}
    </section>
  )
}

// ── In the transcript ────────────────────────────────────────────────────────────────────────────────────────────

/** Under a reminder's words: its name (when its own), how it repeats and its run, how late. */
export const reminderCaption = (r: Reminder) => [
  !r.message.startsWith(r.label) && r.label,
  r.how && `${r.how}, run ${r.run}${r.maxRuns ? ` of ${r.maxRuns}` : ''}`,
  r.late !== undefined && `due ${clockTime(r.late)}, late`,
].filter(Boolean).join(' · ')

/** A reminder's notice: the bell and what it says, then which schedule, its run, and how late. */
function ReminderNotice({ entry }: EntryProps) {
  const r = entry.data as Reminder | undefined
  if (!r) return null
  const caption = reminderCaption(r)
  return (
    <div className="schedules-reminder">
      <BellIcon size={15} aria-hidden className="schedules-reminder__bell" />
      <div>
        <div className="schedules-reminder__text">{r.message}</div>
        {caption && <div className="schedules-reminder__caption">{caption}</div>}
      </div>
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
  const repeating = details.how !== 'once'
  const how = [repeating && (details.how ?? ''), details.until && `until ${details.until}`].filter(Boolean).join(' ')
  return (
    <span className="schedules-times">
      {how && <span>{how}</span>}
      {details.times.map((at) => <span key={at} className="schedules-times__time">{shortWhen(at, now)}</span>)}
      {repeating && <span>at most {details.maxRuns}</span>}
    </span>
  )
}
