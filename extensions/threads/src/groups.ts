// The sidebar's order, without React: how times read, and how the list holds still under the pointer.
import type { Session } from '@mu/app/ui'
import type { ThreadInfo } from '@mu/protocol'

/** When a thread last did something; a daemon from before last-activity was reported gives its creation. */
export const activity = (thread: ThreadInfo) => thread.activeAt ?? thread.createdAt

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

/**
 * The sessions in the order they had (`frozen`), with what each holds now: a thread changing state doesn't move under
 * the pointer. Threads and sessions that appeared since go at the end; ones that went, go.
 */
export function freeze(frozen: Session[], live: Session[]): Session[] {
  const now = new Map(live.map((s) => [s.key, s]))
  const kept = frozen.flatMap((old) => {
    const session = now.get(old.key)
    if (!session) return []
    now.delete(old.key)
    const threads = new Map(session.threads.map((t) => [t.id, t]))
    const ordered = old.threads.flatMap((t) => threads.has(t.id) ? [threads.get(t.id)!] : [])
    return [{ ...session, threads: [...ordered, ...session.threads.filter((t) => !old.threads.some((o) => o.id === t.id))] }]
  })
  return [...kept, ...now.values()]
}
