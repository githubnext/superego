import type { ReactNode } from 'react'
import { statusLabel, statusShape, statusWord, type Status, type StatusShape } from '@superego/protocol'

/**
 * Every mark a thread (or what it's about) shows: its status's shapes (`StatusShape`), and a few more for what isn't a
 * thread's status: queued and landed on a board, stalled (a working thread that stopped moving), and a machine that's
 * offline or connecting.
 */
export type GlyphShape = StatusShape | 'queued' | 'stalled' | 'landed' | 'offline' | 'connecting'

const classes = (...names: (string | false)[]) => names.filter(Boolean).join(' ')

/** Three dots that breathe in turn (`still`: they don't). */
const wave = (still = false) => (
  <g className={`superego-glyph__wave${still ? ' is-still' : ''}`}>
    <circle cx="3.4" cy="8" r="1.6" /><circle cx="8" cy="8" r="1.6" /><circle cx="12.6" cy="8" r="1.6" />
  </g>
)
const ring = (r: number, width: number, dash?: string) => <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={width} strokeDasharray={dash} />

const SHAPES: Record<GlyphShape, ReactNode> = {
  idle: <circle cx="8" cy="8" r="1.9" />,
  working: wave(),
  done: <circle cx="8" cy="8" r="3.4" />,
  question: <><circle cx="8" cy="8" r="2.6" />{ring(5.6, 1.4)}</>,
  permission: <><circle cx="8" cy="8" r="2.6" />{ring(5.6, 1.4)}</>,
  signin: ring(4.6, 1.4, '2.2 1.9'),
  error: <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  queued: ring(3.4, 1.3),
  stalled: wave(true),
  landed: <path d="M4 8.4l2.6 2.6 5.4-5.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  offline: ring(3.4, 1.3),
  connecting: wave(),
}

/**
 * One mark, drawn in `--superego-status-*` (the class `superego-status--<shape>`), 1em square: a tiny grey dot when
 * idle, three breathing dots while working (grey for a quiet thread), a dot in the accent when done, a target when it
 * asks something, a dashed ring waiting for sign-in, a cross when it failed. `label` is said to screen readers and on
 * hover; without one it's decoration.
 */
export function Glyph({ shape, quiet = false, label, className = '' }: { shape: GlyphShape; quiet?: boolean; label?: string; className?: string }) {
  return (
    <span className={classes('superego-status', `superego-status--${shape}`, quiet && 'is-quiet', className)}
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}>
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>{SHAPES[shape]}</svg>
    </span>
  )
}

/** A thread's status as its mark (`Glyph`); `quiet`, for a thread that reports to another: grey while it works, and nothing unread once it's done. */
export function StatusGlyph({ status, quiet = false, className }: { status: Status; quiet?: boolean; className?: string }) {
  return <Glyph shape={statusShape(status, quiet)} quiet={quiet} label={statusLabel(status, quiet)} {...(className ? { className } : {})} />
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
