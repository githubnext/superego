// github, UI half: how a pull request looks. Its state as one glyph in one colour everywhere (open green, draft grey,
// merged purple, closed red), with a dot for its checks on the sidebar's mark (✓ passing green, ✗ failing red, a ring
// while they run); and the road to merge, three short bars for checks · review · merge, filled as each is done, all
// purple once merged (the chip's, the card's, the pane's).
import type { ReactNode } from 'react'
import { road, type Check, type PrState, type PrSummary } from './shared.ts'

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const PATHS: Record<PrState | 'unknown', ReactNode> = {
  open: <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="12.5" r="1.6" /><path d="M4.5 5.1v5.8M11.5 10.9V6.8a2.3 2.3 0 0 0-2.3-2.3H7.4" /><path d="M8.9 2.9 7.3 4.5l1.6 1.6" /></>,
  draft: <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="12.5" r="1.6" /><path d="M4.5 5.1v5.8" /><circle cx="11.5" cy="8.3" r=".5" fill="currentColor" /><circle cx="11.5" cy="5.2" r=".5" fill="currentColor" /></>,
  merged: <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.8" cy="9" r="1.6" /><path d="M4.5 5.1v5.8M4.5 5.1c.3 2.6 2.4 3.9 5.7 3.9" /></>,
  closed: <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="12.5" r="1.6" /><path d="M4.5 5.1v5.8M11.5 10.9V8M9.8 2.8l3.4 3.4M13.2 2.8 9.8 6.2" /></>,
  unknown: <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="12.5" r="1.6" /><path d="M4.5 5.1v5.8M11.5 10.9V6.8a2.3 2.3 0 0 0-2.3-2.3H7.4" /><path d="M8.9 2.9 7.3 4.5l1.6 1.6" /></>,
}

/** A pull request's state, as its glyph in its colour. */
export function PrGlyph({ state, size = 14 }: { state: PrState | undefined; size?: number }) {
  return <svg className={`github-glyph is-${state ?? 'unknown'}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden {...STROKE}>{PATHS[state ?? 'unknown']}</svg>
}

/** Its glyph, with a dot for its checks while it's open (none without checks). */
export function PrMark({ pr, size = 14 }: { pr: PrSummary; size?: number }) {
  const live = pr.state === 'open' || pr.state === 'draft'
  return (
    <span className="github-mark">
      <PrGlyph state={pr.state} size={size} />
      {live && pr.checks !== 'none' && <i className={`github-mark__dot is-${pr.checks}`} />}
    </span>
  )
}

/** The road to merge: checks · review · merge, nothing for a closed one. `small` for a tab's note. */
export function Road({ pr, small = false }: { pr: PrSummary; small?: boolean }) {
  const segments = road(pr)
  if (!segments.length) return null
  return <span className={`github-road${small ? ' is-small' : ''}`} aria-hidden>{segments.map((s, i) => <i key={i} className={`is-${s}`} />)}</span>
}

/** A check's result: ✓, ✗, or a ring while it runs. */
export function CheckGlyph({ result, size = 14 }: { result: Check['result']; size?: number }) {
  const path = result === 'pass' ? <path d="M3.5 8.4 6.6 11.4 12.5 4.8" /> : result === 'fail' ? <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    : result === 'skipped' ? <path d="M5 8h6" /> : <circle cx="8" cy="8" r="3.4" />
  return <svg className={`github-check is-${result}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden {...STROKE} strokeWidth={1.8}>{path}</svg>
}

/** A review comment's bubble. */
export function CommentGlyph({ size = 14, tone = 'changes' }: { size?: number; tone?: 'changes' | 'quiet' | 'approved' }) {
  return (
    <svg className={`github-comment is-${tone}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden {...STROKE}>
      <path d="M3 4.2c0-.9.7-1.6 1.6-1.6h6.8c.9 0 1.6.7 1.6 1.6v5c0 .9-.7 1.6-1.6 1.6H7.2L4.6 13v-2.2h0C3.7 10.8 3 10.1 3 9.2z" />
    </svg>
  )
}
