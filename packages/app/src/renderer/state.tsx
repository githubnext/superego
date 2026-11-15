// What the shell knows and shares: the machines, every connected machine's threads (one subscription each, whatever
// number of components show them), which thread is selected, and the Settings dialog; those two kept in the window
// across reloads; and where the window has been, to go back and forward.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AUTH_REJECTED, DATA_VIEWS, type Json, type ProviderRejection, type ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import { has, machine as client, useHiddenThreads, useMachineList, useThreads as useThreadsWatch, useValue } from './client.ts'
import { checkDataViews, warnDropped } from './data-view-check.ts'
import { useRegistry } from './extension.tsx'
import { useImageRechecks } from './images.tsx'
import { emptyHistory, step, visit, type History, type Place } from './history.ts'
import { setLocalState, useLocalState } from './local-state.ts'
import { focusProvider } from './provider-focus.ts'
import { useWindowEvents } from './window-events.ts'
import { freeze, sessionKey, useSessionList, type Session } from './sessions.ts'

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
  openSettings(open?: boolean): void
  newThread: NewThreadStart | undefined
  openNewThread(start?: NewThreadStart | false): void
  /** Every session, in the sidebar's order; held still while `hold` says so. */
  sessions: Session[]
  /** Hold the order still (the pointer is over the sidebar), or let it follow activity again. */
  hold(held: boolean): void
  /** The thread last shown in a session, by its key. */
  lastThread: Record<string, string>
  sidebarOpen: boolean
  toggleSidebar(open?: boolean): void
  /** The selected thread when it's archived (the machine's list leaves those out): fetched once it's selected. */
  archived: ThreadInfo | undefined
  /** The selected machine's threads that no list shows (extensions' own, like Ego's): shown when selected. */
  hidden: ThreadInfo[] | undefined
  /** The listed thread last selected: where the sidebar's spaces go back to from a hidden one (Ego's). */
  listed: Selection | undefined
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
/** Every session, in the sidebar's order, and the thread last shown in each. */
export function useSessions() {
  const { sessions, lastThread, hold } = useShellState()
  return { sessions, lastThread, hold }
}
/** Whether the sidebar is open, and a way to open or close it. */
export function useSidebar() {
  const { sidebarOpen, toggleSidebar } = useShellState()
  return { open: sidebarOpen, toggle: toggleSidebar }
}
/** Back and forward through the threads (and Settings) this window has shown. */
export function useHistory() {
  const { canBack, canForward, go } = useShellState()
  return { canBack, canForward, back: () => go(-1), forward: () => go(1) }
}
/** The shell's own actions. */
export function useShell() {
  const { openSettings, openNewThread } = useShellState()
  return {
    openSettings: () => openSettings(true),
    /** Settings, on a machine's Providers, at `provider`: to sign in to it again. */
    signIn: (machine: string, provider: string) => {
      setLocalState('settings.target', machine, 'app')
      focusProvider(machine, provider)
      openSettings(true)
    },
    /** The New thread dialog, optionally starting on a machine or folder. */
    newThread: (start: NewThreadStart = {}) => openNewThread(start),
  }
}

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const machines = useMachineList()
  const [threads, setThreads] = useState<Record<string, ThreadInfo[] | undefined>>({})
  // Which thread and whether Settings is open: as the window was left, after a reload too.
  const [selection, setSelection] = useLocalState<Selection | undefined>('selection', undefined)
  const [settingsOpen, setSettingsOpen] = useLocalState('settings.open', false)
  const [newThread, setNewThread] = useState<NewThreadStart>()
  const [sidebarOpen, setSidebarOpen] = useLocalState('sidebar.open', true)
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
  const live = useSessionList(machines, threads)
  const [held, hold] = useState(false)
  const frozen = useRef(live)
  if (!held) frozen.current = live
  const sessions = useMemo(() => held ? freeze(frozen.current, live) : live, [held, live])
  // Each session remembers the thread last shown in it: going back to the session goes back to that thread.
  const [lastThread, setLastThread] = useLocalState<Record<string, string>>('sessions.last', {})
  const shown = selection && threads[selection.machine]?.find((t) => t.id === selection.thread)
  const shownKey = shown && sessionKey(selection!.machine, shown.session?.root ?? shown.cwd)
  useEffect(() => {
    if (shownKey && lastThread[shownKey] !== shown!.id) setLastThread((last) => ({ ...last, [shownKey]: shown!.id }))
  }, [shownKey, shown?.id])
  const [listed, setListed] = useLocalState<Selection | undefined>('selection.listed', undefined)
  useEffect(() => {
    if (shown && (listed?.machine !== selection!.machine || listed.thread !== shown.id)) setListed({ machine: selection!.machine, thread: shown.id })
  }, [selection?.machine, shown?.id])
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
  // History: every place shown is visited, whoever showed it; back and forward move along it first, so showing what
  // they went to is where history already is. Threads no longer listed (archived, deleted) are stepped over; hidden
  // ones are listed, on every machine.
  // What extensions hear of it (`superego.on`): statuses changing, the thread shown, the window's focus.
  const registry = useRegistry()
  useWindowEvents(registry, {
    threads, rejections, selection,
    hidden: hiddenAll,
    shown: shown ?? (archived?.id === selection?.thread ? archived : undefined) ?? hidden?.find((t) => t.id === selection?.thread),
  })
  const [history, setHistory] = useState<History>(emptyHistory)
  const place: Place | undefined = settingsOpen ? { settings: true } : selection ? { thread: { machine: selection.machine, thread: selection.thread } } : undefined
  useEffect(() => { if (place) setHistory((h) => visit(h, place)) }, [settingsOpen, selection?.machine, selection?.thread])
  const exists = (p: Place) => 'settings' in p || Boolean(hiddenAll[p.thread.machine]?.some((t) => t.id === p.thread.thread))
    || Boolean(threads[p.thread.machine]?.some((t) => t.id === p.thread.thread))
  const value = useMemo<ShellState>(() => ({
    machines, threads, rejections, selection, settingsOpen, newThread, sessions, hold, lastThread, sidebarOpen, archived, hidden, listed,
    canBack: Boolean(step(history, -1, place, exists)),
    canForward: Boolean(step(history, 1, place, exists)),
    go: (by) => {
      const to = step(history, by, place, exists)
      if (!to) return
      setHistory(to.history)
      setNewThread(undefined)
      if ('settings' in to.place) return setSettingsOpen(true)
      setSettingsOpen(false)
      setSelection(to.place.thread)
    },
    select: (next) => { setSettingsOpen(false); setNewThread(undefined); setSelection(next) },
    openSettings: (open = true) => setSettingsOpen(open),
    openNewThread: (start = {}) => setNewThread(start === false ? undefined : start),
    toggleSidebar: (open) => setSidebarOpen((was) => open ?? !was),
  }), [machines, threads, rejections, selection, settingsOpen, newThread, sessions, lastThread, sidebarOpen, archived, hidden, hiddenAll, history, listed])
  return (
    <Context.Provider value={value}>
      {machines.filter((m) => m.state !== 'disabled').map((m) => <MachineThreads key={m.id} machine={m} onThreads={onThreads} onHidden={onHidden} onRejections={onRejections} />)}
      {children}
    </Context.Provider>
  )
}

/** One threads subscription per machine, kept while it is connected; the last list stays while it isn't. */
function MachineThreads({ machine, onThreads, onHidden, onRejections }: {
  machine: MachineEntry; onThreads(machine: string, list: ThreadInfo[] | undefined): void; onHidden(machine: string, list: ThreadInfo[] | undefined): void
  onRejections(machine: string, list: ProviderRejection[] | undefined): void
}) {
  const threads = useThreadsWatch(machine.id, machine.state === 'connected' && has(machine, 'threads'))
  const hidden = useHiddenThreads(machine.id, machine.state === 'connected' && has(machine, 'hidden-threads'))
  useEffect(() => { if (hidden) onHidden(machine.id, hidden) }, [hidden])
  // Null from a daemon that doesn't say (one older than the value): as good as none rejected.
  const rejected = useValue<ProviderRejection[] | null>(machine.id, machine.state === 'connected' && has(machine, 'threads'), AUTH_REJECTED)
  useEffect(() => { onRejections(machine.id, rejected ?? undefined) }, [rejected])
  // What the machine offers, for the palette and for routing thread actions.
  const registry = useRegistry()
  const { router, extensions } = registry
  // Its data views, but those of extensions switched off there; gone with it.
  // Checked here, not taken on the machine's word: only what can be a view of one of its extensions (data-view-check.ts).
  const views = useValue<unknown>(machine.id, machine.state === 'connected' && has(machine, 'data-views'), DATA_VIEWS)
  const on = useMemo(() => {
    const { views: on, dropped } = checkDataViews(views, (extension) => has(machine, `ext:${extension}`))
    warnDropped(machine.id, 'view.list', dropped)
    return on
  }, [views, machine.features?.join()])
  useEffect(() => { registry.setDataViews(machine.id, on) }, [JSON.stringify(on)])
  useEffect(() => () => registry.setDataViews(machine.id, []), [])
  // Again when what it offers changes: a profile's extensions bring actions of their own.
  useEffect(() => { if (machine.state === 'connected' && has(machine, 'actions')) void router.load(machine.id) }, [machine.state, machine.machine?.id, machine.features?.join()])
  useEffect(() => { if (threads) onThreads(machine.id, threads) }, [threads])
  // The window's extensions, told to the machine: one whose work is all here is known there too (Settings, `without`).
  useEffect(() => {
    if (machine.state === 'connected') void client(machine.id).call('extensions.declare', { extensions }).catch(() => { /* an older daemon */ })
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
  const { settingsOpen, openSettings } = useShellState()
  return { open: settingsOpen, close: () => openSettings(false) }
}
