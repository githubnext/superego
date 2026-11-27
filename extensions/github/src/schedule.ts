// github, daemon half: when a pull request is next asked about. An open one every 30s while its checks run or something
// just happened to it (attached, pushed to, its thread's run ended), else every 5 minutes; a merged or closed one never
// by itself. And how long a host is left alone after a failure: twice as long each time, up to 30 minutes.
import type { Conversation, PrDetail } from './shared.ts'

export type Intervals = {
  /** How often the poller looks for what's due. */
  tick: number
  /** An open pull request whose checks run, or that's hot. */
  fast: number
  /** Any other open one. */
  slow: number
  /** How long something happening to a pull request keeps it hot. */
  hot: number
  /** The first wait after a host's failure, doubled each time after. */
  backoff: number
  /** The longest wait after failures. */
  maxBackoff: number
  /** How often gh is looked for again while it's missing or signed out. */
  recheck: number
  /** How long after a thread's run ends its branch is looked at for a pull request (debounced). */
  settle: number
}

export const INTERVALS: Intervals = {
  tick: 5_000, fast: 30_000, slow: 5 * 60_000, hot: 15 * 60_000, backoff: 60_000, maxBackoff: 30 * 60_000, recheck: 15 * 60_000, settle: 10_000,
}

/**
 * What the poller keeps of a pull request: as last fetched, when it last tried, until when it's hot, and if asked for
 * now; the keys of the events told of it (each told once); and its description and conversation as the pane or
 * `pr_view` last had them fetched (`talk`, in memory only), and whether one wants them fetched with its next ask
 * (`talking`).
 */
export type Entry = { detail?: PrDetail; checkedAt?: number; hotUntil?: number; forced?: boolean; told?: string[]; talk?: Conversation; talking?: boolean }

/** Whether a pull request is due to be asked about now. */
export function due(entry: Entry, now: number, intervals: Intervals): boolean {
  if (entry.forced || entry.checkedAt === undefined) return true
  const state = entry.detail?.state
  if (state === 'merged' || state === 'closed') return false
  const fast = entry.detail?.checks === 'pending' || (entry.hotUntil ?? 0) > now
  return now - entry.checkedAt >= (fast ? intervals.fast : intervals.slow)
}

/** The wait after a host's `failures`th failure in a row. */
export const backoff = (failures: number, intervals: Intervals) => Math.min(intervals.backoff * 2 ** Math.max(0, failures - 1), intervals.maxBackoff)
