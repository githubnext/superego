import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Tooltip as Base } from '@base-ui/react/tooltip'
import { usePortalAttributes } from './portal.tsx'

/** How long the pointer rests on a trigger, or the keyboard's focus, before a card shows: as `Popover`'s with `hover`. */
export const HOVER_DELAY = 400

/** Whether something is being dragged in the window: no card shows meanwhile. */
let dragging = false
if (typeof document !== 'undefined') {
  document.addEventListener('dragstart', () => { dragging = true }, true)
  for (const done of ['dragend', 'drop'] as const) document.addEventListener(done, () => { dragging = false }, true)
}

/**
 * A card of what `children` is, shown while it's pointed at, or has the keyboard's focus, for a moment (`HOVER_DELAY`).
 * Only to look at: it takes no pointer, so a click or a right-click still goes to what it's about, and it closes on any
 * press, on a scroll and while anything is dragged. `children` must be one element that takes a ref (a `ListItem`, a
 * button). Inside a `TooltipProvider`, going from one trigger to the next shows the next card at once.
 */
export function HoverCard({ card, children, side = 'right', className = '' }: {
  card: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right'; className?: string
}) {
  const marked = usePortalAttributes()
  const [open, setOpen] = useState(false)
  const focusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const close = () => { clearTimeout(focusTimer.current); setOpen(false) }
  useEffect(() => {
    if (!open) return
    // A press anywhere (a click, a right-click's menu), a scroll or a drag puts it away.
    const shut = () => close()
    const events = ['pointerdown', 'scroll', 'dragstart'] as const
    for (const event of events) document.addEventListener(event, shut, true)
    return () => { for (const event of events) document.removeEventListener(event, shut, true) }
  }, [open])
  useEffect(() => () => clearTimeout(focusTimer.current), [])
  return (
    <Base.Root open={open} disableHoverablePopup onOpenChange={(next, { reason }) => {
      clearTimeout(focusTimer.current)
      if (!next) return setOpen(false)
      if (dragging) return
      // Focus (from the keyboard: the pointer's clicks don't count) shows it at once; it waits like the pointer does.
      if (reason === 'trigger-focus') focusTimer.current = setTimeout(() => { if (!dragging) setOpen(true) }, HOVER_DELAY)
      else setOpen(true)
    }}>
      <Base.Trigger render={children} delay={HOVER_DELAY} />
      <Base.Portal>
        <Base.Positioner {...marked} className="superego-layer" side={side} align="start" sideOffset={8}>
          <Base.Popup className={`superego-hover-card ${className}`}>{card}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
