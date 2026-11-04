// What the shell knows and shares: the machines, every connected machine's sessions (one subscription each, whatever
// number of components show them), which session is selected, and the Settings dialog.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionInfo } from '@mu/protocol'
import type { MachineEntry } from '../shared.ts'
import { has, useMachineList, useSessions as useSessionsWatch } from './client.ts'

export type Selection = { machine: string; session: string }

type ShellState = {
  machines: MachineEntry[]
  sessions: Record<string, SessionInfo[] | undefined>
  selection: Selection | undefined
  select(selection: Selection | undefined): void
  settingsOpen: boolean
  openSettings(open?: boolean): void
}

const Context = createContext<ShellState | undefined>(undefined)

function useShellState(): ShellState {
  const state = useContext(Context)
  if (!state) throw new Error('mu hooks need mountApp')
  return state
}

/** Every machine: this computer and the configured ones, with their connection state. */
export const useMachines = () => useShellState().machines
/** A machine's sessions, newest first; undefined until known (or while it is unreachable and never was). */
export const useSessions = (machine: string) => useShellState().sessions[machine]
/** Every machine's sessions, by machine id. */
export const useAllSessions = () => useShellState().sessions
/** The selected session, and a way to select another (or none). */
export function useSelection() {
  const { selection, select, machines, sessions } = useShellState()
  const machine = machines.find((m) => m.id === selection?.machine)
  const session = selection && sessions[selection.machine]?.find((s) => s.id === selection.session)
  return { selection, select, machine, session }
}
/** The shell's own actions. */
export function useShell() {
  const { openSettings } = useShellState()
  return { openSettings: () => openSettings(true) }
}

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const machines = useMachineList()
  const [sessions, setSessions] = useState<Record<string, SessionInfo[] | undefined>>({})
  const [selection, setSelection] = useState<Selection>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const onSessions = useCallback((machine: string, list: SessionInfo[] | undefined) => setSessions((all) => all[machine] === list ? all : { ...all, [machine]: list }), [])
  const value = useMemo<ShellState>(() => ({
    machines, sessions, selection, settingsOpen,
    select: (next) => { setSettingsOpen(false); setSelection(next) },
    openSettings: (open = true) => setSettingsOpen(open),
  }), [machines, sessions, selection, settingsOpen])
  return (
    <Context.Provider value={value}>
      {machines.filter((m) => m.state !== 'disabled').map((m) => <MachineSessions key={m.id} machine={m} onSessions={onSessions} />)}
      {children}
    </Context.Provider>
  )
}

/** One sessions subscription per machine, kept while it is connected; the last list stays while it isn't. */
function MachineSessions({ machine, onSessions }: { machine: MachineEntry; onSessions(machine: string, list: SessionInfo[] | undefined): void }) {
  const sessions = useSessionsWatch(machine.id, machine.state === 'connected' && has(machine, 'sessions'))
  useEffect(() => { if (sessions) onSessions(machine.id, sessions) }, [sessions])
  return null
}

/** For the shell: whether the Settings dialog is open, and closing it. */
export function useSettingsDialog() {
  const { settingsOpen, openSettings } = useShellState()
  return { open: settingsOpen, close: () => openSettings(false) }
}
