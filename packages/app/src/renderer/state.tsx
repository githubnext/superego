// What the shell knows and shares: the machines, every connected machine's threads (one subscription each, whatever
// number of components show them), which thread is selected, and the Settings dialog; those two kept in the window
// across reloads; and where the window has been, to go back and forward.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AUTH_REJECTED, DATA_VIEWS, GLOBAL_PROFILES, PROFILES_ALLOWED, type Json, type ProfileRef, type ProviderRejection, type ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import { has, machine as client, useAppSetting, useHiddenThreads, useMachineList, useThreads as useThreadsWatch, useValue } from './client.ts'
import { checkDataViews, warnDropped } from './data-view-check.ts'
import { clearProblem, reportProblem } from './machine-problems.ts'
import { useRegistry } from './registry.tsx'
import { spaceFor } from './lookups.ts'
import { useImageRechecks } from './images.tsx'
import { useGlobalProfileUis, useListedProfileUis } from './profile-ui.ts'
import { emptyHistory, sameSpace, step, visit, type History, type Place, type SpaceAt } from './history.ts'
import { useLocalState } from './local-state.ts'
import { focusProvider } from './provider-focus.ts'
import { useWindowEvents } from './window-events.ts'
import { Notifications } from './notifications.tsx'
import { freeze, pinnedFirst, projectKey, stillFolded, useProjectList, wayTo, type Project, type Sidebar } from './projects.ts'
import { PINS, pinsOf, SHOW_PINNED, stillListed, type Pin } from './pins.ts'
import { sidebarIsHidden, showSidebar, type SidebarMode } from './sidebar-mode.ts'
import { TIGHT, useMedia } from './media.ts'
import { GENERAL } from './settings/tabs.ts'
import { pruneWebViews } from './kept-web-views.ts'

/** The thread the window shows: its machine's id and its own. */
export type Selection = { machine: string; thread: string }

/**
 * Where the New thread dialog starts: a machine and folder, and what else to start with (`options`: its extensions'
 * fields, by extension). Empty, it takes after the thread shown.
 */
export type NewThreadStart = { machine?: string; cwd?: string; profile?: string; model?: string; thinking?: string; options?: Record<string, Json> }

type ShellState = {
  machines: MachineEntry[]
  threads: Record<string, ThreadInfo[] | undefined>
  /** Each connected machine's providers that rejected its credentials (`auth.rejected`); undefined until it says. */
  rejections: Record<string, ProviderRejection[] | undefined>
  selection: Selection | undefined
  select(selection: Selection | undefined): void
  settingsOpen: boolean
  /** Whether Settings was opened at a tab of its own asking (a machine's Providers), not as it was left: on a phone it
   * then opens on that tab, not on its list of them. */
  settingsAtTab: boolean
  openSettings(open?: boolean, atTab?: boolean): void
  /** The tab Settings shows (see settings/tabs.ts), kept from last time. */
  settingsTarget: string
  setSettingsTarget(target: string): void
  newThread: NewThreadStart | undefined
  openNewThread(start?: NewThreadStart | false): void
  /** On a phone, the thread's sheet (thread-sheet.tsx): open or not, and for which thread (left out: the selected one). */
  threadSheet: { open: boolean; at?: Selection | undefined }
  openThreadSheet(open: boolean, at?: Selection): void
  /** Every project, in the sidebar's order; held still while `hold` says so. */
  projects: Project[]
  /** What the sidebar lists: the pinned threads, then the projects with the rest. */
  sidebar: Sidebar
  /** The threads pinned, in their order, as the app setting has them (listed or not). */
  pins: Pin[]
  /** Hold the order still (the pointer is over the sidebar), or let it follow activity again. */
  hold(held: boolean): void
  /** Fold sections or threads in the sidebar (see projects.ts's `fold`), or unfold them. */
  fold(keys: readonly string[], folded: boolean): void
  /** The thread last shown in a project, by its key. */
  lastThread: Record<string, string>
  /** Whether the sidebar is hidden (see sidebar-mode.ts). */
  sidebarHidden: boolean
  /** Show the sidebar (`open`), or hide it; left out, the other way. */
  showSidebar(open?: boolean): void
  /** The selected thread when it's archived (the machine's list leaves those out): fetched once it's selected. */
  archived: ThreadInfo | undefined
  /** The selected machine's threads that no list shows (extensions' own, like Ego's): shown when selected. */
  hidden: ThreadInfo[] | undefined
  /** Every machine's, by machine id. */
  hiddenAll: Record<string, ThreadInfo[] | undefined>
  /** The listed thread last selected: where the sidebars go back to from a hidden one (Ego's). */
  listed: Selection | undefined
  /** The space the main area shows instead of the selected thread, if one is open. */
  space: SpaceAt | undefined
  /** Open a space (none: back to the selected thread). */
  openSpace(space: SpaceAt | undefined): void
  /** The thread docked to each space, by `spaceKey`. */
  docked: Record<string, Selection>
  dock(space: SpaceAt, thread: Selection | undefined): void
  /** Dock `to` to every space `from` is docked to. */
  redock(from: Selection, to: Selection): void
  /** What each space says it's called now (`useSpaceTitle`), by `spaceKey`. */
  spaceTitles: Record<string, string>
  titleSpace(space: SpaceAt, title: string | undefined): void
  /** Whether spaces show their thread (docked or floating), or hide it. */
  spaceAgent: boolean
  showSpaceAgent(shown?: boolean): void
  canBack: boolean
  canForward: boolean
  go(by: -1 | 1): void
}

const Context = createContext<ShellState | undefined>(undefined)

function useShellState(): ShellState {
  const state = useContext(Context)
  if (!state) throw new Error('superego hooks need mountApp')
  return state
}

/** Every machine: this computer and the configured ones, with their connection state. */
export const useMachines = () => useShellState().machines
/** A machine's threads, newest first; undefined until known (or while it is unreachable and never was). */
export const useThreads = (machine: string) => useShellState().threads[machine]
/** Every machine's threads, by machine id. */
export const useAllThreads = () => useShellState().threads
/** A machine's threads that no list shows (extensions' own, like Ego's). */
export const useHidden = (machine: string) => useShellState().hiddenAll[machine]
/** Each machine's providers that rejected its credentials, by machine. */
export const useRejections = () => useShellState().rejections
/** The selected thread, and a way to select another (or none). */
export function useSelection() {
  const { selection, select, machines, threads, archived, hidden, listed } = useShellState()
  const machine = machines.find((m) => m.id === selection?.machine)
  const own = selection && hidden?.find((t) => t.id === selection.thread)
  const thread = selection && (threads[selection.machine]?.find((s) => s.id === selection.thread)
    ?? (archived?.id === selection.thread ? archived : undefined)
    ?? own)
  /** `hidden`: the thread is one no list shows (an extension's own, like Ego's). `listed`: the listed one last selected. */
  return { selection, select, machine, thread, hidden: Boolean(own), listed }
}
/**
 * Every project, in the sidebar's order, and the thread last shown in each; `sidebar`, what it lists: the pinned
 * threads, then the projects with the rest; `pins`, the threads pinned.
 */
export function useProjects() {
  const { projects, sidebar, pins, lastThread, hold } = useShellState()
  return { projects, sidebar, pins, lastThread, hold }
}
/** Fold sections or threads in the sidebar, by their keys (projects.ts's `fold`), or unfold them; `useProjects().sidebar.folded` has what's folded. */
export const useFold = () => useShellState().fold
/** Whether the sidebar is hidden, and a way to show or hide it (`show()` the other way). */
export function useSidebar() {
  const { sidebarHidden, showSidebar } = useShellState()
  return { hidden: sidebarHidden, show: showSidebar }
}
/** What a space is known by, for the thread docked to it. */
export const spaceKey = (space: SpaceAt) => `${space.machine}\u0000${space.project ? `${space.project}\u0000` : ''}${space.kind}\u0000${JSON.stringify(space.params)}`

/**
 * The space the main area shows, if one is open; how to open one (or none); the thread docked to it, and whether
 * its thread shows.
 */
export function useSpace() {
  const { space, openSpace, docked, dock, redock, spaceAgent, showSpaceAgent, spaceTitles, titleSpace } = useShellState()
  return {
    space, open: openSpace,
    /** What `at` (the open one, unless given) says it's called, if it has said. */
    titleOf: (at = space) => at ? spaceTitles[spaceKey(at)] : undefined,
    setTitle: titleSpace,
    docked: space ? docked[spaceKey(space)] : undefined,
    dock: (thread: Selection | undefined) => { if (space) dock(space, thread) },
    redock,
    agentShown: spaceAgent, showAgent: showSpaceAgent,
  }
}

/** Back and forward through the threads (and Settings) this window has shown. */
export function useHistory() {
  const { canBack, canForward, go } = useShellState()
  return { canBack, canForward, back: () => go(-1), forward: () => go(1) }
}
/** On a phone, the thread's sheet: whether it's open, for which thread (undefined: the selected one), and opening it. */
export function useThreadSheet() {
  const { threadSheet, openThreadSheet } = useShellState()
  return [threadSheet, openThreadSheet] as const
}
/** The shell's own actions. */
export function useShell() {
  const { openSettings, openNewThread, setSettingsTarget, openThreadSheet } = useShellState()
  return {
    /** Settings: at a tab (its target, see settings/tabs.ts), or as it was left. */
    openSettings: (at?: string) => {
      if (at !== undefined) setSettingsTarget(at)
      openSettings(true, at !== undefined)
    },
    /** Settings, on a machine's Providers, at `provider`: to sign in to it again. */
    signIn: (machine: string, provider: string) => {
      setSettingsTarget(machine)
      focusProvider(machine, provider)
      openSettings(true, true)
    },
    /** Settings, on a machine's Providers. */
    providers: (machine: string) => {
      setSettingsTarget(machine)
      focusProvider(machine, '')
      openSettings(true, true)
    },
    /** The New thread dialog, optionally starting on a machine or folder. */
    newThread: (start: NewThreadStart = {}) => openNewThread(start),
    /** On a phone, a thread's sheet: what its title bar holds and what can be done with it (the selected thread's, left out). */
    threadMenu: (at?: Selection) => openThreadSheet(true, at),
  }
}

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const machines = useMachineList()
  const [threads, setThreads] = useState<Record<string, ThreadInfo[] | undefined>>({})
  // Which thread and whether Settings is open: as the window was left, after a reload too.
  const [selection, setSelection] = useLocalState<Selection | undefined>('selection', undefined)
  const [settingsOpen, setSettingsOpen] = useLocalState('settings.open', false)
  // The space shown instead of the thread, the thread docked to each, and whether their threads show.
  const [space, setSpace] = useLocalState<SpaceAt | undefined>('space.open', undefined)
  const [docked, setDocked] = useLocalState<Record<string, Selection>>('space.docked', {})
  const [spaceAgent, setSpaceAgent] = useLocalState('space.agent', true)
  const [spaceTitles, setSpaceTitles] = useLocalState<Record<string, string>>('space.titles', {})
  const [settingsTarget, setSettingsTarget] = useLocalState('settings.target', GENERAL)
  const [settingsAtTab, setSettingsAtTab] = useState(false)
  const [newThread, setNewThread] = useState<NewThreadStart>()
  const [threadSheet, setThreadSheet] = useState<ShellState['threadSheet']>({ open: false })
  const [sidebarOpen, setSidebarOpen] = useLocalState('sidebar.open', true)
  const [sidebarShownTight, setSidebarShownTight] = useState(false)
  const tight = useMedia(TIGHT)
  useEffect(() => { if (!tight) setSidebarShownTight(false) }, [tight])
  const sidebarMode: SidebarMode = { open: sidebarOpen, shownTight: sidebarShownTight }
  const onThreads = useCallback((machine: string, list: ThreadInfo[] | undefined) => {
    setThreads((all) => all[machine] === list ? all : { ...all, [machine]: list })
  }, [])
  // Every machine's hidden threads (extensions' own, like Ego's), followed live: one is shown while it's selected, and
  // back and forward reach it, on whichever machine it is.
  const [hiddenAll, setHidden] = useState<Record<string, ThreadInfo[] | undefined>>({})
  const onHidden = useCallback((machine: string, list: ThreadInfo[] | undefined) => {
    setHidden((all) => all[machine] === list ? all : { ...all, [machine]: list })
  }, [])
  const [rejections, setRejections] = useState<Record<string, ProviderRejection[] | undefined>>({})
  const onRejections = useCallback((machine: string, list: ProviderRejection[] | undefined) => {
    setRejections((all) => all[machine] === list ? all : { ...all, [machine]: list })
  }, [])
  useImageRechecks(threads)
  // One order for the sidebar and everything that walks it (⌘⇧[ ⌘⇧], the navigator): held, a thread changing state
  // doesn't move under the pointer, nor out from under the next press.
  const live = useProjectList(machines, threads)
  const [held, hold] = useState(false)
  const frozen = useRef(live)
  if (!held) frozen.current = live
  const projects = useMemo(() => held ? freeze(frozen.current, live) : live, [held, live])
  // Pinned threads go to the top, in the order they were pinned; one no longer listed (archived) leaves the pins.
  const [pinsValue, setPins] = useAppSetting<Pin[]>(PINS)
  const pins = useMemo(() => pinsOf(pinsValue), [pinsValue])
  // Sections and threads folded, as this window was left.
  const [folded, setFolded] = useLocalState<string[]>('sidebar.folded', [])
  // The Pinned section may be hidden: they still top their projects.
  const [showPinned] = useAppSetting<boolean>(SHOW_PINNED)
  const sidebar = useMemo(() => {
    const all = pinnedFirst(projects, pins, folded)
    return showPinned === false ? { ...all, pinned: [] } : all
  }, [projects, pins, folded, showPinned])
  const fold = useCallback((keys: readonly string[], on: boolean) => setFolded((all) =>
    on ? [...all, ...keys.filter((key) => !all.includes(key))] : all.filter((key) => !keys.includes(key))), [])
  useEffect(() => {
    const kept = stillListed(pins, machines, threads)
    if (kept.length < pins.length) void setPins(kept).catch((error) => console.error('Unpinning archived threads', error))
  }, [pins, machines, threads])
  // A fold of a thread or project no longer listed (archived) goes.
  useEffect(() => {
    const kept = stillFolded(folded, live, machines, threads)
    if (kept.length < folded.length) setFolded(kept)
  }, [folded, live, machines, threads])
  // Each project remembers the thread last shown in it: going back to the project goes back to that thread.
  const [lastThread, setLastThread] = useLocalState<Record<string, string>>('projects.last', {})
  const shown = selection && threads[selection.machine]?.find((t) => t.id === selection.thread)
  const shownKey = shown && projectKey(selection!.machine, shown.project.root)
  useEffect(() => {
    if (shownKey && lastThread[shownKey] !== shown!.id) setLastThread((last) => ({ ...last, [shownKey]: shown!.id }))
  }, [shownKey, shown?.id])
  const [listed, setListed] = useLocalState<Selection | undefined>('selection.listed', undefined)
  useEffect(() => {
    if (shown && (listed?.machine !== selection!.machine || listed.thread !== shown.id)) setListed({ machine: selection!.machine, thread: shown.id })
  }, [selection?.machine, shown?.id])
  // Selecting a thread (from the sidebar, the navigator, a notification) unfolds the way to it, once: folded again
  // after, it stays selected, out from under the fold. The one selected as the window opens is where it was left.
  const unfoldedFor = useRef(selection && `${selection.machine}/${selection.thread}`)
  useEffect(() => {
    const key = selection && `${selection.machine}/${selection.thread}`
    if (!key || unfoldedFor.current === key || !shown) return
    unfoldedFor.current = key
    const way = wayTo(sidebar, selection!)
    if (way.length) fold(way, false)
  }, [selection?.machine, selection?.thread, shown, sidebar])
  // A selected thread that isn't in its machine's list may be archived: shown from the archived list, read only.
  // Asked again when the list changes (archiving or unarchiving moves threads between the two).
  const [archived, setArchived] = useState<ThreadInfo>()
  const list = selection ? threads[selection.machine] : undefined
  const selectedMachine = machines.find((m) => m.id === selection?.machine)
  const hidden = selection ? hiddenAll[selection.machine] : undefined
  const isHidden = Boolean(selection && hidden?.some((t) => t.id === selection.thread))
  useEffect(() => {
    if (!selection || !list || shown || isHidden || selectedMachine?.state !== 'connected') return setArchived(undefined)
    let alive = true
    void (window.superego.call(selection.machine, 'thread.list', { archived: true }) as Promise<ThreadInfo[]>)
      .then((all) => { if (alive) setArchived(all.find((t) => t.id === selection.thread)) }, () => {})
    return () => { alive = false }
  }, [selection?.machine, selection?.thread, list, Boolean(shown), isHidden, selectedMachine?.state])
  // A pane's kept web page (kept-web-views.ts) goes as the pane closes or its thread is archived; on a machine whose
  // threads aren't known (yet, or while it's away), it stays.
  useEffect(() => pruneWebViews(({ machine, thread, pane }) => {
    const found = threads[machine]?.find((t) => t.id === thread) ?? hiddenAll[machine]?.find((t) => t.id === thread)
      ?? (archived?.id === thread ? archived : undefined)
    if (found) return Boolean(found.panes?.some((p) => p.id === pane))
    return threads[machine] && hiddenAll[machine] ? false : undefined
  }), [threads, hiddenAll, archived])
  // History: every place shown is visited, whoever showed it; back and forward move along it first, so showing what
  // they went to is where history already is. Threads no longer listed (archived, deleted) are stepped over; hidden
  // ones are listed, on every machine.
  // What extensions hear of it (`superego.on`): statuses changing, the thread shown, the window's focus.
  const registry = useRegistry()
  useWindowEvents(registry, {
    machines, threads, rejections, selection,
    hidden: hiddenAll,
    shown: shown ?? (archived?.id === selection?.thread ? archived : undefined) ?? hidden?.find((t) => t.id === selection?.thread),
  })
  const [history, setHistory] = useState<History>(emptyHistory)
  const place: Place | undefined = settingsOpen ? { settings: true } : space ? { space }
    : selection ? { thread: { machine: selection.machine, thread: selection.thread } } : undefined
  useEffect(() => { if (place) setHistory((h) => visit(h, place)) }, [settingsOpen, selection?.machine, selection?.thread, space && JSON.stringify(space)])
  const exists = (p: Place) => 'settings' in p || ('space' in p ? Boolean(spaceFor(registry, p.space))
    : Boolean(hiddenAll[p.thread.machine]?.some((t) => t.id === p.thread.thread)) || Boolean(threads[p.thread.machine]?.some((t) => t.id === p.thread.thread)))
  const value = useMemo<ShellState>(() => ({
    machines, threads, rejections, selection, settingsOpen, settingsAtTab, newThread, projects, sidebar, pins, hold, fold, lastThread, sidebarHidden: sidebarIsHidden(sidebarMode, tight), archived, hidden, hiddenAll, listed,
    canBack: Boolean(step(history, -1, place, exists)),
    canForward: Boolean(step(history, 1, place, exists)),
    go: (by) => {
      const to = step(history, by, place, exists)
      if (!to) return
      setHistory(to.history)
      setNewThread(undefined)
      if ('settings' in to.place) return setSettingsOpen(true)
      setSettingsOpen(false)
      if ('space' in to.place) return setSpace(to.place.space)
      setSpace(undefined)
      setSelection(to.place.thread)
    },
    select: (next) => { setSettingsOpen(false); setNewThread(undefined); setSpace(undefined); setSelection(next) },
    space, docked, spaceAgent,
    openSpace: (next) => {
      setSettingsOpen(false)
      setNewThread(undefined)
      setSpace((was) => sameSpace(was, next) ? was : next)
    },
    dock: (at, thread) => setDocked((all) => {
      const { [spaceKey(at)]: _, ...rest } = all
      return thread ? { ...rest, [spaceKey(at)]: thread } : rest
    }),
    redock: (from, to) => setDocked((all) => Object.values(all).some((at) => at.machine === from.machine && at.thread === from.thread)
      ? Object.fromEntries(Object.entries(all).map(([key, at]) => [key, at.machine === from.machine && at.thread === from.thread ? to : at]))
      : all),
    showSpaceAgent: (shown) => setSpaceAgent((was) => shown ?? !was),
    spaceTitles,
    titleSpace: (at, title) => setSpaceTitles((all) => {
      const key = spaceKey(at)
      if (all[key] === title) return all
      const { [key]: _, ...rest } = all
      return title ? { ...rest, [key]: title } : rest
    }),
    openSettings: (open = true, atTab = false) => { setSettingsOpen(open); setSettingsAtTab(open && atTab) },
    settingsTarget,
    setSettingsTarget,
    openNewThread: (start = {}) => setNewThread(start === false ? undefined : start),
    threadSheet,
    // Closed, it keeps its thread: the sheet still shows it as it slides away.
    openThreadSheet: (open, at) => setThreadSheet((was) => open ? { open, at } : { ...was, open }),
    showSidebar: (open) => {
      const next = showSidebar(sidebarMode, tight, open)
      setSidebarOpen(next.open)
      setSidebarShownTight(next.shownTight)
    },
  }), [machines, threads, rejections, selection, settingsOpen, settingsAtTab, settingsTarget, newThread, projects, sidebar, pins, lastThread, sidebarOpen, sidebarShownTight, tight, archived, hidden, hiddenAll, history, listed, threadSheet, space, docked, spaceAgent, spaceTitles, registry.version])
  return (
    <Context.Provider value={value}>
      {machines.filter((m) => m.state !== 'disabled').map((m) => <MachineThreads key={m.id} machine={m} onThreads={onThreads} onHidden={onHidden} onRejections={onRejections} />)}
      <Notifications />
      {children}
    </Context.Provider>
  )
}

/** One threads subscription per machine, kept while it is connected; the last list stays while it isn't. */
function MachineThreads({ machine, onThreads, onHidden, onRejections }: {
  machine: MachineEntry; onThreads(machine: string, list: ThreadInfo[] | undefined): void; onHidden(machine: string, list: ThreadInfo[] | undefined): void
  onRejections(machine: string, list: ProviderRejection[] | undefined): void
}) {
  const connected = machine.state === 'connected'
  // What it offers, to follow as it changes: its features and extensions, each at its version.
  const offered = JSON.stringify([machine.features, machine.extensions])
  const threads = useThreadsWatch(machine.id, connected)
  const hidden = useHiddenThreads(machine.id, connected)
  useEffect(() => { if (hidden) onHidden(machine.id, hidden) }, [hidden])
  const rejected = useValue<ProviderRejection[]>(machine, AUTH_REJECTED)
  useEffect(() => { onRejections(machine.id, rejected ?? undefined) }, [rejected])
  // What the machine offers, for the palette and for routing thread actions.
  const registry = useRegistry()
  const { router, extensions } = registry
  // Its data views, but those of extensions switched off there; gone with it.
  // Checked here, not taken on the machine's word: only what can be a view of one of its extensions (data-view-check.ts).
  const views = useValue<unknown>(machine, DATA_VIEWS)
  const on = useMemo(() => {
    const { views: on, dropped } = checkDataViews(views, (extension) => has(machine, `ext:${extension}`))
    warnDropped(machine.id, 'view.list', dropped)
    return on
  }, [views, offered])
  useEffect(() => { registry.setDataViews(machine.id, on) }, [JSON.stringify(on)])
  useEffect(() => () => registry.setDataViews(machine.id, []), [])
  // Its extensions at their versions: the UI halves draw for its threads only where they speak with them.
  useEffect(() => { registry.setMachineExtensions(machine.id, machine.extensions ?? []) }, [offered])
  useEffect(() => () => registry.setMachineExtensions(machine.id, []), [])
  // Again when what it offers changes: a profile's extensions bring actions of their own.
  useEffect(() => { if (connected) void router.load(machine.id) }, [machine.state, machine.machine?.id, offered])
  useEffect(() => { if (threads) onThreads(machine.id, threads) }, [threads])
  // Its listed threads' profiles' UI, loaded before any of them is shown: their marks in the sidebar, say.
  useListedProfileUis(machine.id, connected, threads, useValue<unknown>(machine, PROFILES_ALLOWED))
  // Its global profiles' UI, as the app's: their sidebars and spaces are there whatever threads there are.
  useGlobalProfileUis(machine.id, connected, useValue<ProfileRef[]>(machine, GLOBAL_PROFILES))
  // The window's extensions, told to the machine: one whose work is all here is known there too (Settings, `without`).
  useEffect(() => {
    if (!connected) return
    const what = "Telling it this window's extensions"
    void client(machine.id).call('extension.declare', { extensions }).then(() => clearProblem(machine.id, what), (error) => reportProblem(machine.id, what, error))
  }, [machine.state, machine.machine?.id])
  return null
}

/** For the shell: whether the New thread dialog is open, where it starts, and closing it. */
export function useNewThreadDialog() {
  const { newThread, openNewThread } = useShellState()
  return { start: newThread, close: () => openNewThread(false) }
}

/** For the shell: whether Settings is open (a pane beside the rail; a dialog on a phone), and closing it. */
export function useSettingsDialog() {
  const { settingsOpen, settingsAtTab, openSettings } = useShellState()
  return { open: settingsOpen, atTab: settingsAtTab, close: () => openSettings(false) }
}

/** For Settings: the tab it shows (its target, see settings/tabs.ts), as kept, and going to another. */
export function useSettingsTarget(): [string, (target: string) => void] {
  const { settingsTarget, setSettingsTarget } = useShellState()
  return [settingsTarget, setSettingsTarget]
}
