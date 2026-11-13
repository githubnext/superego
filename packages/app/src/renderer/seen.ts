// Looking at a finished or failed thread marks it seen: shown in a window that has the focus, when it's selected, when
// it finishes while shown, or when the window comes back to the front showing it. A question (blocked) waits for its
// answer instead.
import type { UiApi } from './extension.tsx'

export function registerSeen(core: UiApi) {
  const look = () => {
    const { focused, visible, selection, thread } = core.window
    if (!focused || !visible || !selection || thread?.id !== selection.thread) return
    if (thread.status.state !== 'done' && thread.status.state !== 'error') return
    void core.dispatch('thread.seen', { id: selection.thread }, { machine: selection.machine, source: 'auto' }).catch(() => {})
  }
  core.on('select', look)
  core.on('focus', ({ focused }) => { if (focused) look() })
  core.on('visibility', ({ visible }) => { if (visible) look() })
  core.on('thread.status', ({ machine, thread }) => {
    const { selection } = core.window
    if (selection?.machine === machine && selection.thread === thread.id) look()
  })
}
