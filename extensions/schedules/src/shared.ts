// schedules: what both halves agree on. A schedule belongs to one thread and, when due, wakes it with a message: once
// ("in 30m", "tomorrow 9:00") or every so often ("every 30m"), until the agent cancels it, a number of runs or an end
// time. The daemon half keeps them (a file of its own, per machine) and fires them; the UI half draws a thread's.
import type { ExtensionAbout } from '@superego/protocol'

export const about = {
  name: 'schedules', version: '1.0.0', api: '^5.17', title: 'Schedules',
  description: 'Wake a thread at a time, or every so often: "check CI every 30 minutes", "remind me tomorrow at 9".',
} satisfies ExtensionAbout

export const TOOLS = { schedule: 'schedule', list: 'schedule_list', cancel: 'schedule_cancel' } as const

export const ACTIONS = {
  add: 'schedules.add', pause: 'schedules.pause', resume: 'schedules.resume', run: 'schedules.run', cancel: 'schedules.cancel',
} as const

/** How the context a firing gives the agent starts (`⏰ Scheduled: Check CI (run 1 of up to 48, …).`), for the window to find it. */
export const SCHEDULED = '⏰ Scheduled:'

/** What the window reads of a firing's context: the schedule's name, and the run it was (`run 1 of 48`, `once`), late or not. */
export function readFiring(text: string): { label: string; what: string; late: boolean } | undefined {
  const m = /^⏰ Scheduled: (.+) \((run \d+ of up to \d+|once)[^)]*\)\./.exec(text)
  return m ? { label: m[1]!, what: m[2]!.replace(' of up to ', ' of '), late: /\nLate: /.test(text) } : undefined
}

/** The scoped live value (scope: a thread's id) of its schedules, active and paused, soonest first. */
export const THREAD_VALUE = 'schedules.thread'
/** The method listing schedules (`{ thread? }`), ended ones too. */
export const LIST_METHOD = 'schedules.list'

/** Machine settings (Settings → Schedules). */
export const SETTINGS = {
  minInterval: 'schedules.minInterval',
  maxRuns: 'schedules.maxRuns',
  days: 'schedules.days',
  perThread: 'schedules.perThread',
} as const

/** The guards no setting goes past: what a recurring schedule may cost at most. */
export const CAPS = { maxRuns: 500, days: 30, perMachine: 100, minIntervalMinutes: 1 } as const
/** The settings' defaults. */
export const DEFAULTS = { minIntervalMinutes: 5, maxRuns: 48, days: 7, perThread: 10 } as const

/** When a schedule fires: once, at a time (epoch ms); or every `every` ms, the first at `anchor + every`. */
export type When = { at: number } | { every: number; anchor: number }

/** Why a schedule ended. */
export type EndedWhy = 'done' | 'cancelled' | 'maxRuns' | 'ends' | 'archived'

export type Schedule = {
  /** `s_<rand>` */
  id: string
  /** The thread it wakes (its owner): it lives on, and fires from, that thread's machine. */
  thread: string
  /** A short name for the UI ("Check CI"). */
  label: string
  /** What the agent is told when it fires. */
  message: string
  /** What it does when due. Only `wake` for now: a message that starts a run. */
  action: 'wake'
  when: When
  /** The words it was made from ("every 30m"), as the user or agent said them. */
  said: string
  /** Recurring: a condition the agent checks each run, and cancels it once it holds ("CI is green"). */
  until?: string
  maxRuns: number
  /** Recurring: when it stops, whatever else (epoch ms). */
  ends?: number
  /** Its next run, while it has one. */
  next: number | null
  runs: number
  /** Runs it missed (the machine asleep, the daemon down, the thread busy past another), all told. */
  missed: number
  lastRun?: number
  /** Paused by the user (or after its wakes failed twice): it doesn't fire until resumed. */
  paused: boolean
  /** Its thread is archived (since then): it doesn't fire until the thread is back. */
  held?: number
  /** Who made it: the thread's agent, the user, or another extension (its name). */
  by: string
  created: number
  /**
   * Due, and waiting for its thread to be free (not working, not waiting on the user): `since` when it came due,
   * `due` the time it was due, `missed` the runs it skipped to get here; `now`, run now by the user (paused or not);
   * `told`, its lateness said already.
   */
  pending?: { since: number; due: number; missed: number; now?: boolean; told?: boolean }
  /** Why its last firing couldn't be sent, if it couldn't: it's tried again with the next tick. */
  error?: string
  /** Wakes in a row whose run failed: two pause it. */
  failures?: number
  /** It woke the thread and that run hasn't ended yet. */
  awaiting?: boolean
  ended?: { at: number; why: EndedWhy; reason?: string }
}

/** What the sidebar and the header read of a thread (`thread.facts.schedules`): its soonest run, and how many it has. */
export type Facts = { next: number | null; label?: string; count: number; paused: number; pending: number }

/** A `schedule` call's details, for its row: what was understood. */
export type ScheduleDetails = { id: string; label: string; said: string; next: number | null; times: number[]; every?: number; until?: string; maxRuns: number; ends?: number }
