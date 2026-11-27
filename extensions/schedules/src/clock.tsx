// schedules: the clock glyph, its hands at a time (the next run's), so the mark itself says when. Without a time (all
// paused, or an icon), a plain clock's. Drawn in the text's colour, at an icon's size.
import type { SVGProps } from 'react'

export function ClockFace({ at, size = 14, ...props }: { at?: number | null; size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  const d = at == null ? undefined : new Date(at)
  const minutes = d ? d.getMinutes() : 0
  const hours = d ? (d.getHours() % 12) + minutes / 60 : 0
  const hand = (turns: number, length: number) => {
    const angle = turns * 2 * Math.PI
    return { x2: 8 + Math.sin(angle) * length, y2: 8 - Math.cos(angle) * length }
  }
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeLinecap="round" className="schedules-clock" {...props}>
      <circle cx="8" cy="8" r="6.6" strokeWidth="1.4" />
      {d ? (
        <>
          <line x1="8" y1="8" {...hand(hours / 12, 3.3)} strokeWidth="1.6" />
          <line x1="8" y1="8" {...hand(minutes / 60, 4.7)} strokeWidth="1.2" />
        </>
      ) : <path d="M8 4.6V8h2.8" strokeWidth="1.4" strokeLinejoin="round" />}
    </svg>
  )
}

/** ▷: run now. */
export const PlayGlyph = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
    <path d="M5 3.5v9l7.5-4.5z" />
  </svg>
)
