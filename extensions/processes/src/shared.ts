// processes: what it is, for both halves, and the names and shapes they share.
import type { ExtensionAbout } from '@superego/protocol'

/** The pane: the processes of a thread and its folder, the selected one's output below. Params: `{}` or `{ id }`. */
export const PANE = 'processes'

export const about = {
  name: 'processes', version: '1.0.0', api: '^5.18', title: 'Processes',
  description: 'Servers, watchers and long builds a thread starts, run by the machine: their output, and a word when one ends.',
  panes: { [PANE]: "the processes of this thread and its folder, the selected one's output below. Params: {} or { id }" },
} satisfies ExtensionAbout

/** A thread's processes and its folder's, as a live value scoped by the thread's id: `ProcessInfo[]`. */
export const LIST = 'processes.list'
/** Where a process's output stands, scoped by its id: `OutputMark`. Changes as output arrives (at most every 100ms). */
export const OUTPUT = 'processes.output'

/** Its output, from a position: `processes.read`. */
export const READ = 'processes.read'

/** The `process:<id>` links that open one in the pane. */
export const SCHEME = 'process'
export const linkTo = (process: Pick<ProcessInfo, 'id' | 'name' | 'command'>) => `[${titleOf(process).replace(/[[\]\\]/g, '\\$&')}](${SCHEME}:${process.id})`

/** A report's entry kind in the transcript (a notice of processes'). */
export const REPORT = 'processes.report'

export type ProcessState = 'idle' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'lost'

/** Whom a process belongs to: a thread (agent-started), a folder (Run's, shared by every thread there), or the machine. */
export type Owner = { thread: string } | { folder: string } | { machine: true }

/** When its owner thread is woken by its end: any end, only a failure, or never. A stop never wakes it. */
export type Notify = 'exit' | 'failure' | 'never'

/** A process as Processes keeps it (its env aside: that stays on the machine). */
export type ProcessInfo = {
  /** `p_<8 hex>`, unique on the machine. */
  id: string
  /** Unique among its owner's live processes; Run's is `run`. */
  name?: string
  owner: Owner
  cwd: string
  command: string
  /** Text (or `/regex/`) in its output that marks it ready: till then it's `starting`. */
  ready?: string
  /** Milliseconds between SIGTERM and SIGKILL as it's stopped. */
  grace: number
  notify: Notify
  /** `on-failure`: started again after a failure (1s, then longer, up to 60s; given up after 5 in 2 minutes). */
  restart: 'never' | 'on-failure'
  /** Started again when the daemon starts after a restart of the machine, if it was running then. */
  keep: boolean
  /** Who started it. */
  by: { thread?: string; extension?: string; user?: true }
  state: ProcessState
  pid?: number
  /** How many times it has run. */
  run: number
  startedAt?: number
  endedAt?: number
  /** Its exit code; null when a signal ended it (or it's unknown: killed after its grace). */
  exitCode?: number | null
  signal?: string | null
  /** It was stopped (by the user, an agent, its thread's archiving), not ended on its own. */
  stopped?: boolean
  /** Why it couldn't start, or what became of it ("stopped by a restart of the machine"). */
  error?: string
  /** It ended while no daemon ran: found so as the daemon started. */
  whileAway?: boolean
  /** Its failure was seen (in the pane, or acted on): no longer marked on its thread's row. */
  seen?: boolean
}

/** Where its output stands, in bytes of all it ever wrote: `end` grows; `start` is where its current (or last) run began. */
export type OutputMark = { end: number; start: number }

/** A slice of its output, from `processes.read`. */
export type OutputSlice = {
  text: string
  /** Where `text` starts: later than asked when that part is gone (rotated away, or past what one read gives). */
  from: number
  end: number
  /** Where its current (or last) run's output begins. */
  start: number
  /** Where the oldest output kept begins: what's before it is gone. */
  first: number
}

/** A thread's processes, as `thread.facts.processes`: for its row's mark. Absent when none run or failed unseen. */
export type ProcessFacts = { running: number; starting: number; failed: number }

/** What a report in the transcript carries: the process, how it ended, and its last lines. */
export type ReportData = { id: string; title: string; how: string; failed: boolean; tail: string; whileAway?: boolean }

/** Live: it runs, or is on its way up or down. */
export const live = (state: ProcessState) => state === 'starting' || state === 'running' || state === 'stopping'
/** Ended: it ran and isn't running now. */
export const ended = (state: ProcessState) => state === 'exited' || state === 'failed' || state === 'lost'

/** What to call it: its name, else its command, cut short. */
export function titleOf({ name, command }: Pick<ProcessInfo, 'name' | 'command'>) {
  if (name) return name
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

/** A span of time, short: `8s`, `4m`, `2h`, `3d`. */
export function span(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** How it ended, in words: "exited with 1 after 4m", "done in 41s", "stopped", "gone with a restart". */
export function endedHow(p: Pick<ProcessInfo, 'state' | 'exitCode' | 'signal' | 'stopped' | 'error' | 'startedAt' | 'endedAt'>) {
  const after = p.startedAt && p.endedAt ? span(p.endedAt - p.startedAt) : undefined
  if (p.state === 'lost') return 'gone with a restart'
  if (p.stopped) return 'stopped'
  if (p.error && p.exitCode === undefined) return `couldn't start: ${p.error}`
  if (p.exitCode === 0) return after ? `done in ${after}` : 'done'
  const how = typeof p.exitCode === 'number' ? `exited with ${p.exitCode}` : p.signal ? `killed by ${p.signal}` : 'ended'
  return after ? `${how} after ${after}` : how
}
