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

/** Each state as the UI says it: in status tooltips, the sidebar's sort and notifications. */
export const STATUS_WORDS = { idle: 'Idle', working: 'Working', done: 'Finished', blocked: 'Needs you', error: 'Failed' } as const satisfies Record<StatusState, string>

/** What a blocked thread waits on, in words. */
const WAITS_ON: Record<BlockedKind, string> = { permission: 'a permission', question: 'a question', auth: 'sign-in' }

/** A thread's status in a few words: "Working", "Needs you: a question", "Finished: <recap>", "Waiting for sign-in". */
export function statusLabel(status: Status): string {
  if (waitingForSignIn(status)) return `Waiting for sign-in${status.msg ? `: ${status.msg}` : ''}`
  if (status.state === 'blocked') return status.kind ? `${STATUS_WORDS.blocked}: ${WAITS_ON[status.kind]}` : STATUS_WORDS.blocked
  return status.msg ? `${STATUS_WORDS[status.state]}: ${status.msg}` : STATUS_WORDS[status.state]
}

/**
 * Whether a thread wants the user and they haven't looked: it finished, failed or asks something. Not one waiting for
 * sign-in (one notice for the machine says so), nor a child working for its parent (the parent hears how it ends;
 * it still counts when it needs you), nor one in no list (archived, Ego's). The one rule for the app's unread bell,
 * notifications, menu bar and icon count, and `<id> unread`.
 */
export function unread(thread: ThreadInfo) {
  const { state } = thread.status
  if (state !== 'done' && state !== 'error' && state !== 'blocked') return false
  if (waitingForSignIn(thread.status) || thread.archived || thread.hidden) return false
  return state === 'blocked' || !reportsToParent(thread)
}

/** Whether a thread works for its parent, which hears how its runs end (the thread-reports extension says so). */
export const reportsToParent = (thread: ThreadInfo) => {
  const fact = thread.ext?.['thread-reports']
  return Boolean(fact && typeof fact === 'object' && !Array.isArray(fact) && fact.toParent === true)
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
