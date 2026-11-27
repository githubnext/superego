// schedules: what both halves agree on. A schedule belongs to one thread and, when due, wakes it with a message, reminds
// the user (a notice, no run), or both: once ("in 30m", "tomorrow 9:00"), every so often ("every 30m") or on the
// calendar ("every weekday at 9", cron), until the agent cancels it, a number of runs or an end time. The daemon half keeps them (a file of its own, per machine) and fires them; the UI half draws a thread's.
import type { ExtensionAbout } from '@superego/protocol'

export const about = {
  name: 'schedules', version: '1.1.0', api: '^5.21', title: 'Schedules', group: 'agent',
  description: 'Wake a thread or remind you at a time, every so often or on the calendar: "check CI every 30 minutes", "remind me tomorrow at 9".',
} satisfies ExtensionAbout

export const TOOLS = { schedule: 'schedule', list: 'schedule_list', cancel: 'schedule_cancel' } as const

export const ACTIONS = {
  add: 'schedules.add', update: 'schedules.update', pause: 'schedules.pause', resume: 'schedules.resume', run: 'schedules.run', cancel: 'schedules.cancel',
  /** The window's: the form for a new schedule in the shown thread, and the machine's every schedule. */
  new: 'schedules.new', all: 'schedules.all',
} as const

/** What a schedule does when due: wake the agent with its message (a run), remind the user (a notice, no run), or both. */
export type Action = 'wake' | 'notify' | 'both'
export const ACTION_WORDS: Record<Action, string> = { wake: 'Wake the agent', notify: 'Remind me', both: 'Both' }

/** The kind of a reminder's notice (`threads.notice`), drawn by the window. */
export const REMINDER = 'schedules.reminder'
/** A reminder's notice's data: which schedule, its run (of how many, repeating), and when it was due if it went late. */
export type Reminder = { id: string; label: string; message: string; run: number; maxRuns?: number; how?: string; late?: number }

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
/** The live value of the machine's schedules that are going, every thread's, soonest first. */
export const ALL_VALUE = 'schedules.all'
/** The method saying what a time in words comes to (`{ when, action? }` → `Understood`), for a form to show as it's typed. */
export const UNDERSTAND_METHOD = 'schedules.understand'
/** The live value of what's wrong with the machine's schedules, if anything (its file unreadable): a string, or null. */
export const PROBLEM_VALUE = 'schedules.problem'
/** Its section in Settings (the machine's), and the UI drawn under it. */
export const SECTION = 'schedules'

/** The method finding a time in what was said (`{ text }` → `{ when, message, action? }` or null), for `/schedule …`. */
export const SPLIT_METHOD = 'schedules.split'

/** What a time in words comes to: how it repeats in words, its next runs, and the zone they're in. */
export type Understood = { how: string; times: number[]; repeats: boolean; tz: string }

/** Machine settings (Settings → Schedules). */
export const SETTINGS = {
  minInterval: 'schedules.minInterval',
  maxRuns: 'schedules.maxRuns',
  days: 'schedules.days',
  perThread: 'schedules.perThread',
} as const

/**
 * The guards no setting goes past: what a recurring schedule may cost at most. How often one thread is woken in an hour,
 * all told (one-shots the agent chains one after another too), is the core's wake budget (`WAKES_PER_HOUR`).
 */
export const CAPS = { maxRuns: 500, days: 30, perMachine: 100, minIntervalMinutes: 1 } as const
/** The settings' defaults. */
export const DEFAULTS = { minIntervalMinutes: 5, maxRuns: 48, days: 7, perThread: 10 } as const

/**
 * When a schedule fires: once, at a time (epoch ms); every `every` ms, the first at `anchor + every`; or on the
 * calendar, as `cron` says (five fields), on the wall clock of `tz` (the machine's zone when it was made).
 */
export type When = { at: number } | { every: number; anchor: number } | { cron: string; tz: string }

/** Why a schedule ended. */
export type EndedWhy = 'done' | 'cancelled' | 'maxRuns' | 'ends' | 'archived'

export type Schedule = {
  /** `s_<rand>` */
  id: string
  /** The thread it wakes (its owner): it lives on, and fires from, that thread's machine. */
  thread: string
  /** A short name for the UI ("Check CI"). */
  label: string
  /** What the agent is told when it fires (wake), or the user is reminded of (notify). */
  message: string
  /** What it does when due. */
  action: Action
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
   * `told`, its lateness said already; `reminded`, its reminder given already (one that does both, its wake yet to go).
   */
  pending?: { since: number; due: number; missed: number; now?: boolean; told?: boolean; reminded?: boolean }
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
export type ScheduleDetails = { id: string; label: string; said: string; action: Action; next: number | null; times: number[]; how: string; every?: number; until?: string; maxRuns: number; ends?: number }
