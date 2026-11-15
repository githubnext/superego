// The sidebar's edge, wide: dragged, it makes the sidebar wider or narrower (between MIN_WIDTH and MAX_WIDTH, kept as an
// app setting); let go short of FOLD_AT, the open space folds into its slim form in the rail (its view's `fold` action),
// or the sidebar closes for a space without one. A double click puts the width back. With the sidebar hidden (closed,
// or folded) the edge is the rail's, and dragging out from it unfolds the sidebar at the width it's dragged to.
import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useAppSetting } from './client.ts'
import { useRegistry, type View } from './extension.tsx'
import { useSidebar } from './state.tsx'
import { DEFAULT_WIDTH, dragSidebar, release, SIDEBAR_WIDTH, sidebarWidth } from './sidebar-width.ts'

type Drag = { width: number; folds: boolean; done?: boolean }

/**
 * For the window, given the open space: the sidebar's width as a style for `.app` (`--superego-sidebar`, which the
 * title bar's measures follow too), its class while a drag would fold it, and the edge to drag, to go after the sidebar.
 */
export function useSidebarEdge(space: View | undefined) {
  const [kept, keep] = useAppSetting<number>(SIDEBAR_WIDTH)
  const stored = sidebarWidth(kept)
  const sidebar = useSidebar()
  const dispatch = useRegistry().router.dispatch
  // While dragged, and after until the setting comes back with the new width: then it's the setting's again.
  const [drag, setDrag] = useState<Drag>()
  useEffect(() => setDrag((d) => d?.done ? undefined : d), [stored])
  const width = drag?.width ?? stored

  // Folded into the rail and back by the space's own action; one without closes, and opens, the sidebar.
  const run = (action: string, on: boolean) => void dispatch(action, { on }, { source: 'sidebar' }).catch((error) => console.error(error))
  const fold = () => space?.fold ? run(space.fold, true) : sidebar.toggle(false)
  const unfold = () => {
    if (!sidebar.open) sidebar.toggle(true)
    if (space?.fold) run(space.fold, false)
  }
  // The sidebar is beside its edge, shown while what's in it draws something (app.css hides it otherwise).
  const shown = (edge: Element) => edge.previousElementSibling?.matches('.app__sidebar') === true && edge.previousElementSibling.getBoundingClientRect().width > 0

  // A new width: shown at once, and kept.
  const settle = (next: number) => {
    setDrag({ width: next, folds: false, done: true })
    void keep(next).catch((error) => { console.error(error); setDrag(undefined) })
  }
  const down = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const out = shown(event.currentTarget)
    // Dragged from the rail, the sidebar starts at no width, and comes out once it's dragged past FOLD_AT.
    const start = out ? width : 0
    let unfolded = out
    let last: Drag | undefined
    const move = (e: PointerEvent) => {
      const next = dragSidebar(start + e.clientX - startX)
      if (!unfolded) {
        if (next.folds) return
        unfolded = true
        unfold()
      }
      last = next
      setDrag(next)
    }
    const root = document.documentElement
    const up = () => {
      root.classList.remove('is-resizing-columns')
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      const then = release(last, stored)
      if (typeof then !== 'number') {
        setDrag(undefined)
        if (then === 'fold') fold()
      } else settle(then)
    }
    root.classList.add('is-resizing-columns')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    event.preventDefault()
    event.stopPropagation()
  }
  const reset = (event: ReactMouseEvent<HTMLElement>) => {
    if (shown(event.currentTarget) && stored !== DEFAULT_WIDTH) settle(DEFAULT_WIDTH)
  }
  return {
    style: { '--superego-sidebar': `${width}px` } as CSSProperties,
    folding: Boolean(drag?.folds),
    edge: (
      <div className={`app__edge ${drag && !drag.done ? 'is-dragged' : ''}`} onPointerDown={down} onDoubleClick={reset}
        role="separator" aria-orientation="vertical" aria-label="Sidebar width" title="Drag to resize, double-click to reset" />
    ),
  }
}
