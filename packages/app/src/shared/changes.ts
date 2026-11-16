// What changed in each machine's threads and rejected providers, from what was had before: worked out alike by the
// window (its `superego.on` events, renderer/window-events.ts) and by whatever notifies of it (shared/notifications.ts).
import type { ProviderRejection, Status, ThreadInfo } from '@superego/protocol'

/** A thread's state changed (`before`: what it was; undefined, first heard). */
export type StatusChange = { machine: string; thread: ThreadInfo; before: Status['state'] | undefined }
/** A machine's provider rejected its credentials (again). */
export type RejectionChange = { machine: string; rejection: ProviderRejection }

/** Each thread's last status, by `<machine>/<thread>`. */
export type Statuses = Map<string, Status['state']>

/**
 * The changes between what was had (`before`, updated in place) and the threads now: one for
 * each thread whose state changed, and for each it sees for the first time (`before` undefined). Threads gone from a
 * list are forgotten; a machine with no list now (never had one) keeps what it had.
 */
export function statusChanges(before: Statuses, threads: Record<string, ThreadInfo[] | undefined>): StatusChange[] {
  const events: StatusChange[] = []
  for (const [machine, list] of Object.entries(threads)) {
    if (!list) continue
    const listed = new Set<string>()
    for (const thread of list) {
      const key = `${machine}/${thread.id}`
      listed.add(key)
      const was = before.get(key)
      if (was === thread.status.state) continue
      before.set(key, thread.status.state)
      events.push({ machine, thread, before: was })
    }
    for (const key of before.keys()) if (key.startsWith(`${machine}/`) && !listed.has(key)) before.delete(key)
  }
  return events
}

/** The rejections each machine had (`<provider>/<since>`), by machine: those it had when first heard aren't news. */
export type Rejected = Map<string, Set<string>>

/**
 * The rejections between what was had (`before`, updated in place) and the machines' rejections now:
 * one for each provider rejected (again: since changed) on a machine already heard from.
 */
export function rejectionChanges(before: Rejected, rejections: Record<string, ProviderRejection[] | undefined>): RejectionChange[] {
  const events: RejectionChange[] = []
  for (const [machine, list] of Object.entries(rejections)) {
    if (!list) continue
    const had = before.get(machine)
    const now = new Set(list.map((r) => `${r.provider}/${r.since}`))
    before.set(machine, now)
    if (!had) continue
    for (const rejection of list) if (!had.has(`${rejection.provider}/${rejection.since}`)) events.push({ machine, rejection })
  }
  return events
}
