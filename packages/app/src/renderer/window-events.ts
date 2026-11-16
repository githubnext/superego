// What the window tells extensions as it happens (`superego.on`, see WindowEvents): threads' statuses changing, the
// thread shown changing, a machine's provider rejecting its credentials, and the window's focus and visibility. The
// shell's state feeds it (the changes worked out as shared/changes.ts does); the registry passes it on.
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ProviderRejection, ThreadInfo } from '@superego/protocol'
import { rejectionChanges, statusChanges, type Rejected, type Statuses } from '../shared/changes.ts'
import type { Registry } from './extension.tsx'
import type { Selection } from './state.tsx'

const same = (a: Selection | undefined, b: Selection | undefined) => a?.machine === b?.machine && a?.thread === b?.thread

/**
 * Feed the registry's listeners from the shell: every machine's threads (and its hidden ones), the selection and
 * the thread it shows, and the window's focus and visibility.
 */
export function useWindowEvents(registry: Registry, { threads, rejections, hidden, selection, shown }: {
  threads: Record<string, ThreadInfo[] | undefined>
  /** The threads no list shows (extensions' own, Ego's), by machine: their statuses are heard too. */
  hidden?: Record<string, ThreadInfo[] | undefined>
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
    const all = { ...threads }
    for (const [machine, list] of Object.entries(hidden ?? {})) if (list?.length) all[machine] = [...threads[machine] ?? [], ...list]
    for (const event of statusChanges(statuses.current, all)) registry.emit('thread.status', event)
  }, [threads, hidden])
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
