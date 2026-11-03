import type { Status } from '@mu/protocol'

const GLYPHS: Record<Status['state'], string> = { idle: '○', working: '●', done: '*', blocked: '?', error: '!' }

export const statusLabel = (status: Status) =>
  status.state === 'blocked' ? `needs you${status.kind ? ` (${status.kind})` : ''}` : status.msg ? `${status.state}: ${status.msg}` : status.state

/** One glyph per OSC 7501 state, styled by `--mu-status-*`. Working pulses. */
export function StatusGlyph({ status }: { status: Status }) {
  return <span className={`mu-status mu-status--${status.state}`} title={statusLabel(status)} aria-label={statusLabel(status)}>{GLYPHS[status.state]}</span>
}
