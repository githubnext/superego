import type { Status } from '@superego/protocol'

export const statusLabel = (status: Status) =>
  status.state === 'blocked' ? `needs you${status.kind ? ` (${status.kind})` : ''}` : status.msg ? `${status.state}: ${status.msg}` : status.state

/**
 * One dot per OSC 7501 state, styled by `--superego-status-*`: a quiet grey one when idle, a ring while working, filled
 * in the accent when done (finished, not yet seen), orange when it needs you, red when it failed.
 */
export function StatusGlyph({ status }: { status: Status }) {
  return <span className={`superego-status superego-status--${status.state}`} title={statusLabel(status)} aria-label={statusLabel(status)} />
}
