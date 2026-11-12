// The shell every app gets: the sidebar slot (or, with nothing there, a compact thread picker), the selected thread,
// the restart notice, Settings, and the app-wide reactions (fonts, ⌘, , threads shown from the command line or a
// notification, marking finished threads seen).
import { useEffect, useRef, useState } from 'react'
import { agentName } from '@superego/protocol'
import { Button, LifebuoyIcon, GearSixIcon, IconButton, ListIcon, NotePencilIcon, PlusIcon, Select } from '@superego/ui'
import { textScale } from '../shared.ts'
import { UnreadButton } from './Unread.tsx'
import { machine as client, useAppSetting, useSettings } from './client.ts'
import { Slot, useRegistry } from './extension.tsx'
import { ServiceNotice } from './ServiceNotice.tsx'
import { ThreadTitle, ThreadTools, ThreadView } from './ThreadView.tsx'
import { SettingsView } from './SettingsView.tsx'
import { Palette } from './Palette.tsx'
import { Navigator } from './Navigator.tsx'
import { ActionLog, runsBare } from './actions.tsx'
import { NewThreadDialog } from './NewThread.tsx'
import { bound, KEYMAP, shortcutOf, useActions, type Keymap } from './keys.ts'
import { useAllThreads, useMachines, useNewThreadDialog, useSelection, useSessions, useSettingsDialog, useShell, useSidebar, type Selection } from './state.tsx'

/** Dispatch an action from this window: `dispatch('threads.rail')`, `dispatch('thread.select', { machine, thread })`. */
export function useDispatch() {
  return useRegistry().router.dispatch
}

/** Whether the window is phone-narrow. */
function useNarrow() {
  const query = '(max-width: 599px)'
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const list = matchMedia(query)
    const change = () => setNarrow(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [])
  return narrow
}

/** App setting: whether ⌘. looks for the next unread thread everywhere, or only in the session you're in. */
export const UNREAD = 'app.unread'

export function Shell() {
  const registry = useRegistry()
  const [palette, setPalette] = useState(false)
  const [navigator, setNavigator] = useState(false)
  const sidebar = useSidebar()
  const { sessions, lastThread } = useSessions()
  const [unreadScope] = useAppSetting<'all' | 'session'>(UNREAD)
  const [log, setLog] = useState(false)
  const machines = useMachines()
  const { selection, select, machine, thread } = useSelection()
  const settings = useSettingsDialog()
  const newThread = useNewThreadDialog()
  const { openSettings } = useShell()
  const hasSidebar = registry.slots.sidebar.length > 0
  const allThreads = useAllThreads()
  const { newThread: openNewThread } = useShell()
  // A phone (or a narrow window): the sidebar becomes a drawer over the thread, opened from a bar at the top.
  const narrow = useNarrow()
  const [drawer, setDrawer] = useState(false)
  useEffect(() => { setDrawer(false) }, [selection?.machine, selection?.thread, narrow])
  // Actions read the shell as it is when they run.
  registry.router.setContext({
    app: registry.app, machines, selection, select, openSettings, newThread: openNewThread,
    togglePalette: () => { setNavigator(false); setPalette((open) => !open) },
    toggleNavigator: () => { setPalette(false); setNavigator((open) => !open) },
    showLog: () => setLog(true),
    threadOf: (s) => allThreads[s.machine]?.find((x) => x.id === s.thread),
    sessions, lastThread, unreadScope: unreadScope ?? 'all',
    toggleSidebar: () => narrow ? setDrawer((open) => !open) : sidebar.toggle(),
  })
  useAppEffects()

  // Looking at a finished or failed thread marks it seen.
  useEffect(() => {
    if (!selection || !thread || (thread.status.state !== 'done' && thread.status.state !== 'error') || !document.hasFocus()) return
    void registry.router.dispatch('thread.seen', { id: selection.thread }, { machine: selection.machine, source: 'auto' }).catch(() => {})
  }, [selection?.machine, selection?.thread, thread?.status.state])


  const settingsButton = (
    <IconButton label="Settings" className="app__settings" onClick={openSettings}>
      <GearSixIcon size={18} aria-hidden />
    </IconButton>
  )
  const dispatch = registry.router.dispatch
  // Without a sidebar, at the title bar's start: every thread in a menu, and a new one.
  const tools = (
    <span className="app__tools">
      <ThreadPicker />
      <IconButton label="New thread (⌘N)" className="app__new" onClick={() => openNewThread()}>
        <NotePencilIcon size={15} aria-hidden />
      </IconButton>
    </span>
  )
  const sideOpen = hasSidebar && (narrow ? drawer : sidebar.open)
  const hasRail = registry.slots.rail.length > 0
  // Wide: the window's own colour around a sheet. Across the top a title bar (the window's buttons, then where you are
  // and what the thread says about itself); down the left a rail (Ego, the spaces, Settings) and the sidebar beside it;
  // the sheet holds the thread and its panes. Narrow: one column under a bar of its own, the sidebar a drawer.
  return (
    <div className={`app ${sideOpen ? 'has-sidebar' : ''} ${narrow ? 'is-narrow' : ''} ${drawer ? 'has-drawer' : ''} ${window.superego.web ? 'is-web' : ''}`}>
      {narrow && hasSidebar && drawer && <div className="app__scrim" onClick={() => setDrawer(false)} />}
      {!narrow && (
        <header className="app__drag app__titlebar">
          {!hasSidebar && tools}
          {selection && thread && machine && <ThreadTitle machine={machine} thread={thread} />}
          <span className="app__titlebar-end">
            {!hasSidebar && <ServiceNotice />}
            {selection && thread && machine && <ThreadTools machine={machine} thread={thread} />}
          </span>
        </header>
      )}
      <div className="app__body">
        {!narrow && (
          <nav className="app__rail" aria-label="App">
            <div className="app__rail-group">
              <IconButton label={`Ask ${agentName(registry.app)}`} className={`app__meta ${thread?.meta ? 'is-on' : ''}`} onClick={() => void dispatch('app.meta', {}, { source: 'rail' }).catch((error) => console.error(error))}>
                <LifebuoyIcon size={18} aria-hidden />
              </IconButton>
              {hasRail ? <Slot name="rail" props={{}} /> : <UnreadButton side="right" />}
            </div>
            <div className="app__rail-group">{settingsButton}</div>
          </nav>
        )}
        {sideOpen && (
          // In the drawer, picking a thread (even the open one) closes it.
          <aside className="app__sidebar" onClick={narrow ? (event) => { if ((event.target as HTMLElement).closest('.superego-list-item')) setDrawer(false) } : undefined}>
            {narrow && <div className="app__drag" />}
            <Slot name="sidebar" props={{}} />
            <div className="app__footer"><ServiceNotice />{narrow && <>{settingsButton}<UnreadButton /></>}</div>
          </aside>
        )}
        <main className="app__main">
          {narrow && hasSidebar && (
            <div className="app__mobilebar">
              <Button onClick={() => setDrawer(true)} aria-label="Threads"><ListIcon size={16} aria-hidden /></Button>
              <span className="app__mobiletitle">{thread?.title ?? registry.app.name}</span>
              <Button onClick={() => openNewThread()} aria-label="New thread"><PlusIcon size={16} aria-hidden /></Button>
            </div>
          )}
          {selection && thread && machine
            ? <ThreadView key={`${selection.machine}/${selection.thread}`} machine={machine} thread={thread} />
            : <div className="app__empty">{hasSidebar ? 'Select or start a thread.' : `Start a thread with: ${registry.app.id}`}</div>}
        </main>
        {!narrow && selection && thread && machine && registry.slots['thread.aside'].length > 0 && (
          <aside className="app__aside"><Slot name="thread.aside" props={{ machine, thread }} /></aside>
        )}
      </div>
      {settings.open && <SettingsView machines={machines} onClose={settings.close} />}
      {palette && <Palette onClose={() => setPalette(false)} />}
      {navigator && <Navigator onClose={() => setNavigator(false)} />}
      <Slot name="overlay" props={{}} />
      {log && <ActionLog router={registry.router.router} onClose={() => setLog(false)} />}
      {newThread.start && <NewThreadDialog start={newThread.start} onClose={newThread.close} />}
    </div>
  )
}

/** Without a sidebar: every machine's threads in one menu, and a new thread on this computer. */
function ThreadPicker() {
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const { selection, select } = useSelection()
  const threads = useAllThreads()
  const options = machines.flatMap((m) => (threads[m.id] ?? []).map((s) => ({
    value: `${m.id}/${s.id}`, label: s.title, ...(machines.length > 1 ? { group: m.label } : {}),
  })))
  const { newThread } = useShell()
  return (
    <div className="thread-picker">
      <Select aria-label="Thread" options={options} value={selection ? `${selection.machine}/${selection.thread}` : null}
        nullLabel={options.length ? 'Threads' : 'No threads yet'}
        onChange={(value) => {
          if (!value) return
          const slash = value.indexOf('/')
          select({ machine: value.slice(0, slash), thread: value.slice(slash + 1) })
        }} />
      <Button onClick={() => newThread()}>New</Button>
    </div>
  )
}

/** Fonts from the app's settings; ⌘, ; threads and Settings shown from the command line, a notification or the menu bar. */
function useAppEffects() {
  const { selection } = useSelection()
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const appSettings = useSettings('app', true)
  const keymapRef = useRef<Keymap | undefined>(undefined)
  keymapRef.current = appSettings?.values[KEYMAP] as Keymap | undefined
  const { select } = useSelection()
  const { openSettings } = useShell()
  const interfaceFont = appSettings?.values['app.font.interface']
  const monoFont = appSettings?.values['app.font.mono']
  const accent = appSettings?.values['app.accent']
  const textSize = appSettings?.values['app.font.size']
  const registry = useRegistry()
  useEffect(() => {
    const style = document.documentElement.style
    const set = (variable: string, family: unknown) => typeof family === 'string' ? style.setProperty(variable, `"${family.replace(/"/g, '')}", var(${variable}-fallback)`) : style.removeProperty(variable)
    set('--superego-font', interfaceFont)
    set('--superego-mono', monoFont)
    // The accent everything takes its colour from (see --superego-accent in @superego/ui's styles); one the browser can't read
    // leaves the default.
    if (typeof accent === 'string' && CSS.supports('color', accent)) style.setProperty('--superego-accent-base', accent)
    else style.removeProperty('--superego-accent-base')
    style.setProperty('--superego-text-scale', String(textScale(textSize)))
  }, [interfaceFont, monoFont, accent, textSize])
  // The shortcuts bound now, for the main process: a page in a pane (Preview, an artifact) that has the keyboard gets
  // key presses before this window could, so the main process takes these ones first and hands them here.
  const actions = useActions(selection?.machine)
  const boundKeys = [...new Set(actions.filter(runsBare).map((action) => bound(action, keymapRef.current)).filter((k): k is string => Boolean(k)))].sort().join(' ')
  useEffect(() => {
    if (window.superego.web) return
    void window.superego.call('app', 'app.keys', { keys: boundKeys ? boundKeys.split(' ') : [] }).catch(() => {})
  }, [boundKeys])
  useEffect(() => {
    document.title = registry.app.name
    // Every shortcut is an action's: the same router the palette and other code dispatch through. With two on one
    // shortcut, the first registered wins (Settings → Keyboard shows the clash).
    const runKeys = (pressed: string) => {
      for (const action of registry.router.all(selectionRef.current?.machine)) {
        if (runsBare(action) && bound(action, keymapRef.current) === pressed) {
          void registry.router.dispatch(action.id, {}, { source: 'keys' }).catch((error) => console.error(error))
          return true
        }
      }
      return false
    }
    const onKey = (event: KeyboardEvent) => {
      const pressed = shortcutOf(event)
      if (pressed && runKeys(pressed)) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    const show = ({ open, settings }: { open?: Selection; settings?: boolean }) => {
      if (open) select(open)
      if (settings) openSettings()
    }
    const off = window.superego.onEvent((event) => {
      if (event.machine !== 'app') return
      if (event.method === 'app.select') show({ open: event.params as Selection })
      if (event.method === 'app.settings') show({ settings: true })
      // Pressed while a page in a pane had the keyboard: the main process caught it before the page (see app.keys).
      if (event.method === 'app.key') runKeys((event.params as { keys: string }).keys)
    })
    void (window.superego.call('app', 'app.ready', {}) as Promise<{ open?: Selection; settings?: boolean }>).then(show)
    return () => { window.removeEventListener('keydown', onKey); off() }
  }, [])
}
