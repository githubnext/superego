import { waitingForSignIn, type Status } from '@superego/protocol'

/** A thread's status in a few words: `working`, `needs you (question)`, `done: <recap>`. */
export const statusLabel = (status: Status) =>
  waitingForSignIn(status) ? `waiting for sign-in${status.msg ? `: ${status.msg}` : ''}`
    : status.state === 'blocked' ? `needs you${status.kind ? ` (${status.kind})` : ''}` : status.msg ? `${status.state}: ${status.msg}` : status.state

/**
 * One dot per OSC 7501 state, styled by `--superego-status-*`: a quiet grey one when idle, a ring while working, filled
 * in the accent when done (finished, not yet seen), orange when it needs you, red when it failed. Waiting for sign-in
 * is a quiet grey ring: the machine's notice says why, once for all of them.
 */
export function StatusGlyph({ status }: { status: Status }) {
  const state = waitingForSignIn(status) ? 'signin' : status.state
  return <span className={`superego-status superego-status--${state}`} title={statusLabel(status)} aria-label={statusLabel(status)} />
}
