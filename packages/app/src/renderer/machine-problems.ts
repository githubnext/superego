// What went wrong between this window and a machine while it was connected: telling it the window's extensions,
// fetching its actions. Said on the console and on the machine's row in Settings → Machines, until the same thing next
// goes through.
import { createStore } from './local-state.ts'

export type MachineProblem = { machine: string; what: string; message: string }

const problems = createStore<MachineProblem[]>('machine-problems', [])
const same = (p: MachineProblem, machine: string, what: string) => p.machine === machine && p.what === what

/** `what` failed on `machine` ("Telling it this window's extensions"): on the console, and on its row. */
export function reportProblem(machine: string, what: string, error: unknown) {
  console.error(`${machine}: ${what} failed`, error)
  const problem = { machine, what, message: error instanceof Error ? error.message : String(error) }
  problems.set((list) => list.some((p) => same(p, machine, what)) ? list.map((p) => same(p, machine, what) ? problem : p) : [...list, problem])
}

/** `what` went through on `machine`: whatever it said before goes. */
export function clearProblem(machine: string, what: string) {
  if (problems.get().some((p) => same(p, machine, what))) problems.set((list) => list.filter((p) => !same(p, machine, what)))
}

/** The problems on `machine` now. */
export function useMachineProblems(machine: string): MachineProblem[] {
  return problems.use().filter((p) => p.machine === machine)
}
