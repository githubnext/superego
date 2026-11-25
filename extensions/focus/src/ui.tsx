// focus, UI half: a few threads to focus on, and a mode that narrows the sidebar to them (focus.ts). A thread goes in
// and out of focus from its row's menu (or, on a phone, its sheet) and ⌘⌥F for the one shown; while the mode is off, a
// faint ◎ after its title says it's in focus. The mode: the ◎ in the sidebar's heading (its menu: Focus mode, or for an
// hour, the minutes left beside it and its ring draining), or ⌘⇧F. On, the list is the threads in focus under their projects,
// with every thread that needs you, and a quiet "Show N more" at its end that turns it off. The set and the mode are
// app settings: the same in every window.
import { useEffect, useMemo, useState } from 'react'
import {
  defineAction, defineUiExtension, has, ThreadBadge, ThreadMenuItem, useAllThreads, useAppSetting, useDispatch, useMachines, useNarrow, useShortcut,
  type MachineEntry, type SidebarFilter, type ThreadInfo, type WindowContext,
} from '@superego/app/ui'
import { obj, opt, str } from '@superego/protocol'
import { IconButton, Menu } from '@superego/ui'
import { focusedOf, isFocused, joined, minutesLeft, shows, stillListed, toggle } from './focus.ts'
import { about, FOCUSED, HOUR, MODE, ON, THREAD, UNTIL, type Focused } from './shared.ts'
import './styles.css'

/** How long "Focus for 1 hour" lasts. */
export const AN_HOUR = 60 * 60_000

const setting = (dispatch: WindowContext['dispatch'], key: string, value: unknown) =>
  dispatch('app.settings.set', { key, value }, { machine: 'app', source: 'focus' })

/** Whether focus is there to use: a machine reached has it, not switched off. */
const available = (machines: readonly MachineEntry[]) => machines.some((m) => m.state === 'connected' && has(m, `ext:${about.name}`))

export default defineUiExtension({
  ...about,
  setup(superego) {
    const set = (key: string, value: unknown) => setting(superego.dispatch, key, value)
    const now = () => focusedOf(superego.appSetting(FOCUSED))
    const mode = async (on: boolean, until?: number) => {
      await set(UNTIL, until ?? 0)
      await set(ON, on)
    }
    // Changed from the sidebar, a thread's menu and the keys, not in Settings.
    superego.appSettings({
      id: 'focus', title: 'Focus', order: 62,
      settings: [
        { key: FOCUSED, title: 'Threads in focus', default: [], type: 'pins', hidden: true },
        { key: ON, title: 'Focus mode', default: false, type: 'boolean', hidden: true },
        { key: UNTIL, title: 'Focus mode ends at', default: 0, type: 'number', min: 0, hidden: true },
      ],
    })
    superego.sidebarFilter(useFocusMode)
    superego.slot('sidebar.heading', FocusButton)
    superego.slot('thread.menu', FocusItem)
    superego.slot('thread.badge', FocusMark)
    superego.action(defineAction({
      id: MODE, title: 'Focus mode', keys: 'mod+shift+f', when: (c) => available(c.machines),
      run: (_params, c) => mode(c.appSetting<boolean>(ON) !== true).then(() => null),
    }))
    superego.action(defineAction({
      id: HOUR, title: 'Focus for 1 hour', when: (c) => available(c.machines),
      run: () => mode(true, Date.now() + AN_HOUR).then(() => null),
    }))
    superego.action(defineAction({
      id: THREAD, title: 'Focus or unfocus thread', keys: 'mod+alt+f', params: obj({ machine: opt(str()), thread: opt(str()) }),
      when: (c) => Boolean(c.selection && c.threadOf(c.selection)),
      run: ({ machine, thread }, c) => {
        const at = machine && thread ? { machine, thread } : c.selection
        const info = at && c.threadOf(at)
        if (!at || !info || info.archived || info.hidden) throw new Error('Only a thread the sidebar lists can be focused')
        return set(FOCUSED, toggle(now(), at, superego.window.threads)).then(() => null)
      },
    }))
    // A thread a focused one starts joins the set. The threads a machine lists as the window first hears it are
    // where they stand (those a focused thread started then were focused with it); only one new after joins. Joined
    // all at once, so that several new together (a thread and one it starts) are each written.
    const heard = new Set<string>()
    let joining: { machine: string; thread: ThreadInfo }[] = []
    superego.on('thread.status', ({ machine, thread, before }) => {
      if (before !== undefined) return
      if (!heard.has(machine)) { queueMicrotask(() => heard.add(machine)); return }
      if (!thread.parent) return
      if (!joining.length) queueMicrotask(join)
      joining.push({ machine, thread })
    })
    function join() {
      const news = joining
      joining = []
      let list = now()
      for (let grew = true; grew;) {
        grew = false
        for (const { machine, thread } of news) {
          const next = joined(list, machine, thread)
          if (next) { list = next; grew = true }
        }
      }
      if (list.length > now().length) void set(FOCUSED, list).catch((error) => console.error('Focusing a new sub-thread', error))
    }
  },
})

/**
 * The narrowing while focus mode is on (`superego.sidebarFilter`), drawn for as long as the extension is set up: it
 * also lets threads that are archived go from the set, and ends a timed mode when its hour is up.
 */
function useFocusMode(): SidebarFilter | undefined {
  const [on] = useAppSetting<boolean>(ON)
  const [until] = useAppSetting<number>(UNTIL)
  const [value, setValue] = useAppSetting<Focused[]>(FOCUSED)
  const machines = useMachines()
  const threads = useAllThreads()
  const dispatch = useDispatch()
  const set = useMemo(() => focusedOf(value), [value])
  useEffect(() => {
    const kept = stillListed(set, machines, threads)
    if (kept.length < set.length) void setValue(kept).catch((error) => console.error('Letting archived threads leave focus', error))
  }, [set, machines, threads])
  useEffect(() => {
    if (on !== true || !until) return
    const end = () => void Promise.all([setting(dispatch, ON, false), setting(dispatch, UNTIL, 0)]).catch((error) => console.error('Ending focus mode', error))
    const left = until - Date.now()
    if (left <= 0) return end()
    const timer = setTimeout(end, left)
    return () => clearTimeout(timer)
  }, [on, until])
  const there = available(machines)
  return useMemo(() => on === true && there ? { title: 'Focus', shows: (thread, machine) => shows(set, machine, thread), footer: FocusFooter } : undefined, [on, there, set])
}

/** The end of the list in focus mode: what's hidden, a click from showing everything again; nothing in focus, how to. */
function FocusFooter({ hidden }: { hidden: number; shown: number }) {
  const [value] = useAppSetting<Focused[]>(FOCUSED)
  const dispatch = useDispatch()
  const narrow = useNarrow()
  const empty = focusedOf(value).length === 0
  return (
    <>
      {empty && <div className="focus-empty">Nothing in focus. {narrow ? 'Choose Focus in a thread’s menu.' : 'Right-click a thread and choose Focus.'}</div>}
      {hidden > 0 && (
        <button type="button" className="focus-more" onClick={() => void dispatch(MODE, {}, { source: 'focus' }).catch((error) => console.error(error))}>
          Show {hidden} more
        </button>
      )}
    </>
  )
}

/**
 * In the sidebar's heading: ◎, lit while focus mode is on (a click turns it off); off, its menu turns it on, or on for
 * an hour. Timed, the minutes left are beside it and its ring drains as the hour goes.
 */
function FocusButton() {
  const [on] = useAppSetting<boolean>(ON)
  const [until] = useAppSetting<number>(UNTIL)
  const dispatch = useDispatch()
  const keys = useShortcut(MODE)
  const time = useNow(on === true && Boolean(until))
  if (!available(useMachines())) return null
  const run = (id: string) => () => void dispatch(id, {}, { source: 'focus' }).catch((error) => console.error(error))
  if (on === true) {
    const label = until ? `Focus mode: ${minutesLeft(until, time)} min left` : `Turn off focus mode${keys ? ` (${keys})` : ''}`
    return (
      <>
        {until ? <span className="focus-left">{minutesLeft(until, time)} min</span> : null}
        <IconButton label={label} className="focus-button is-on" aria-pressed onClick={run(MODE)}>
          <FocusGlyph size={14} {...(until ? { left: Math.max(0, Math.min(1, (until - time) / AN_HOUR)) } : {})} />
        </IconButton>
      </>
    )
  }
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Focus mode" className="focus-button" />}><FocusGlyph size={14} /></Menu.Trigger>
      <Menu.Popup className="focus-menu">
        <Menu.Item onClick={run(MODE)} hint={keys}>Focus mode</Menu.Item>
        <Menu.Item onClick={run(HOUR)}>Focus for 1 hour</Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  )
}

/** The time now, again every half minute while `ticking`. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/** In a thread's row menu (or a phone's sheet): Focus, or Unfocus. */
function FocusItem({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const [value] = useAppSetting<Focused[]>(FOCUSED)
  const dispatch = useDispatch()
  if (thread.archived || thread.hidden) return null
  const on = isFocused(focusedOf(value), { machine: machine.id, thread: thread.id })
  return (
    <ThreadMenuItem icon={FocusGlyph} keys={THREAD}
      onClick={() => void dispatch(THREAD, { machine: machine.id, thread: thread.id }, { source: 'focus' }).catch((error) => console.error(error))}>
      {on ? 'Unfocus' : 'Focus'}
    </ThreadMenuItem>
  )
}

/** After a focused thread's title, while focus mode is off: a faint ◎. */
function FocusMark({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const [on] = useAppSetting<boolean>(ON)
  const [value] = useAppSetting<Focused[]>(FOCUSED)
  if (on === true || !isFocused(focusedOf(value), { machine: machine.id, thread: thread.id })) return null
  return <ThreadBadge label="In focus"><FocusGlyph size={10} /></ThreadBadge>
}

/**
 * ◎: a ring and its centre. `left` (0 to 1), the ring drawn only that far round, from the top, over a faint whole one:
 * how much of a timed focus is left.
 */
export function FocusGlyph({ size = 14, left }: { size?: number; left?: number; 'aria-hidden'?: boolean }) {
  const r = 5.3
  const round = 2 * Math.PI * r
  return (
    <svg className="focus-glyph" width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={size <= 10 ? 1.8 : 1.4} aria-hidden>
      {left === undefined
        ? <circle cx="7" cy="7" r={r} />
        : <>
          <circle cx="7" cy="7" r={r} opacity={0.3} />
          <circle cx="7" cy="7" r={r} strokeDasharray={`${round * left} ${round}`} strokeLinecap="round" transform="rotate(-90 7 7)" />
        </>}
      <circle cx="7" cy="7" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  )
}
