// The shell every app gets: the sidebar slot (or, with nothing there, a compact thread picker), the selected thread,
// the restart notice, Settings, and the app-wide reactions (fonts, ⌘, , threads shown from the command line or a
// notification, marking finished threads seen).
import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, Select } from '@mu/ui'
import { machine as client, useAppSetting, useSettings } from './client.ts'
import { Slot, useRegistry } from './extension.tsx'
import { ServiceNotice } from './ServiceNotice.tsx'
import { ThreadView } from './ThreadView.tsx'
import { SettingsView } from './SettingsView.tsx'
import { Palette } from './Palette.tsx'
import { Navigator } from './Navigator.tsx'
import { ActionLog, runsBare } from './actions.tsx'
import { NewThreadDialog } from './NewThread.tsx'
import { bound, KEYMAP, shortcutOf, type Keymap } from './keys.ts'
import { useAllThreads, useMachines, useNewThreadDialog, useSelection, useSessions, useSettingsDialog, useShell, useSidebar, type Selection } from './state.tsx'

/** Dispatch an action from this window: `dispatch('threads.rail')`, `dispatch('thread.select', { machine, thread })`. */
export function useDispatch() {
  return useRegistry().router.dispatch
}

/** Whether the window is phone-narrow. */
function useNarrow() {
  const query = '(max-width: 760px)'
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


  const actions = <><ServiceNotice /><Button onClick={openSettings}>Settings</Button></>
  return (
    <div className={`app ${hasSidebar && sidebar.open ? 'has-sidebar' : ''} ${narrow ? 'is-narrow' : ''} ${drawer ? 'has-drawer' : ''} ${window.mu.web ? 'is-web' : ''}`}>
      {narrow && hasSidebar && drawer && <div className="app__scrim" onClick={() => setDrawer(false)} />}
      {/* One place, open or closed: right of the window's buttons. */}
      {hasSidebar && !narrow && (
        <IconButton label={sidebar.open ? 'Hide sidebar' : 'Show sidebar'} className="app__sidebar-toggle" onClick={() => sidebar.toggle()}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M6 3v10" stroke="currentColor" strokeWidth="1.3" /></svg>
        </IconButton>
      )}
      {hasSidebar && (narrow ? drawer : sidebar.open) && (
        // In the drawer, picking a thread (even the open one) closes it.
        <aside className="app__sidebar" onClick={narrow ? (event) => { if ((event.target as HTMLElement).closest('.mu-list-item')) setDrawer(false) } : undefined}>
          <div className="app__drag" />
          <Slot name="sidebar" props={{}} />
          <div className="app__footer">{actions}</div>
        </aside>
      )}
      <main className="app__main">
        {narrow && hasSidebar
          ? (
            <div className="app__mobilebar">
              <Button onClick={() => setDrawer(true)} aria-label="Threads">☰</Button>
              <span className="app__mobiletitle">{thread?.title ?? registry.app.name}</span>
              <Button onClick={() => openNewThread()} aria-label="New thread">+</Button>
            </div>
          )
          : <div className="app__drag">{!hasSidebar && <div className="app__bar"><ThreadPicker />{actions}</div>}</div>}
        {selection && thread && machine
          ? <ThreadView key={`${selection.machine}/${selection.thread}`} machine={machine} thread={thread} />
          : <div className="app__empty">{hasSidebar ? 'Select or start a thread.' : `Start a thread with: ${registry.app.id}`}</div>}
      </main>
      {!narrow && selection && thread && machine && registry.slots['thread.aside'].length > 0 && (
        <aside className="app__aside"><div className="app__drag" /><Slot name="thread.aside" props={{ machine, thread }} /></aside>
      )}
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
  const registry = useRegistry()
  useEffect(() => {
    const style = document.documentElement.style
    const set = (variable: string, family: unknown) => typeof family === 'string' ? style.setProperty(variable, `"${family.replace(/"/g, '')}", var(${variable}-fallback)`) : style.removeProperty(variable)
    set('--mu-font', interfaceFont)
    set('--mu-mono', monoFont)
  }, [interfaceFont, monoFont])
  useEffect(() => {
    document.title = registry.app.name
    const onKey = (event: KeyboardEvent) => {
      // Every shortcut is an action's: the same router the palette and other code dispatch through. With two on one
      // shortcut, the first registered wins (Settings → Keyboard shows the clash).
      const pressed = shortcutOf(event)
      if (!pressed) return
      for (const action of registry.router.all(selectionRef.current?.machine)) {
        if (runsBare(action) && bound(action, keymapRef.current) === pressed) {
          event.preventDefault()
          void registry.router.dispatch(action.id, {}, { source: 'keys' }).catch((error) => console.error(error))
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    const show = ({ open, settings }: { open?: Selection; settings?: boolean }) => {
      if (open) select(open)
      if (settings) openSettings()
    }
    const off = window.mu.onEvent((event) => {
      if (event.machine !== 'app') return
      if (event.method === 'app.select') show({ open: event.params as Selection })
      if (event.method === 'app.settings') show({ settings: true })
    })
    void (window.mu.call('app', 'app.ready', {}) as Promise<{ open?: Selection; settings?: boolean }>).then(show)
    return () => { window.removeEventListener('keydown', onKey); off() }
  }, [])
}
