// The shell every app gets: its places (the rail's spaces and buttons, the open space in the sidebar, the title bar's
// start, the aside beside the thread; on a phone, the drawer), with the views the layout puts there; the selected
// thread, the notices (restart required, a provider rejecting the credentials), Settings, and the app-wide reactions
// (fonts, ⌘, , threads shown from the command line or a notification). It knows no extension: what's where is the
// layout's (see layout.ts).
import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { SettingsSnapshot, ThreadInfo } from '@superego/protocol'
import { ArrowLeftIcon, ArrowRightIcon, Button, CaretDownIcon, GearSixIcon, IconButton, ListIcon, NotePencilIcon, PlusIcon, Select, StatusGlyph } from '@superego/ui'
import { textScale, type MachineEntry } from '../shared.ts'
import { machine as client, useSettings, watched } from './client.ts'
import { paneMenu, PlacedViews, shownPanes, Slot, useLayout, useRegistry, viewsIn, whose, type SpaceRailProps, type View, type ViewProps } from './extension.tsx'
import { Contained } from './contained.tsx'
import { useLocalState } from './local-state.ts'
import { ServiceNotice } from './ServiceNotice.tsx'
import { RevokedUiNotice } from './profile-ui-notice.tsx'
import { LayoutEditor, LayoutNotice, LayoutViews } from './layout-text.tsx'
import { ViewContextMenu, withContextMenu, withMenuButton } from './view-menu.tsx'
import { refreshFontsSoon } from './fonts.ts'
import { AuthNotice } from './AuthNotice.tsx'
import { ThreadTitle, ThreadTools, ThreadView } from './ThreadView.tsx'
import { StripSlot } from './panes.tsx'
import { SettingsView } from './SettingsView.tsx'
import { Palette } from './Palette.tsx'
import { Navigator } from './Navigator.tsx'
import { ActionLog, runsBare } from './actions.tsx'
import { performed } from './perform.ts'
import { NewThreadDialog } from './NewThread.tsx'
import { bound, KEYMAP, shortcutOf, useActions, useShortcut, type Keymap } from './keys.ts'
import { useAllThreads, useHistory, useMachines, useNewThreadDialog, useSelection, useSessions, useSettingsDialog, useShell, useSidebar, type Selection } from './state.tsx'

/** Dispatch an action from this window: `dispatch('app.sidebar')`, `dispatch('thread.select', { machine, thread })`. */
export function useDispatch() {
  return useRegistry().router.dispatch
}

export function Shell() {
  const registry = useRegistry()
  const [palette, setPalette] = useState(false)
  const [navigator, setNavigator] = useState(false)
  const sidebar = useSidebar()
  const { sessions, lastThread } = useSessions()
  const [log, setLog] = useState(false)
  const machines = useMachines()
  const { selection, select, machine, thread, hidden: alone, listed } = useSelection()
  const settings = useSettingsDialog()
  const newThread = useNewThreadDialog()
  const { openSettings } = useShell()
  const allThreads = useAllThreads()
  const { newThread: openNewThread } = useShell()
  const history = useHistory()
  // A phone (or a narrow window): the sidebar becomes a drawer over the thread, opened from a bar at the top.
  const { placed, narrow } = useLayout()
  const [drawer, setDrawer] = useState(false)
  // On a phone, what the title bar and the aside hold for the thread: a sheet from the foot, opened from its title.
  const [sheet, setSheet] = useState(false)
  // The spaces, and the one the sidebar shows: as the window was left, else the first.
  const spaces = viewsIn(registry, placed, 'space')
  const [spaceId, setSpace] = useLocalState<string | undefined>('space', undefined)
  const space = spaces.find((view) => view.id === spaceId) ?? spaces[0]
  // Wide, the rail is a row of tabs with one in front, joined to what's beside it: Settings while it's open; else a
  // hidden thread's (Ego's: the thread alone, no sidebar); else the open space, as the sidebar.
  const tab: 'settings' | 'thread' | 'space' = narrow ? 'space' : settings.open ? 'settings' : alone ? 'thread' : 'space'
  const where = selection && thread && machine ? { machine: machine.id, thread } : undefined
  // The thread's places, as the views it sees resolve.
  const threadPlaced = useLayout(where).placed
  // Where the thread's columns show their tabs: in the title bar, wide.
  const [strip, setStrip] = useState<HTMLElement | null>(null)
  useEffect(() => { setDrawer(false); setSheet(false) }, [selection?.machine, selection?.thread, narrow])
  // The installed fonts take seconds to list: read them in the background, for Settings' font pickers.
  useEffect(refreshFontsSoon, [])
  // Actions read the shell as it is when they run.
  registry.router.setContext({
    app: registry.app, machines, selection, select, openSettings, newThread: openNewThread,
    togglePalette: () => { setNavigator(false); setPalette((open) => !open) },
    toggleNavigator: () => { setPalette(false); setNavigator((open) => !open) },
    showLog: () => setLog(true),
    // With the panes it shows (not those of an extension it goes without), as the window has it.
    // The selected one too while it's not among them (Ego's, hidden; an archived one).
    threadOf: (s) => {
      const found = allThreads[s.machine]?.find((x) => x.id === s.thread) ?? (s.machine === selection?.machine && s.thread === selection.thread ? thread : undefined)
      return found?.panes ? { ...found, panes: shownPanes(registry, { machine: s.machine, thread: found }) } : found
    },
    sessions, lastThread, appSetting: (key) => watched<SettingsSnapshot>('app', 'settings.watch', {})?.values[key] as never,
    toggleSidebar: () => narrow ? setDrawer((open) => !open) : sidebar.toggle(),
    back: history.back, forward: history.forward,
  })
  useAppEffects()

  const settingsButton = (
    <IconButton label="Settings" className={`app__settings ${tab === 'settings' ? 'is-on' : ''}`} onClick={openSettings}>
      <GearSixIcon size={18} aria-hidden />
    </IconButton>
  )
  const sideOpen = spaces.length > 0 && (narrow ? drawer : sidebar.open && tab === 'space')
  // Wide: across the top a title bar (the window's buttons, then where you are, the thread's columns and what the thread
  // says about itself); down the left a rail (what extensions put there, Settings) and the sidebar beside it; the rest holds the
  // thread and its panes. Narrow: one column under a bar of its own, the sidebar a drawer.
  return (
    <div className={`app ${sideOpen ? 'has-sidebar' : ''} ${narrow ? 'is-narrow' : ''} ${drawer ? 'has-drawer' : ''} ${window.superego.web ? 'is-web' : ''}`}>
      {narrow && spaces.length > 0 && drawer && <div className="app__scrim" onClick={() => setDrawer(false)} />}
      {!narrow && (
        <header className="app__drag app__titlebar">
          <BackForward />
          <PlacedViews place="titlebar" frame={withContextMenu('titlebar')} />
          {tab === 'settings'
            ? <span className="titlebar__crumb"><span className="titlebar__seg titlebar__title">Settings</span></span>
            : selection && thread && machine && <ThreadTitle machine={machine} thread={thread} />}
          <span className="app__titlebar-end">
            {/* The notices go at the sidebar's foot; without one shown (Settings, Ego's thread, closed), here. */}
            {!sideOpen && <><AuthNotice /><ServiceNotice /><LayoutNotice /><RevokedUiNotice /></>}
            <span className="app__strip" ref={setStrip} />
            {tab !== 'settings' && selection && thread && machine && <ThreadTools machine={machine} thread={thread} />}
          </span>
        </header>
      )}
      <div className="app__body">
        {!narrow && (
          <nav className="app__rail" aria-label="App" data-tab={tab}>
            <div className="app__rail-group">
              <PlacedViews place="rail" frame={withContextMenu('rail')} />
              {spaces.map((view) => (
                <ViewContextMenu key={view.id} view={view.id} place="space">
                  <SpaceButton view={view} open={tab === 'space' && sidebar.open && view.id === space?.id}
                    show={(open = true) => {
                      setSpace(view.id)
                      sidebar.toggle(open)
                      // From Ego's thread, back to the listed one it left; from Settings, back to the thread.
                      if (open && alone) select(listed)
                      else if (open) settings.close()
                    }} />
                </ViewContextMenu>
              ))}
            </div>
            <div className="app__rail-group">{settingsButton}</div>
          </nav>
        )}
        {tab === 'settings' && <main className="app__main"><SettingsView machines={machines} onClose={settings.close} pane /></main>}
        {tab !== 'settings' && sideOpen && (
          // In the drawer, picking a thread (even the open one) closes it.
          <aside className="app__sidebar" onClick={narrow ? (event) => { if ((event.target as HTMLElement).closest('.superego-list-item')) setDrawer(false) } : undefined}>
            {narrow && <div className="app__drag" />}
            {space && <SpaceView key={space.id} view={space} {...(where ? { machine, thread } : {})} />}
            <div className="app__footer"><AuthNotice /><ServiceNotice /><LayoutNotice /><RevokedUiNotice />{narrow && (
              // A phone's drawer: the other spaces to switch to, what the layout puts in the drawer, and Settings at the end.
              <div className="app__drawer-bar">
                {spaces.length > 1 && <>
                  {spaces.map((view) => (
                    <ViewContextMenu key={view.id} view={view.id} place="space"><SpaceButton view={view} open={view.id === space?.id} show={() => setSpace(view.id)} narrow /></ViewContextMenu>
                  ))}
                  <span className="app__drawer-sep" aria-hidden />
                </>}
                <PlacedViews place="drawer" frame={withContextMenu('drawer')} />
                <span className="app__drawer-end">{settingsButton}</span>
              </div>
            )}</div>
          </aside>
        )}
        {tab !== 'settings' && <main className="app__main">
          {narrow && (
            // With no space there's no drawer: what stands in for one (the title bar's: the thread picker) and Settings.
            <div className="app__mobilebar">
              {spaces.length > 0
                ? <Button onClick={() => setDrawer(true)} aria-label={space?.title}><ListIcon size={16} aria-hidden /></Button>
                : <PlacedViews place="titlebar" frame={withContextMenu('titlebar')} />}
              {thread && machine
                ? (
                  <button type="button" className="app__mobiletitle" aria-expanded={sheet} aria-label={`${thread.title}: the thread's tools`} onClick={() => setSheet((open) => !open)}>
                    <StatusGlyph status={thread.status} /><span className="app__mobiletitle-text">{thread.title}</span><CaretDownIcon size={12} aria-hidden />
                  </button>
                )
                : <span className="app__mobiletitle">{registry.app.name}</span>}
              {spaces.length > 0 || !placed.titlebar.length ? <Button onClick={() => openNewThread()} aria-label="New thread"><PlusIcon size={16} aria-hidden /></Button> : null}
              {!spaces.length && settingsButton}
            </div>
          )}
          {selection && thread && machine
            ? <StripSlot.Provider value={narrow ? null : strip}><ThreadView key={`${selection.machine}/${selection.thread}`} machine={machine} thread={thread} /></StripSlot.Provider>
            : <div className="app__empty">{spaces.length ? 'Select or start a thread.' : `Start a thread with: ${registry.app.id}`}</div>}
        </main>}
        {tab !== 'settings' && !narrow && where && viewsIn(registry, threadPlaced, 'aside', where).length > 0 && (
          <aside className="app__aside"><PlacedViews place="aside" machine={machine} thread={thread} frame={withMenuButton('aside', where)} /></aside>
        )}
      </div>
      {narrow && sheet && thread && machine && <ThreadSheet machine={machine} thread={thread} onClose={() => setSheet(false)} />}
      {narrow && settings.open && <SettingsView machines={machines} onClose={settings.close} />}
      {palette && <Palette onClose={() => setPalette(false)} />}
      {navigator && <Navigator onClose={() => setNavigator(false)} />}
      <Slot name="overlay" props={{}} />
      <LayoutViews />
      <LayoutEditor />
      {log && <ActionLog router={registry.router.router} onClose={() => setLog(false)} />}
      {newThread.start && <NewThreadDialog start={newThread.start} onClose={newThread.close} />}
    </div>
  )
}

/** Back and forward, at the title bar's start, as a browser has them. */
function BackForward() {
  const { canBack, canForward } = useHistory()
  const dispatch = useDispatch()
  const backKeys = useShortcut('app.back')
  const forwardKeys = useShortcut('app.forward')
  const go = (id: string) => void dispatch(id, {}, { source: 'titlebar' }).catch((error) => console.error(error))
  return (
    <span className="app__history">
      <IconButton label={backKeys ? `Back (${backKeys})` : 'Back'} className="app__back" disabled={!canBack} onClick={() => go('app.back')}>
        <ArrowLeftIcon size={15} aria-hidden />
      </IconButton>
      <IconButton label={forwardKeys ? `Forward (${forwardKeys})` : 'Forward'} className="app__forward" disabled={!canForward} onClick={() => go('app.forward')}>
        <ArrowRightIcon size={15} aria-hidden />
      </IconButton>
    </span>
  )
}

/** A space's button in the rail: its own (`rail`), else its icon, lit while it's the open one. In a phone's drawer, always its icon. */
function SpaceButton({ view, open, show, narrow = false }: { view: View; narrow?: boolean } & SpaceRailProps) {
  if (view.rail && !narrow) return <Contained name={whose(view)} inline><view.rail open={open} show={show} /></Contained>
  const Icon = view.icon
  return (
    <IconButton label={view.title} className={`app__rail-button ${open ? 'is-on' : ''}`} onClick={() => show(!open)}>
      {Icon ? <Icon size={18} aria-hidden /> : view.title.slice(0, 1)}
    </IconButton>
  )
}

/**
 * On a phone, the thread's sheet: what the title bar says of it wide (where it runs, the header's views, archiving),
 * the panes to open beside it, and the views the layout puts in the aside. Over the thread, from the foot.
 */
function ThreadSheet({ machine, thread, onClose }: { machine: MachineEntry; thread: ThreadInfo; onClose(): void }) {
  const registry = useRegistry()
  const where = { machine: machine.id, thread }
  const { placed } = useLayout(where)
  const kinds = paneMenu(registry, placed, where)
  const asides = viewsIn(registry, placed, 'aside', where)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const open = (kind: string) => {
    onClose()
    void registry.router.dispatch('pane.open', { id: thread.id, kind }, { machine: machine.id, source: 'sheet' }).catch((error) => console.error(error))
  }
  return (
    <>
      <div className="app__scrim app__scrim--sheet" onClick={onClose} />
      <div className="thread-sheet" role="dialog" aria-label={thread.title}>
        <div className="thread-sheet__head">
          <span className="thread-sheet__session">{machine.id !== 'local' && `${machine.label} · `}{thread.session?.name}</span>
          <span className="thread-sheet__title"><StatusGlyph status={thread.status} />{thread.title}</span>
        </div>
        <div className="thread-sheet__tools"><ThreadTools machine={machine} thread={thread} panes={false} /></div>
        {kinds.length > 0 && (
          <div className="thread-sheet__panes">
            <h5>Open beside</h5>
            {kinds.map(({ kind, title }) => <Button key={kind} variant="ghost" className="thread-sheet__pane" onClick={() => open(kind)}>{title}</Button>)}
          </div>
        )}
        {asides.length > 0 && <div className="thread-sheet__aside"><PlacedViews place="aside" machine={machine} thread={thread} frame={withMenuButton('aside', where)} /></div>}
      </div>
    </>
  )
}

/** The open space, in the sidebar: a view that needs a thread shows the selected one, and nothing without. */
function SpaceView({ view, machine, thread }: { view: View; machine?: MachineEntry; thread?: ThreadInfo }) {
  const Component = view.component as ComponentType<ViewProps>
  if (view.context === 'thread' && !(machine && thread)) return null
  return <Contained name={whose(view)}><Component place="space" {...(machine && thread ? { machine, thread } : {})} /></Contained>
}

/** Without a space (the core's `core.picker`, at the title bar's start): every thread in a menu, and a new one. */
export function ThreadPicker() {
  const { newThread } = useShell()
  return (
    <span className="app__tools">
      <ThreadMenu />
      <IconButton label="New thread (⌘N)" className="app__new" onClick={() => newThread()}>
        <NotePencilIcon size={15} aria-hidden />
      </IconButton>
    </span>
  )
}

/** Every machine's threads in one menu, and a new thread on this computer. */
function ThreadMenu() {
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
        if (runsBare(action) && bound(action, keymapRef.current) === pressed && registry.router.offered(action.id)) {
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
    // The mouse's back and forward buttons, and the main process's word of them or of a swipe. Some systems send a
    // button both ways; one press goes once.
    let wentAt = 0
    const go = (by: number) => {
      if (performance.now() - wentAt < 150) return
      wentAt = performance.now()
      void registry.router.dispatch(by < 0 ? 'app.back' : 'app.forward', {}, { source: 'pointer' }).catch((error) => console.error(error))
    }
    const onMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      // Kept from the browser too, which would go back from the app itself.
      event.preventDefault()
      if (event.type === 'mouseup') go(event.button === 3 ? -1 : 1)
    }
    window.addEventListener('mousedown', onMouse)
    window.addEventListener('mouseup', onMouse)
    const show = ({ open, settings }: { open?: Selection; settings?: boolean }) => {
      if (open) select(open)
      if (settings) openSettings()
    }
    const off = window.superego.onEvent((event) => {
      // Another client asks for one of this window's own actions (see perform.ts). Every window of the app hears it;
      // the ones on screen run it.
      if (event.method === 'client.perform') {
        const asked = document.visibilityState === 'visible' ? performed(event) : undefined
        if (asked && registry.router.router.has(asked.action)) void registry.router.dispatch(asked.action, asked.params, { source: asked.source }).catch((error) => console.error(error))
        return
      }
      if (event.machine !== 'app') return
      if (event.method === 'app.select') show({ open: event.params as Selection })
      if (event.method === 'app.settings') show({ settings: true })
      // Pressed while a page in a pane had the keyboard: the main process caught it before the page (see app.keys).
      if (event.method === 'app.key') runKeys((event.params as { keys: string }).keys)
      if (event.method === 'app.go') go((event.params as { by: number }).by)
    })
    void (window.superego.call('app', 'app.ready', {}) as Promise<{ open?: Selection; settings?: boolean }>).then(show)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onMouse); window.removeEventListener('mouseup', onMouse); off() }
  }, [])
}
