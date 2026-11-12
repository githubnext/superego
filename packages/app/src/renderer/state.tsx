// What the shell knows and shares: the machines, every connected machine's threads (one subscription each, whatever
// number of components show them), which thread is selected, and the Settings dialog; those two kept in the window
// across reloads.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import { has, useEgo, useMachineList, useThreads as useThreadsWatch } from './client.ts'
import { useRegistry } from './extension.tsx'
import { useLocalState } from './local-state.ts'
import { sessionKey, useSessionList, type Session } from './sessions.ts'

export type Selection = { machine: string; thread: string }

/** Where the New thread dialog starts: a machine and folder, and what else to start with. Empty, it takes after the thread shown. */
export type NewThreadStart = { machine?: string; cwd?: string; profile?: string; model?: string; thinking?: string; worktree?: boolean }

type ShellState = {
  machines: MachineEntry[]
  threads: Record<string, ThreadInfo[] | undefined>
  selection: Selection | undefined
  select(selection: Selection | undefined): void
  settingsOpen: boolean
  openSettings(open?: boolean): void
  newThread: NewThreadStart | undefined
  openNewThread(start?: NewThreadStart | false): void
  /** Every session, in the sidebar's order. */
  sessions: Session[]
  /** The thread last shown in a session, by its key. */
  lastThread: Record<string, string>
  sidebarOpen: boolean
  toggleSidebar(open?: boolean): void
  /** The selected thread when it's archived (the machine's list leaves those out): fetched once it's selected. */
  archived: ThreadInfo | undefined
  /** Ego's thread on this computer, which no list has (see `thread.meta`): shown when selected, from its rail button. */
  ego: ThreadInfo | undefined
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
/** The selected thread, and a way to select another (or none). */
export function useSelection() {
  const { selection, select, machines, threads, archived, ego } = useShellState()
  const machine = machines.find((m) => m.id === selection?.machine)
  const thread = selection && (threads[selection.machine]?.find((s) => s.id === selection.thread)
    ?? (archived?.id === selection.thread ? archived : undefined)
    ?? (selection.machine === 'local' && ego?.id === selection.thread ? ego : undefined))
  return { selection, select, machine, thread }
}
/** Every session, in the sidebar's order, and the thread last shown in each. */
export function useSessions() {
  const { sessions, lastThread } = useShellState()
  return { sessions, lastThread }
}
/** Whether the sidebar is open, and a way to open or close it. */
export function useSidebar() {
  const { sidebarOpen, toggleSidebar } = useShellState()
  return { open: sidebarOpen, toggle: toggleSidebar }
}
/** The shell's own actions. */
export function useShell() {
  const { openSettings, openNewThread } = useShellState()
  return {
    openSettings: () => openSettings(true),
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
  const onThreads = useCallback((machine: string, list: ThreadInfo[] | undefined) => setThreads((all) => all[machine] === list ? all : { ...all, [machine]: list }), [])
  const sessions = useSessionList(machines, threads)
  // Each session remembers the thread last shown in it: going back to the session goes back to that thread.
  const [lastThread, setLastThread] = useLocalState<Record<string, string>>('sessions.last', {})
  const shown = selection && threads[selection.machine]?.find((t) => t.id === selection.thread)
  const shownKey = shown && sessionKey(selection!.machine, shown.session?.root ?? shown.cwd)
  useEffect(() => {
    if (shownKey && lastThread[shownKey] !== shown!.id) setLastThread((last) => ({ ...last, [shownKey]: shown!.id }))
  }, [shownKey, shown?.id])
  // A selected thread that isn't in its machine's list may be archived: shown from the archived list, read only.
  // Asked again when the list changes (archiving or unarchiving moves threads between the two).
  const [archived, setArchived] = useState<ThreadInfo>()
  const list = selection ? threads[selection.machine] : undefined
  const selectedMachine = machines.find((m) => m.id === selection?.machine)
  const local = machines.find((m) => m.id === 'local')
  const ego = useEgo('local', local?.state === 'connected' && has(local, 'ego')) ?? undefined
  const isEgo = selection?.machine === 'local' && selection.thread === ego?.id
  useEffect(() => {
    if (!selection || !list || shown || isEgo || selectedMachine?.state !== 'connected') return setArchived(undefined)
    let alive = true
    void (window.superego.call(selection.machine, 'thread.list', { archived: true }) as Promise<ThreadInfo[]>)
      .then((all) => { if (alive) setArchived(all.find((t) => t.id === selection.thread)) }, () => {})
    return () => { alive = false }
  }, [selection?.machine, selection?.thread, list, Boolean(shown), isEgo, selectedMachine?.state])
  const value = useMemo<ShellState>(() => ({
    machines, threads, selection, settingsOpen, newThread, sessions, lastThread, sidebarOpen, archived, ego,
    select: (next) => { setSettingsOpen(false); setNewThread(undefined); setSelection(next) },
    openSettings: (open = true) => setSettingsOpen(open),
    openNewThread: (start = {}) => setNewThread(start === false ? undefined : start),
    toggleSidebar: (open) => setSidebarOpen((was) => open ?? !was),
  }), [machines, threads, selection, settingsOpen, newThread, sessions, lastThread, sidebarOpen, archived, ego])
  return (
    <Context.Provider value={value}>
      {machines.filter((m) => m.state !== 'disabled').map((m) => <MachineThreads key={m.id} machine={m} onThreads={onThreads} />)}
      {children}
    </Context.Provider>
  )
}

/** One threads subscription per machine, kept while it is connected; the last list stays while it isn't. */
function MachineThreads({ machine, onThreads }: { machine: MachineEntry; onThreads(machine: string, list: ThreadInfo[] | undefined): void }) {
  const threads = useThreadsWatch(machine.id, machine.state === 'connected' && has(machine, 'threads'))
  // What the machine offers, for the palette and for routing thread actions.
  const { router } = useRegistry()
  useEffect(() => { if (machine.state === 'connected' && has(machine, 'actions')) void router.load(machine.id) }, [machine.state, machine.machine?.id])
  useEffect(() => { if (threads) onThreads(machine.id, threads) }, [threads])
  return null
}

/** For the shell: whether the New thread dialog is open, where it starts, and closing it. */
export function useNewThreadDialog() {
  const { newThread, openNewThread } = useShellState()
  return { start: newThread, close: () => openNewThread(false) }
}

/** For the shell: whether the Settings dialog is open, and closing it. */
export function useSettingsDialog() {
  const { settingsOpen, openSettings } = useShellState()
  return { open: settingsOpen, close: () => openSettings(false) }
}
