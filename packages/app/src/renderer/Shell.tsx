// The shell every app gets: its places (the rail's spaces and buttons, the open space in the sidebar, the title bar's
// start, the column beside the thread; on a phone, the drawer), with the views the layout puts there; the selected
// thread, the notices (restart required, a provider rejecting the credentials), Settings, and the app-wide reactions
// (fonts, ⌘, , threads shown from the command line or a notification). It knows no extension: what's where is the
// layout's (see shared/layout.ts).
import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { SettingsSnapshot, ThreadInfo } from '@superego/protocol'
import { ArrowLeftIcon, ArrowRightIcon, autoFocusOnOpen, Button, CaretDownIcon, Drawer, GearSixIcon, IconButton, ListIcon, NotePencilIcon, PlusIcon, Select, StatusGlyph } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { ACCENT, APP, INTERFACE_FONT, KEYMAP, MONO_FONT, TEXT_SIZE, textScale } from '../shared/app-settings.ts'
import { useSettings, watched } from './client.ts'
import type { SpaceRailProps, View, ViewProps } from './extension-api.ts'
import { scopeOfEntry, useRegistry, whose } from './registry.tsx'
import { shownPanes } from './lookups.ts'
import { paneMenu, PlacedViews, Slot, useLayout, viewsIn } from './placement.tsx'
import { Contained } from './contained.tsx'
import { RailButton } from './marks.tsx'
import { forgetWindows, useLocalState } from './local-state.ts'
import { ServiceNotice } from './ServiceNotice.tsx'
import { BuildNotice } from './BuildNotice.tsx'
import { RevokedUiNotice } from './profile-ui-notice.tsx'
import { LayoutEditor, LayoutNotice, LayoutViews } from './layout-text.tsx'
import { ViewContextMenu, withContextMenu, withMenuButton } from './view-menu.tsx'
import { refreshFontsSoon } from './fonts.ts'
import { AuthNotice } from './AuthNotice.tsx'
import { ThreadView } from './ThreadView.tsx'
import { ThreadTitle, ThreadTools } from './thread-header.tsx'
import { Overflow, OverflowMenu, OverflowProvider } from './overflow.tsx'
import { ArchiveButton, PinButton, UnarchiveButton } from './thread-actions.tsx'
import { StripSlot } from './panes.tsx'
import { useSidebarEdge } from './sidebar-edge.tsx'
import { SettingsView } from './SettingsView.tsx'
import { Palette } from './Palette.tsx'
import { Navigator } from './Navigator.tsx'
import { PanePicker } from './pane-picker.tsx'
import { ActionLog, runsBare } from './actions.tsx'
import { performed } from './perform.ts'
import { NewThreadDialog } from './NewThread.tsx'
import { Onboarding, useOnboarding } from './Onboarding.tsx'
import { bound, RailTabNumber, shortcutOf, useActions, useRailShortcut, useShortcut, type Keymap } from './keys.ts'
import { railTabs } from './rail-tabs.ts'
import { useAllThreads, useFold, useHistory, useMachines, useNewThreadDialog, useSelection, useProjects, useSettingsDialog, useShell, useSidebar, type Selection } from './state.tsx'

/** Dispatch an action from this window: `dispatch('app.sidebar')`, `dispatch('thread.select', { machine, thread })`. */
export function useDispatch() {
  return useRegistry().router.dispatch
}

export function Shell() {
  const registry = useRegistry()
  const [palette, setPalette] = useState(false)
  const [navigator, setNavigator] = useState(false)
  const [panePicker, setPanePicker] = useState(false)
  const sidebar = useSidebar()
  const { projects, sidebar: rows, lastThread } = useProjects()
  const fold = useFold()
  const [log, setLog] = useState(false)
  const machines = useMachines()
  const { selection, select, machine, thread, hidden: alone, listed } = useSelection()
  const settings = useSettingsDialog()
  const newThread = useNewThreadDialog()
  const { openSettings, newThread: openNewThread } = useShell()
  const allThreads = useAllThreads()
  const history = useHistory()
  // A phone (or a narrow window): the sidebar becomes a drawer over the thread, opened from a bar at the top.
  const { placed, narrow } = useLayout()
  const [drawer, setDrawer] = useState(false)
  // On a phone, what the title bar and the column beside hold for the thread: a sheet from the foot (Base UI's Drawer),
  // opened from its title. Its own drawer, not one nested in the sidebar's, so the title opens it through a handle.
  const [sheet, setSheet] = useState(false)
  const [sheetHandle] = useState(() => Drawer.createHandle())
  // The spaces, and the one the sidebar shows: as the window was left, else the first.
  const spaces = viewsIn(registry, placed, 'space')
  const [spaceId, setSpace] = useLocalState<string | undefined>('space', undefined)
  const space = spaces.find((view) => view.id === spaceId) ?? spaces[0]
  // Wide, the rail is a row of tabs with one in front, joined to what's beside it: Settings while it's open; else a
  // hidden thread's (Ego's: the thread alone, no sidebar); else the open space, as the sidebar.
  const tab: 'settings' | 'thread' | 'space' = narrow ? 'space' : settings.open ? 'settings' : alone ? 'thread' : 'space'
  // Wide, the sidebar's edge resizes it, and hides it dragged narrow.
  const sidebarEdge = useSidebarEdge()
  // Narrow, the sidebar is a drawer (Base UI's): out from ☰ or a swipe from the screen's left edge, back with a swipe to
  // the left, a tap beside it, Escape, or a thread picked in it. Drawn into the window (`app`), under its styles.
  const [app, setApp] = useState<HTMLDivElement | null>(null)
  const drawerPopup = useRef<HTMLDivElement>(null)
  // Closed by a thread picked in it, the focus is the thread's to take, not ☰'s again.
  const picked = useRef(false)
  const where = selection && thread && machine ? { machine: machine.id, thread } : undefined
  // A space shown in the sidebar (\`open\`), or the sidebar hidden from its button: from Ego's thread, back to the
  // listed one it left; from Settings, back to the thread.
  const showSpace = (view: (typeof spaces)[number], open = true) => {
    setSpace(view.id)
    sidebar.show(open)
    if (open && alone) select(listed)
    else if (open) settings.close()
  }
  // The rail's tabs, which ⌘1–⌘9 go to (see rail-tabs.ts): as the rail is when asked.
  const tabsNow = () => narrow ? [] : railTabs(viewsIn(registry, placed, 'rail'), spaces, {
    offered: registry.router.offered,
    run: (action) => void registry.router.dispatch(action, {}, { source: 'keys' }).catch((error) => console.error(error)),
    show: (view) => showSpace(view),
  })
  // The thread's places, as the views it sees resolve.
  const threadPlaced = useLayout(where).placed
  // Where the thread's columns show their tabs: in the title bar, wide.
  const [strip, setStrip] = useState<HTMLElement | null>(null)
  // What the title bar gives way with, short of room (overflow.tsx).
  const [overflow] = useState(() => new Overflow())
  useEffect(() => { setDrawer(false); setSheet(false); setPanePicker(false) }, [selection?.machine, selection?.thread, narrow])
  // The installed fonts take seconds to list: read them in the background, for Settings' font pickers.
  useEffect(refreshFontsSoon, [])
  // Actions read the shell as it is when they run.
  registry.router.setContext({
    app: registry.app, machines, selection, select, openSettings, newThread: openNewThread,
    togglePalette: () => { setNavigator(false); setPanePicker(false); setPalette((open) => !open) },
    toggleNavigator: () => { setPalette(false); setPanePicker(false); setNavigator((open) => !open) },
    togglePanePicker: () => { setPalette(false); setNavigator(false); setPanePicker((open) => !open) },
    showLog: () => setLog(true),
    // With the panes it shows (not those of an extension it goes without), as the window has it.
    // The selected one too while it's not among them (Ego's, hidden; an archived one).
    threadOf: (s) => {
      const found = allThreads[s.machine]?.find((x) => x.id === s.thread) ?? (s.machine === selection?.machine && s.thread === selection.thread ? thread : undefined)
      return found?.panes ? { ...found, panes: shownPanes(registry, { machine: s.machine, thread: found }) } : found
    },
    projects, sidebar: rows, lastThread, fold, appSetting: (key) => watched<SettingsSnapshot>(APP, 'settings.watch', {})?.values[key] as never,
    toggleSidebar: () => narrow ? setDrawer((open) => !open) : sidebar.show(),
    back: history.back, forward: history.forward,
    railTabs: tabsNow,
  })
  // Each tab's number, for its tooltip.
  const tabNumber = new Map(tabsNow().map((tab, i) => [tab.id, i + 1]))
  useAppearance()
  useAppEvents(useKeyRouting())
  const onboarding = useOnboarding()

  const settingsButton = (
    <IconButton label="Settings" className={`app__settings ${tab === 'settings' ? 'is-on' : ''}`} onClick={openSettings}>
      <GearSixIcon size={18} aria-hidden />
    </IconButton>
  )
  const sideOpen = spaces.length > 0 && (narrow ? drawer : !sidebar.hidden && tab === 'space')
  // The notices: wide, in the rail above Settings, each a mark that opens to all it says; on a phone, at the drawer's foot.
  const notices = <><AuthNotice rail={!narrow} /><ServiceNotice rail={!narrow} /><BuildNotice rail={!narrow} /><LayoutNotice rail={!narrow} /><RevokedUiNotice rail={!narrow} /></>
  // What the sidebar holds: the space it shows; in the drawer, the notices, the other spaces and Settings at its foot.
  const sidebarBody = <>
    {narrow && <div className="app__drag" />}
    {space && <SpaceView key={space.id} view={space} {...(where ? { machine, thread } : {})} />}
    {narrow && <div className="app__footer">{notices}
      {/* A phone's drawer: the other spaces to switch to, what the layout puts in the drawer, and Settings at the end. */}
      <div className="app__drawer-bar">
        {spaces.length > 1 && <>
          {spaces.map((view) => (
            <ViewContextMenu key={view.id} view={view.id} place="space"><SpaceButton view={view} open={view.id === space?.id} sidebarHidden={false} show={() => setSpace(view.id)} narrow /></ViewContextMenu>
          ))}
          <span className="app__drawer-sep" aria-hidden />
        </>}
        <PlacedViews place="drawer" frame={withContextMenu('drawer')} />
        <span className="app__drawer-end">{settingsButton}</span>
      </div>
    </div>}
  </>
  // Wide: across the top a title bar (the window's buttons, then where you are, the thread's columns and what the thread
  // says about itself); down the left a rail (what extensions put there, Settings) and the sidebar beside it; the rest holds the
  // thread and its panes. Narrow: one column under a bar of its own, the sidebar a drawer.
  return (
    <OverflowProvider value={narrow ? null : overflow}>
    <div className={`app ${sideOpen ? 'has-sidebar' : ''} ${narrow ? 'is-narrow' : ''} ${window.superego.web ? 'is-web' : ''} ${sidebarEdge.hiding ? 'is-hiding' : ''}`}
      style={narrow ? undefined : sidebarEdge.style} ref={setApp}>
      {!narrow && (
        <header className="app__drag app__titlebar" ref={overflow.setBar}>
          <BackForward />
          <PlacedViews place="titlebar" frame={withContextMenu('titlebar')} />
          {tab === 'settings'
            ? <span className="titlebar__crumb"><span className="titlebar__seg titlebar__title">Settings</span></span>
            : selection && thread && machine && <ThreadTitle machine={machine} thread={thread} />}
          <span className="app__titlebar-end">
            <span className="app__strip" ref={setStrip} />
            {tab !== 'settings' && selection && thread && machine && <ThreadTools machine={machine} thread={thread} />}
          </span>
          <OverflowMenu />
        </header>
      )}
      <div className="app__body">
        {!narrow && (
          <nav className="app__rail" aria-label="App" data-tab={tab}>
            <div className="app__rail-group">
              <PlacedViews place="rail" frame={(view, drawn) => <RailTabNumber.Provider value={tabNumber.get(view.id)}>{withContextMenu('rail')(view, drawn)}</RailTabNumber.Provider>} />
              {spaces.map((view) => (
                <ViewContextMenu key={view.id} view={view.id} place="space">
                  <RailTabNumber.Provider value={tabNumber.get(view.id)}>
                    <SpaceButton view={view} open={tab === 'space' && view.id === space?.id} sidebarHidden={sidebar.hidden} show={(open = true) => showSpace(view, open)} />
                  </RailTabNumber.Provider>
                </ViewContextMenu>
              ))}
            </div>
            <div className="app__rail-group">{notices}{settingsButton}</div>
          </nav>
        )}
        {tab === 'settings' && <main className="app__main"><SettingsView machines={machines} onClose={settings.close} pane /></main>}
        {!narrow && tab !== 'settings' && sideOpen && <aside className="app__sidebar">{sidebarBody}</aside>}
        {!narrow && tab === 'space' && spaces.length > 0 && sidebarEdge.edge}
        {tab !== 'settings' && <main className="app__main">
          {narrow && (
            <Drawer.Root open={drawer && spaces.length > 0} onOpenChange={setDrawer} swipeDirection="left">
            {/* With no space there's no drawer: what stands in for one (the title bar's: the thread picker) and Settings. */}
            <div className="app__mobilebar">
              {spaces.length > 0
                ? <Drawer.Trigger render={<Button aria-label={space?.title} />}><ListIcon size={16} aria-hidden /></Drawer.Trigger>
                : <PlacedViews place="titlebar" frame={withContextMenu('titlebar')} />}
              {thread && machine
                ? (
                  <Drawer.Trigger handle={sheetHandle} className="app__mobiletitle" aria-label={`${thread.title}: the thread's tools`}>
                    <StatusGlyph status={thread.status} quiet={thread.quiet} /><span className="app__mobiletitle-text">{thread.title}</span><CaretDownIcon size={12} aria-hidden />
                  </Drawer.Trigger>
                )
                : <span className="app__mobiletitle">{registry.app.name}</span>}
              {spaces.length > 0 || !placed.titlebar.length ? <Button onClick={() => openNewThread()} aria-label="New thread"><PlusIcon size={16} aria-hidden /></Button> : null}
              {!spaces.length && settingsButton}
            </div>
            {spaces.length > 0 && <>
              <Drawer.SwipeArea className="app__swipe-edge" />
              <Drawer.Portal container={app}>
                <Drawer.Backdrop className="app__scrim app__scrim--drawer" />
                <Drawer.Viewport className="app__drawer">
                  {/* Opened by a finger, the drawer holds the focus itself (no keyboard over it); from the keyboard, the
                      selected thread. Picking a thread in it (even the open one) closes it. */}
                  <Drawer.Popup ref={drawerPopup} className="app__sidebar" aria-label={space?.title}
                    initialFocus={(type) => type === 'touch' || !autoFocusOnOpen() ? drawerPopup.current : drawerPopup.current?.querySelector<HTMLElement>('.superego-list-item.is-selected[tabindex]') ?? true}
                    finalFocus={() => { const back = !picked.current; picked.current = false; return back }}
                    onClick={(event) => { if ((event.target as HTMLElement).closest('.superego-list-item')) { picked.current = true; setDrawer(false) } }}>
                    {sidebarBody}
                  </Drawer.Popup>
                </Drawer.Viewport>
              </Drawer.Portal>
            </>}
            </Drawer.Root>
          )}
          {selection && thread && machine
            ? <StripSlot.Provider value={narrow ? null : strip}><ThreadView key={`${selection.machine}/${selection.thread}`} machine={machine} thread={thread} /></StripSlot.Provider>
            : onboarding ? <Onboarding /> : <div className="app__empty">{spaces.length ? 'Select or start a thread.' : `Start a thread with: ${registry.app.id}`}</div>}
        </main>}
        {tab !== 'settings' && !narrow && where && viewsIn(registry, threadPlaced, 'beside', where).length > 0 && (
          <aside className="app__beside"><PlacedViews place="beside" machine={machine} thread={thread} frame={withMenuButton('beside', where)} /></aside>
        )}
      </div>
      {narrow && thread && machine && <ThreadSheet machine={machine} thread={thread} open={sheet} onOpenChange={setSheet} handle={sheetHandle} container={app} />}
      {narrow && settings.open && <SettingsView machines={machines} onClose={settings.close} />}
      {palette && <Palette onClose={() => setPalette(false)} />}
      {navigator && <Navigator onClose={() => setNavigator(false)} />}
      {panePicker && where && <PanePicker machine={where.machine} thread={where.thread} onClose={() => setPanePicker(false)} />}
      <Slot name="overlay" props={{}} />
      <LayoutViews />
      <LayoutEditor />
      {log && <ActionLog router={registry.router.router} onClose={() => setLog(false)} />}
      {newThread.start && <NewThreadDialog start={newThread.start} onClose={newThread.close} />}
    </div>
    </OverflowProvider>
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

/**
 * A space's button in the rail: its own (`railButton`), else its icon, lit while the sidebar shows it, and hiding it from
 * there; its tooltip says its number (⌘2). In a phone's drawer, always its icon.
 */
function SpaceButton({ view, open, sidebarHidden, show, narrow = false }: { view: View; narrow?: boolean } & SpaceRailProps) {
  const keys = useRailShortcut()
  if (view.railButton && !narrow) return <Contained name={whose(view)} scope={scopeOfEntry(view)} inline><view.railButton open={open} sidebarHidden={sidebarHidden} show={show} /></Contained>
  const Icon = view.icon
  const shown = open && !sidebarHidden
  return (
    <RailButton label={view.title} title={keys ? `${view.title} (${keys})` : view.title} on={shown} onClick={() => show(!shown)}>
      {Icon ? <Icon size={18} aria-hidden /> : view.title.slice(0, 1)}
    </RailButton>
  )
}

/**
 * On a phone, the thread's sheet: what the title bar says of it wide (where it runs, the header's views, archiving),
 * the panes to open beside it, and the views the layout puts beside the thread. Over the thread, from the foot: Base
 * UI's Drawer, back down with a swipe, a tap beside it, or Escape (a menu open in it closes first). Drawn into the
 * window (`container`), under its styles.
 */
function ThreadSheet({ machine, thread, open, onOpenChange, handle, container }: {
  machine: MachineEntry; thread: ThreadInfo; open: boolean; onOpenChange(open: boolean): void
  handle: Drawer.Handle<unknown>; container: HTMLElement | null
}) {
  const registry = useRegistry()
  const where = { machine: machine.id, thread }
  const { placed } = useLayout(where)
  const kinds = paneMenu(registry, placed, where)
  const besides = viewsIn(registry, placed, 'beside', where)
  const popup = useRef<HTMLDivElement>(null)
  // Closed by a pane opened from it, the focus is the pane's to take, not the title's again.
  const opened = useRef(false)
  const openPane = (kind: string) => {
    opened.current = true
    onOpenChange(false)
    void registry.router.dispatch('pane.open', { thread: thread.id, kind }, { machine: machine.id, source: 'sheet' }).catch((error) => console.error(error))
  }
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} handle={handle} swipeDirection="down">
      <Drawer.Portal container={container}>
        <Drawer.Backdrop className="app__scrim app__scrim--sheet" />
        <Drawer.Viewport className="app__sheet">
          {/* Opened by a finger, the sheet holds the focus itself (no keyboard over it); from the keyboard, its first control. */}
          <Drawer.Popup ref={popup} className="thread-sheet" aria-label={thread.title}
            initialFocus={(type) => type === 'touch' || !autoFocusOnOpen() ? popup.current : true}
            finalFocus={() => { const back = !opened.current; opened.current = false; return back }}>
            <div className="thread-sheet__head">
              <span className="thread-sheet__project">{machine.id !== 'local' && `${machine.label} · `}{thread.project.name}</span>
              <span className="thread-sheet__title"><StatusGlyph status={thread.status} quiet={thread.quiet} />{thread.title}</span>
            </div>
            <div className="thread-sheet__tools">
              <ThreadTools machine={machine} thread={thread} panes={false} />
              <PinButton machine={machine} thread={thread} />
              {thread.hidden ? null : thread.archived ? <UnarchiveButton machine={machine} thread={thread} /> : <ArchiveButton machine={machine} thread={thread} />}
            </div>
            {kinds.length > 0 && (
              <div className="thread-sheet__panes">
                <h5>Open beside</h5>
                {kinds.map(({ kind, title }) => <Button key={kind} variant="ghost" className="thread-sheet__pane" onClick={() => openPane(kind)}>{title}</Button>)}
              </div>
            )}
            {besides.length > 0 && <div className="thread-sheet__beside"><PlacedViews place="beside" machine={machine} thread={thread} frame={withMenuButton('beside', where)} /></div>}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/** The open space, in the sidebar: a view that needs a thread shows the selected one, and nothing without. */
function SpaceView({ view, machine, thread }: { view: View; machine?: MachineEntry; thread?: ThreadInfo }) {
  const Component = view.component as ComponentType<ViewProps>
  if (view.context === 'thread' && !(machine && thread)) return null
  return <Contained name={whose(view)} scope={scopeOfEntry(view)}><Component place="space" {...(machine && thread ? { machine, thread } : {})} /></Contained>
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

/** The app's look, from its settings: fonts, the accent colour and the text size, as CSS variables. */
function useAppearance() {
  const values = useSettings(APP, true)?.values
  const interfaceFont = values?.[INTERFACE_FONT]
  const monoFont = values?.[MONO_FONT]
  const accent = values?.[ACCENT]
  const textSize = values?.[TEXT_SIZE]
  useEffect(() => {
    const style = document.documentElement.style
    const set = (variable: string, family: unknown) => typeof family === 'string' ? style.setProperty(variable, `"${family.replace(/"/g, '')}", var(${variable}-fallback)`) : style.removeProperty(variable)
    set('--superego-font', interfaceFont)
    set('--superego-mono', monoFont)
    // The accent everything takes its colour from (see --superego-accent in @superego/ui's styles); one the browser can't read
    // leaves the default.
    if (typeof accent === 'string' && CSS.supports('color', accent)) style.setProperty('--superego-accent-base', accent)
    else style.removeProperty('--superego-accent-base')
    // The setting's part of the scale: @superego/ui's styles multiply it by the device's (bigger on a phone).
    style.setProperty('--superego-text-size', String(textScale(textSize)))
  }, [interfaceFont, monoFont, accent, textSize])
}

/**
 * Key presses to the actions bound to them, and the shortcuts bound now told to the main process: a page in a pane
 * (a Browser pane's) that has the keyboard gets key presses before this window could, so the main process takes
 * these ones first and hands them back (`app.key`, see useAppEvents). Answers `runKeys`, which runs the action bound
 * to a shortcut, through the same router the palette and other code dispatch through; with two on one shortcut, the
 * first registered wins (Settings → Keyboard shows the clash). It says whether one ran.
 */
function useKeyRouting() {
  const registry = useRegistry()
  const { selection } = useSelection()
  const keymap = useSettings(APP, true)?.values[KEYMAP] as Keymap | undefined
  const current = useRef({ selection, keymap })
  current.current = { selection, keymap }
  const runKeys = useRef((pressed: string) => {
    const { selection, keymap } = current.current
    for (const action of registry.router.all(selection?.machine)) {
      if (runsBare(action) && bound(action, keymap) === pressed && registry.router.offered(action.id)) {
        void registry.router.dispatch(action.id, {}, { source: 'keys' }).catch((error) => console.error(error))
        return true
      }
    }
    return false
  }).current
  const actions = useActions(selection?.machine)
  const boundKeys = [...new Set(actions.filter(runsBare).map((action) => bound(action, keymap)).filter((k): k is string => Boolean(k)))].sort().join(' ')
  useEffect(() => {
    if (window.superego.web) return
    void window.superego.call(APP, 'app.boundKeys', { keys: boundKeys ? boundKeys.split(' ') : [] }).catch(() => {})
  }, [boundKeys])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const pressed = shortcutOf(event)
      if (pressed && runKeys(pressed)) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return runKeys
}

/**
 * What comes from outside the page: the mouse's back and forward buttons, and the app's events (threads and Settings
 * shown from the command line, a notification or the menu bar; keys and swipes the main process caught; the app menu's
 * actions; another client's).
 */
function useAppEvents(runKeys: (pressed: string) => boolean) {
  const registry = useRegistry()
  const { select } = useSelection()
  const { openSettings } = useShell()
  useEffect(() => {
    document.title = registry.app.name
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
      // Another client asks for one of this window's own actions (see perform.ts). On the desktop the main process
      // sends it to the window in front; in a browser every tab hears it, and the ones on screen run it.
      if (event.method === 'client.perform') {
        const asked = document.visibilityState === 'visible' ? performed(event) : undefined
        if (asked && registry.router.router.has(asked.action)) void registry.router.dispatch(asked.action, asked.params, { source: asked.source }).catch((error) => console.error(error))
        return
      }
      if (event.machine !== APP) return
      if (event.method === 'app.select') show({ open: event.params as Selection })
      if (event.method === 'app.settings') show({ settings: true })
      // Pressed while a page in a pane had the keyboard: the main process caught it before the page (see app.boundKeys).
      if (event.method === 'app.key') runKeys((event.params as { keys: string }).keys)
      if (event.method === 'app.go') go((event.params as { by: number }).by)
      // One of the window's actions, from the app's menu (File → New Window).
      if (event.method === 'app.action') void registry.router.dispatch((event.params as { action: string }).action, {}, { source: 'menu' }).catch((error) => console.error(error))
    })
    void (window.superego.call(APP, 'app.ready', {}) as Promise<{ open?: Selection; settings?: boolean }>).then(show)
    // Windows closed for good leave their state behind: dropped here.
    if (!window.superego.web) void (window.superego.call(APP, 'app.windows', {}) as Promise<string[]>).then(forgetWindows, () => {})
    return () => { window.removeEventListener('mousedown', onMouse); window.removeEventListener('mouseup', onMouse); off() }
  }, [])
}
