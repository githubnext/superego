// Agent status uses the OSC 7501 Program Status vocabulary, so Superego threads, Claude Code, Codex and pi all read alike.
import type { ThreadInfo } from './methods.ts'

/** What a thread is doing: nothing, running, finished a run, waiting on the user, or failed. */
export type StatusState = 'idle' | 'working' | 'done' | 'blocked' | 'error'
/** What a blocked thread waits on: a permission, an answer, or sign-in. */
export type BlockedKind = 'permission' | 'question' | 'auth'
/**
 * A thread's status: its state, what it's blocked on, and `msg`, in a line or a few: blocked, what it waits on (a question, Markdown); error, why it failed; done, what the run
 * did (a recap, plain text, short). Absent when there's nothing to say, and from daemons before recaps for done.
 */
export type Status = { state: StatusState; kind?: BlockedKind; msg?: string }

/** Most pressing first: a rollup over many threads shows the highest. */
const PRIORITY: Record<StatusState, number> = { blocked: 4, error: 3, done: 2, working: 1, idle: 0 }

/**
 * A thread whose run its provider refused for bad credentials, waiting for the machine to be signed in again (and
 * then going on by itself). One notice says so for them all: each is quiet, never wanting a look of its own.
 */
export const waitingForSignIn = (status: Status) => status.state === 'blocked' && status.kind === 'auth'

/**
 * What a status shows as, everywhere (the app's marks and words, the menu bar, the CLI, notifications): its state, a
 * blocked one by what it waits on (a question, a permission, sign-in). A quiet thread (one that reports to another)
 * that finished shows as idle: its parent hears, and it isn't unread.
 */
export type StatusShape = 'idle' | 'working' | 'done' | 'question' | 'permission' | 'signin' | 'error'

/** The shape a status shows as; `quiet`, for a thread that reports to another. */
export function statusShape(status: Status, quiet = false): StatusShape {
  switch (status.state) {
    case 'blocked': return status.kind === 'auth' ? 'signin' : status.kind === 'permission' ? 'permission' : 'question'
    case 'done': return quiet ? 'idle' : 'done'
    default: return status.state
  }
}

/** Each shape as the UI says it: the word on a row, in the title bar, ⌘U, the menu bar, the CLI and notifications. */
export const STATUS_WORDS = {
  idle: 'Idle', working: 'Working', done: 'Done', question: 'Question', permission: 'Permission', signin: 'Sign in', error: 'Failed',
} as const satisfies Record<StatusShape, string>

/** The word for a status: "Question", "Done", "Sign in"; nothing when idle (nor for a quiet one that finished). */
export function statusWord(status: Status, quiet = false): string {
  const shape = statusShape(status, quiet)
  return shape === 'idle' ? '' : STATUS_WORDS[shape]
}

/** A thread's status in a few words, for tooltips and screen readers: its word, and what it did or why it failed or waits ("Done: <recap>"). */
export function statusLabel(status: Status, quiet = false): string {
  const shape = statusShape(status, quiet)
  const why = shape === 'done' || shape === 'error' || shape === 'signin' ? status.msg : undefined
  return why ? `${STATUS_WORDS[shape]}: ${why}` : STATUS_WORDS[shape]
}

/**
 * Whether a thread wants the user and they haven't looked: it finished, failed or asks something. Not one waiting for
 * sign-in (one notice for the machine says so), nor a quiet one that finished or failed (someone else hears how its
 * runs end; it still counts when it needs you), nor one in no list (archived, Ego's). The one rule for what's unread:
 * see `unreadThreads`.
 */
export function unread(thread: ThreadInfo) {
  const { state } = thread.status
  if (state !== 'done' && state !== 'error' && state !== 'blocked') return false
  if (waitingForSignIn(thread.status) || thread.archived || thread.hidden) return false
  return state === 'blocked' || !thread.quiet
}

/**
 * Every unread thread but the one shown (`shown`: it's being seen), the most pressing first (a question, a failure, a
 * result), then the most recently active. The one list for the app's unread bell, its threads rail, the app icon's
 * count, notifications and `<id> unread`; each passes its threads with whatever it keeps beside them.
 */
export function unreadThreads<T extends { machine: string; thread: ThreadInfo }>(threads: Iterable<T>, shown?: { machine: string; thread: string }): T[] {
  return [...threads]
    .filter(({ machine, thread }) => unread(thread) && !(shown?.machine === machine && shown.thread === thread.id))
    .sort((a, b) => PRIORITY[b.thread.status.state] - PRIORITY[a.thread.status.state] || b.thread.activeAt - a.thread.activeAt)
}

/** How pressing a status is, the higher the more. Waiting for sign-in ranks just above idle: the machine's notice speaks for it. */
export const statusRank = (status: Status) => waitingForSignIn(status) ? 0.5 : PRIORITY[status.state]

export function rollup(statuses: Iterable<Status>): Status {
  let best: Status = { state: 'idle' }
  for (const status of statuses) if (statusRank(status) > statusRank(best)) best = status
  return best
}

/** What `deriveStatus` reads from a pi-durable `pi.live` document. */
export type LiveLike = {
  run?: unknown
  runFailure?: { reason: string; detail?: string; taskId: number }
}

/**
 * A thread's status from durable state: working while a run is going; waiting for sign-in (`signIn`, why) when its
 * provider rejected the credentials its run failed on; error for a run that failed and was not looked at since; done
 * when there is an answer newer than what was seen (saying what the run did, `recap`, when there's one); otherwise idle.
 */
export function deriveStatus(input: {
  live: LiveLike | undefined
  lastEntryId: number | undefined
  seen: { entryId?: number; failureTaskId?: number } | undefined
  blocked?: { kind: BlockedKind; msg?: string }
  signIn?: string
  recap?: string
}): Status {
  const { live, lastEntryId, seen, blocked, signIn, recap } = input
  if (blocked) return { state: 'blocked', kind: blocked.kind, msg: blocked.msg }
  if (live?.run) return { state: 'working' }
  if (signIn !== undefined) return { state: 'blocked', kind: 'auth', msg: signIn }
  const failure = live?.runFailure
  if (failure && failure.reason !== 'aborted' && failure.taskId !== seen?.failureTaskId) {
    return { state: 'error', msg: failure.detail ?? failure.reason }
  }
  if (lastEntryId !== undefined && lastEntryId > (seen?.entryId ?? -1)) return recap ? { state: 'done', msg: recap } : { state: 'done' }
  return { state: 'idle' }
}
