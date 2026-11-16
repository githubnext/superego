// What went wrong between this window and a machine while it was connected: telling it the window's extensions,
// fetching its actions. Said on the console and on the machine's row in Settings → Machines, until the same thing next
// goes through.
import { useSyncExternalStore } from 'react'

export type MachineProblem = { machine: string; what: string; message: string }

const problems = new Map<string, MachineProblem>()
let list: MachineProblem[] = []
const listeners = new Set<() => void>()
const keyOf = (machine: string, what: string) => `${machine}\n${what}`

function changed() {
  list = [...problems.values()]
  for (const listener of listeners) listener()
}

/** `what` failed on `machine` ("Telling it this window's extensions"): on the console, and on its row. */
export function reportProblem(machine: string, what: string, error: unknown) {
  console.error(`${machine}: ${what} failed`, error)
  problems.set(keyOf(machine, what), { machine, what, message: error instanceof Error ? error.message : String(error) })
  changed()
}

/** `what` went through on `machine`: whatever it said before goes. */
export function clearProblem(machine: string, what: string) {
  if (problems.delete(keyOf(machine, what))) changed()
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** The problems on `machine` now. */
export function useMachineProblems(machine: string): MachineProblem[] {
  const all = useSyncExternalStore(subscribe, () => list)
  return all.filter((p) => p.machine === machine)
}
