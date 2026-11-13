// What the window tells extensions as it happens (`superego.on`, see WindowEvents): threads' statuses changing, the
// thread shown changing, a machine's provider rejecting its credentials, and the window's focus and visibility. The
// shell's state feeds it; the registry passes it on.
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ProviderRejection, Status, ThreadInfo } from '@superego/protocol'
import type { Registry, WindowEvents } from './extension.tsx'
import type { Selection } from './state.tsx'

/** Each thread's last status, by `<machine>/<thread>`. */
export type Statuses = Map<string, Status['state']>

/**
 * The `thread.status` events between what the window had (`before`, updated in place) and the threads now: one for
 * each thread whose state changed, and for each it sees for the first time (`before` undefined). Threads gone from a
 * list are forgotten; a machine with no list now (never had one) keeps what it had.
 */
export function statusChanges(before: Statuses, threads: Record<string, ThreadInfo[] | undefined>): WindowEvents['thread.status'][] {
  const events: WindowEvents['thread.status'][] = []
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

/** The rejections each machine had (`<provider>/<since>`), by machine: those it had when the window first heard aren't news. */
export type Rejected = Map<string, Set<string>>

/**
 * The `auth.rejected` events between what the window had (`before`, updated in place) and the machines' rejections now:
 * one for each provider rejected (again: since changed) on a machine already heard from.
 */
export function rejectionChanges(before: Rejected, rejections: Record<string, ProviderRejection[] | undefined>): WindowEvents['auth.rejected'][] {
  const events: WindowEvents['auth.rejected'][] = []
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

const same = (a: Selection | undefined, b: Selection | undefined) => a?.machine === b?.machine && a?.thread === b?.thread

/**
 * Feed the registry's listeners from the shell: every machine's threads (and the selected one's hidden ones), the selection and
 * the thread it shows, and the window's focus and visibility.
 */
export function useWindowEvents(registry: Registry, { threads, rejections, hidden, selection, shown }: {
  threads: Record<string, ThreadInfo[] | undefined>
  /** The threads no list shows (extensions' own, Ego's) on the selected machine: their statuses are heard too. */
  hidden?: { machine: string; threads: ThreadInfo[] }
  rejections: Record<string, ProviderRejection[] | undefined>
  selection: Selection | undefined
  shown: ThreadInfo | undefined
}) {
  // The thread shown first, so a listener hearing of its status sees it as shown, with its new status: set as a render
  // commits (layout effects run before the effects below), not during one that may never commit.
  useLayoutEffect(() => { registry.window.thread = shown })
  const statuses = useRef<Statuses>(new Map())
  const selected = useRef<Selection | undefined>(undefined)
  useEffect(() => {
    if (same(selected.current, selection)) return
    const before = selected.current
    selected.current = selection
    registry.emit('select', { selection, before })
  }, [selection?.machine, selection?.thread])
  useEffect(() => {
    const all = hidden ? { ...threads, [hidden.machine]: [...threads[hidden.machine] ?? [], ...hidden.threads] } : threads
    for (const event of statusChanges(statuses.current, all)) registry.emit('thread.status', event)
  }, [threads, hidden?.machine, hidden?.threads])
  const rejected = useRef<Rejected>(new Map())
  useEffect(() => {
    for (const event of rejectionChanges(rejected.current, rejections)) registry.emit('auth.rejected', event)
  }, [rejections])
  useEffect(() => {
    const focus = () => { if (!registry.window.focused) registry.emit('focus', { focused: true }) }
    const blur = () => { if (registry.window.focused) registry.emit('focus', { focused: false }) }
    const visibility = () => {
      const visible = document.visibilityState !== 'hidden'
      if (visible !== registry.window.visible) registry.emit('visibility', { visible })
    }
    // As the window is by now: the registry guessed when it was made, before the page had settled.
    if (document.hasFocus()) focus()
    else blur()
    visibility()
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility) }
  }, [])
}
