import type { Status } from '@superego/protocol'
import { ExclamationMarkIcon, QuestionMarkIcon, type Icon } from './icons.tsx'

/** Needs you and failed: an icon each. Idle shows nothing; working and done are dots drawn by CSS (`--superego-status-dot`). */
const ICONS: Partial<Record<Status['state'], Icon>> = { blocked: QuestionMarkIcon, error: ExclamationMarkIcon }

export const statusLabel = (status: Status) =>
  status.state === 'blocked' ? `needs you${status.kind ? ` (${status.kind})` : ''}` : status.msg ? `${status.state}: ${status.msg}` : status.state

/** One glyph per OSC 7501 state, styled by `--superego-status-*`: nothing when idle, a pulsing dot while working, a dot of its own colour when done (finished, not yet seen), an icon when it needs you or failed. */
export function StatusGlyph({ status }: { status: Status }) {
  const Icon = ICONS[status.state]
  return <span className={`superego-status superego-status--${status.state}`} title={statusLabel(status)} aria-label={statusLabel(status)}>{Icon && <Icon weight="bold" aria-hidden />}</span>
}
