// How the sidebar says when a thread was last active, without React.
import type { ThreadInfo } from '@superego/protocol'

/** How long ago, briefly: now, 5m, 2h, then the weekday, then the date. */
export function ago(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return ''
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  const date = new Date(at)
  if (minutes < 6 * 24 * 60) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
