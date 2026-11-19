// A phone's drawer under a finger, as native apps have it: a swipe right from the screen's left edge pulls it out, a
// swipe left on it (or on the scrim beside it) pushes it back, the drawer following the finger and, let go, settling open
// or shut by how far it came and how fast. A touch that goes up or down first is left alone, to scroll; so is one that
// starts on something scrolled sideways (a code block, a table), which a swipe right scrolls back.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** How near the screen's left edge a swipe starts to pull the drawer out, in CSS pixels. */
export const EDGE = 24
/** How far a touch moves before it's taken as going sideways or up and down. */
export const SLOP = 8
/** A flick this fast (px/ms) settles the drawer the way it goes, however far it came. */
export const FLICK = 0.3
/** How long the drawer takes to settle, as app.css has it. */
export const SETTLE_MS = 250

/**
 * Which way a touch goes, once it's moved `slop` from where it started: 'x' when mostly sideways (under about 40° from
 * the horizontal), 'y' otherwise; undefined until then.
 */
export function axisOf(dx: number, dy: number, slop = SLOP): 'x' | 'y' | undefined {
  if (Math.hypot(dx, dy) < slop) return undefined
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'
}

/** Whether a touch going sideways by `dx` moves the drawer: out when it's shut, back when it's open. */
export function pulls(open: boolean, dx: number): boolean {
  return open ? dx < 0 : dx > 0
}

/** How far out the drawer is (0 shut, `width` open) with the finger `dx` from where it started. */
export function drawerOffset(open: boolean, dx: number, width: number): number {
  return Math.min(width, Math.max(0, (open ? width : 0) + dx))
}

/**
 * Whether the drawer settles open, let go `offset` out of `width` with the finger going `velocity` px/ms (rightward
 * positive): a flick goes its way; otherwise, open past halfway.
 */
export function settlesOpen(offset: number, width: number, velocity: number): boolean {
  if (Math.abs(velocity) >= FLICK) return velocity > 0
  return offset > width / 2
}

/** Whether something under `target`, up to `root`, is scrolled sideways: a swipe right there scrolls it back. */
function scrolledSideways(target: Element | null, root: Element): boolean {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth) return true
  }
  return false
}

type Touch = { x: number; y: number; open: boolean; axis?: 'x' | 'y'; moves: { x: number; t: number }[] }

/** How fast the finger went sideways (px/ms) over its last `window` ms of `moves`, as of `now`; still since, 0. */
export function velocityOf(moves: readonly { x: number; t: number }[], now: number, window = 100): number {
  const last = moves.at(-1)
  if (!last || now - last.t > window) return 0
  const first = moves.find((m) => last.t - m.t <= window)!
  return last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0
}

/**
 * The drawer's swipes, while `enabled` (narrow, with a drawer to show): `moving` while a finger has it or it's settling,
 * when it's drawn whatever `open` says; the refs go on the drawer and its scrim, which it moves itself (transforms, no
 * render per move); `close` closes it, sliding.
 */
export function useDrawerSwipe(enabled: boolean, open: boolean, setOpen: (open: boolean) => void) {
  const [moving, setMoving] = useState<'drag' | 'settle' | undefined>()
  const drawer = useRef<HTMLElement | null>(null)
  const scrim = useRef<HTMLDivElement | null>(null)
  // Where the drawer is while a finger has it, and where it goes once let go.
  const offset = useRef(0)
  const target = useRef<boolean | undefined>(undefined)
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const openRef = useRef(open)
  openRef.current = open
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen

  // Draws the drawer where the finger has it, or where it settles.
  const place = useCallback(() => {
    const el = drawer.current
    if (!el) return
    if (target.current !== undefined) {
      el.style.transform = target.current ? 'translate3d(0, 0, 0)' : 'translate3d(-100%, 0, 0)'
      if (scrim.current) scrim.current.style.opacity = target.current ? '1' : '0'
      return
    }
    const width = el.offsetWidth || 1
    el.style.transform = `translate3d(${offset.current - width}px, 0, 0)`
    if (scrim.current) scrim.current.style.opacity = String(offset.current / width)
  }, [])

  // Sliding to `to`, then back to what app.css draws (or nothing, shut).
  const settle = useCallback((to: boolean) => {
    target.current = to
    setOpenRef.current(to)
    // Placed once the drawer's drawn to slide (not as it follows a finger, which app.css draws without transitions).
    setMoving('settle')
    clearTimeout(settleTimer.current)
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    settleTimer.current = setTimeout(() => {
      target.current = undefined
      drawer.current?.style.removeProperty('transform')
      scrim.current?.style.removeProperty('opacity')
      setMoving(undefined)
    }, reduced ? 0 : SETTLE_MS)
  }, [place])

  // The drawer just drawn (pulled out from shut) starts under the finger before it's painted; let go, it slides from
  // there to where it settles.
  useLayoutEffect(() => { if (moving) place() }, [moving, place])

  useEffect(() => {
    if (!enabled) return
    let touch: Touch | undefined
    const start = (event: TouchEvent) => {
      touch = undefined
      if (event.touches.length !== 1 || target.current !== undefined) return
      const t = event.touches[0]!
      const on = event.target instanceof Element ? event.target : null
      const isOpen = openRef.current
      if (isOpen ? !on?.closest('.app__sidebar, .app__scrim--drawer') : t.clientX > EDGE || !on?.closest('.app__main') || scrolledSideways(on, document.body)) return
      touch = { x: t.clientX, y: t.clientY, open: isOpen, moves: [{ x: t.clientX, t: event.timeStamp }] }
    }
    const move = (event: TouchEvent) => {
      if (!touch) return
      if (event.touches.length !== 1) return end(event)
      const t = event.touches[0]!
      const dx = t.clientX - touch.x
      if (!touch.axis) {
        const axis = axisOf(dx, t.clientY - touch.y)
        if (!axis) return
        // Up and down, the wrong way, or already scrolling (the browser has it): not the drawer's.
        if (axis === 'y' || !pulls(touch.open, dx) || !event.cancelable) { touch = undefined; return }
        touch.axis = 'x'
        target.current = undefined
        setMoving('drag')
      }
      event.preventDefault()
      touch.moves.push({ x: t.clientX, t: event.timeStamp })
      if (touch.moves.length > 20) touch.moves.shift()
      offset.current = drawerOffset(touch.open, dx, drawer.current?.offsetWidth ?? Infinity)
      place()
    }
    const end = (event: TouchEvent) => {
      const was = touch
      touch = undefined
      if (!was?.axis) return
      const width = drawer.current?.offsetWidth ?? 1
      // Cancelled (the system took the touch), it goes back as it was.
      settle(event.type === 'touchcancel' ? was.open : settlesOpen(offset.current, width, velocityOf(was.moves, event.timeStamp)))
    }
    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end)
    document.addEventListener('touchcancel', end)
    return () => {
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', end)
      document.removeEventListener('touchcancel', end)
    }
  }, [enabled, place, settle])

  // Wide again, nothing's moving.
  useEffect(() => {
    if (enabled) return
    clearTimeout(settleTimer.current)
    target.current = undefined
    setMoving(undefined)
  }, [enabled])
  useEffect(() => () => clearTimeout(settleTimer.current), [])

  return { moving: moving !== undefined, dragging: moving === 'drag', drawer, scrim, close: () => settle(false) }
}
