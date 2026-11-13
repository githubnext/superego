// What the window tells extensions as it happens (`superego.on`, see WindowEvents): threads' statuses changing, the
// thread shown changing, and the window's focus and visibility. The shell's state feeds it; the registry passes it on.
import { useEffect, useRef } from 'react'
import type { Status, ThreadInfo } from '@superego/protocol'
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

const same = (a: Selection | undefined, b: Selection | undefined) => a?.machine === b?.machine && a?.thread === b?.thread

/**
 * Feed the registry's listeners from the shell: every machine's threads (and the selected one's hidden ones), the selection and
 * the thread it shows, and the window's focus and visibility.
 */
export function useWindowEvents(registry: Registry, { threads, hidden, selection, shown }: {
  threads: Record<string, ThreadInfo[] | undefined>
  /** The threads no list shows (extensions' own, Ego's) on the selected machine: their statuses are heard too. */
  hidden?: { machine: string; threads: ThreadInfo[] }
  selection: Selection | undefined
  shown: ThreadInfo | undefined
}) {
  // The thread shown first, so a listener hearing of its status sees it as shown, with its new status.
  registry.window.thread = shown
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
