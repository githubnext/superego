// Agent status uses the OSC 7501 Program Status vocabulary, so Superego threads, Claude Code, Codex and pi all read alike.

export type StatusState = 'idle' | 'working' | 'done' | 'blocked' | 'error'
export type BlockedKind = 'permission' | 'question' | 'auth'
export type Status = { state: StatusState; kind?: BlockedKind; msg?: string }

/** Most pressing first: a rollup over many threads shows the highest. */
const PRIORITY: Record<StatusState, number> = { blocked: 4, error: 3, done: 2, working: 1, idle: 0 }

/**
 * A thread whose run its provider refused for bad credentials, waiting for the machine to be signed in again (and
 * then going on by itself). One notice says so for them all: each is quiet, never wanting a look of its own.
 */
export const waitingForSignIn = (status: Status) => status.state === 'blocked' && status.kind === 'auth'

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
 * when there is an answer newer than what was seen; otherwise idle.
 */
export function deriveStatus(input: {
  live: LiveLike | undefined
  lastEntryId: number | undefined
  seen: { entryId?: number; failureTaskId?: number } | undefined
  blocked?: { kind: BlockedKind; msg?: string }
  signIn?: string
}): Status {
  const { live, lastEntryId, seen, blocked, signIn } = input
  if (blocked) return { state: 'blocked', kind: blocked.kind, msg: blocked.msg }
  if (live?.run) return { state: 'working' }
  if (signIn !== undefined) return { state: 'blocked', kind: 'auth', msg: signIn }
  const failure = live?.runFailure
  if (failure && failure.reason !== 'aborted' && failure.taskId !== seen?.failureTaskId) {
    return { state: 'error', msg: failure.detail ?? failure.reason }
  }
  if (lastEntryId !== undefined && lastEntryId > (seen?.entryId ?? -1)) return { state: 'done' }
  return { state: 'idle' }
}
