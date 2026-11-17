import type { ReactNode } from 'react'
import { statusLabel, statusShape, statusWord, type Status, type StatusShape } from '@superego/protocol'

/**
 * Every mark a thread (or what it's about) shows: its status's shapes (`StatusShape`), and a few more for what isn't a
 * thread's status: queued and landed on a board, stalled (a working thread that stopped moving), and a machine that's
 * offline or connecting.
 */
export type GlyphShape = StatusShape | 'queued' | 'stalled' | 'landed' | 'offline' | 'connecting'

const classes = (...names: (string | false)[]) => names.filter(Boolean).join(' ')

/** Documents whose spinners are kept in step (`keepInStep`). */
const stepped = new WeakSet<Document>()

/**
 * Every spinner in a document turns in step: each time one starts turning (shown, or moving again after a pause), its
 * turn is set to the document's clock, not its own start, so many at once move as one.
 */
function keepInStep(element: Element | null) {
  const document = element?.ownerDocument
  if (!document || stepped.has(document)) return
  stepped.add(document)
  document.addEventListener('animationstart', (event) => {
    if (event.animationName !== 'superego-spin' || !(event.target instanceof Element)) return
    for (const animation of event.target.getAnimations()) {
      if (animation instanceof CSSAnimation && animation.animationName === 'superego-spin') animation.startTime = 0
    }
  })
}

/** Two thirds of a ring: a spinner while it turns, `still` when what it stands for stopped (stalled); `small` for the quiet. */
const arc = (small: boolean, still = false) => (
  <circle ref={still ? undefined : keepInStep} className={still ? undefined : 'superego-glyph__spin'} cx="8" cy="8" r={small ? 4 : 5} fill="none" stroke="currentColor"
    strokeWidth={small ? 1.7 : 2} strokeLinecap="round" strokeDasharray={small ? '17 8.1' : '21 10.4'} />
)
const ring = (r: number, width: number, dash?: string) => <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={width} strokeDasharray={dash} />

/** Every shape but working, whose spinner is smaller for the quiet. */
const SHAPES: Record<Exclude<GlyphShape, 'working'>, ReactNode> = {
  idle: <circle cx="8" cy="8" r="1.9" />,
  done: <circle cx="8" cy="8" r="3.4" />,
  question: <><circle cx="8" cy="8" r="2.6" />{ring(5.6, 1.4)}</>,
  permission: <><circle cx="8" cy="8" r="2.6" />{ring(5.6, 1.4)}</>,
  signin: ring(4.6, 1.4, '2.2 1.9'),
  error: <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  queued: ring(3.4, 1.3),
  stalled: arc(false, true),
  landed: <path d="M4 8.4l2.6 2.6 5.4-5.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  offline: ring(3.4, 1.3),
  connecting: arc(true),
}

/**
 * One mark, drawn in `--superego-status-*` (the class `superego-status--<shape>`), 1em square: a tiny grey dot when
 * idle, a spinner while working (smaller and grey for a quiet thread), a dot in the accent when done, a target when it
 * asks something, a dashed ring waiting for sign-in, a cross when it failed. `label` is said to screen readers and on
 * hover; without one it's decoration.
 */
export function Glyph({ shape, quiet = false, label, className = '' }: { shape: GlyphShape; quiet?: boolean; label?: string; className?: string }) {
  return (
    <span className={classes('superego-status', `superego-status--${shape}`, quiet && 'is-quiet', className)}
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}>
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>{shape === 'working' ? arc(quiet) : SHAPES[shape]}</svg>
    </span>
  )
}

/** A thread's status as its mark (`Glyph`); `quiet`, for a thread that reports to another: grey while it works, and nothing unread once it's done. */
export function StatusGlyph({ status, quiet = false, className = '' }: { status: Status; quiet?: boolean; className?: string }) {
  return <Glyph shape={statusShape(status, quiet)} quiet={quiet} label={statusLabel(status, quiet)} className={className} />
}

/**
 * A status as its word, in its colour: "Question" and "Permission" orange, "Failed" red, "Working" and "Done" in the
 * accent, "Sign in" muted. Nothing when idle.
 */
export function StatusWord({ status, quiet = false, className = '' }: { status: Status; quiet?: boolean; className?: string }) {
  const word = statusWord(status, quiet)
  if (!word) return null
  return <span className={classes('superego-status-word', `superego-status-word--${statusShape(status, quiet)}`, className)} title={statusLabel(status, quiet)}>{word}</span>
}
