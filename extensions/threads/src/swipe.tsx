// Swipe actions on a thread's row, as iOS Mail has them, for a finger on a phone's drawer. Swiped left, the row slides
// over to show its trailing actions; right, its leading one. Let go past halfway, it stays open on them (a tap on one
// does it); swiped most of the way across (or flicked past it), the outermost one stretches over the rest and is done.
// One row is open at a time; a tap anywhere else, or a scroll, closes it. The drawer's own swipe (left, to close it)
// and the list's scrolling keep the rest: a row takes the touch only once it's gone a few points sideways, more than
// down (`touch-action: pan-y` leaves the vertical to the page, `data-base-ui-swipe-ignore` the horizontal to the row).
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type PointerEvent, type ReactNode } from 'react'

export type SwipeAction = {
  id: string
  label: string
  icon: ComponentType<{ size?: number; weight?: 'fill' | 'regular' | 'bold'; 'aria-hidden'?: boolean }>
  /** Its colour (app.css): `archive` (destructive), `pin`, `more`. */
  tone: string
  run(): void | Promise<unknown>
  /** Done, the row slides away (it's leaving the list), rather than back. */
  leaves?: boolean
}

/** How far the finger goes before the gesture is a swipe or a scroll; and one action's width, open. */
const SLOP = 8
const WIDE = 74
/** How fast a flick (px/ms) opens or closes a row whatever how far it went. */
const FLICK = 0.4

/** The row that's open (or being swiped): opening another closes it. */
let current: { close(): void } | undefined

type Side = 'leading' | 'trailing'

/**
 * The swipe on a row: `on` while a finger works the phone's drawer. `leading` and `trailing` are each side's actions,
 * from the edge in: the first is the one a full swipe does. Gives the row's props and what to put in it, the actions.
 */
export function useRowSwipe({ on, leading, trailing }: { on: boolean; leading: SwipeAction[]; trailing: SwipeAction[] }) {
  const row = useRef<HTMLElement | null>(null)
  const [side, setSide] = useState<Side>()
  const [armed, setArmed] = useState(false)
  const gesture = useRef<{ id: number; x0: number; y0: number; base: number; axis?: 'x' | 'y'; last: { x: number; t: number }; v: number } | undefined>(undefined)
  const offset = useRef(0)
  // Whether the last touch on it went sideways: then it wasn't a long press (for its context menu).
  const sideways = useRef(false)
  const self = useRef<{ close(): void }>({ close: () => settle(0) })
  // Its listeners while open: a press elsewhere or a scroll closes it.
  const unlisten = useRef<() => void>(undefined)

  const width = () => row.current?.offsetWidth ?? 320
  const room = (s: Side) => (s === 'leading' ? leading : trailing).length * WIDE
  const place = (x: number, settling = false) => {
    const el = row.current
    if (!el) return
    offset.current = x
    el.classList.toggle('is-settling', settling)
    el.classList.toggle('is-swiped', x !== 0)
    el.style.setProperty('--swipe', `${x}px`)
  }
  function settle(x: number) {
    place(x, true)
    if (x === 0) {
      setArmed(false)
      unlisten.current?.()
      unlisten.current = undefined
      if (current === self.current) current = undefined
    }
  }
  // Open: one at a time, closed by a press anywhere but its actions (the press on another row doesn't pick it), or by a scroll.
  const opened = (x: number) => {
    settle(x)
    if (current && current !== self.current) current.close()
    current = self.current
    if (unlisten.current) return
    const press = (event: Event) => {
      const target = event.target as Element
      // On the row itself: its own gesture says (a tap closes it, a drag moves it).
      if (row.current?.contains(target)) return
      settle(0)
      if (target.closest?.('.superego-list-item')) swallowClick()
    }
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !row.current?.contains(event.target)) settle(0) }
    document.addEventListener('pointerdown', press, true)
    document.addEventListener('scroll', scroll, true)
    unlisten.current = () => {
      document.removeEventListener('pointerdown', press, true)
      document.removeEventListener('scroll', scroll, true)
    }
  }
  useEffect(() => () => { unlisten.current?.(); if (current === self.current) current = undefined }, [])
  // Off (the window widened, a mouse), the row goes back.
  useEffect(() => { if (!on && offset.current) settle(0) }, [on])

  // Past this, letting go does the outermost action: most of the way across, and past the open actions.
  const reach = (s: Side) => Math.max(width() * 0.55, room(s) + 40)
  const follow = (x: number) => {
    const s: Side | undefined = x > 0 ? 'leading' : x < 0 ? 'trailing' : undefined
    const actions = s === 'leading' ? leading : trailing
    if (s && !actions.length) x = 0
    // Past the row's width, it gives a little: a rubber band.
    const max = width()
    const abs = Math.abs(x)
    if (abs > max) x = Math.sign(x) * (max + (abs - max) * 0.25)
    setSide((was) => s ?? was)
    setArmed(Boolean(s) && Math.abs(x) >= reach(s!))
    place(x)
  }

  const end = (cancelled: boolean) => {
    const g = gesture.current
    gesture.current = undefined
    if (!g || g.axis !== 'x') return
    swallowClick(row.current)
    const x = offset.current
    const s: Side | undefined = x > 0 ? 'leading' : x < 0 ? 'trailing' : undefined
    if (!s || cancelled) return x ? opened(x > 0 ? room('leading') : -room('trailing')) : settle(0)
    const sign = s === 'leading' ? 1 : -1
    const v = g.v * sign
    const full = s === 'leading' ? leading[0] : trailing[0]
    if (full && (Math.abs(x) >= reach(s) || (v > FLICK * 3 && Math.abs(x) > room(s)))) return commit(full, s)
    if (v < -FLICK) return settle(0)
    if (Math.abs(x) > room(s) / 2 || v > FLICK) return opened(sign * room(s))
    settle(0)
  }

  // An action done: from its button, or the outermost by a full swipe (stretched over the row first).
  const commit = (action: SwipeAction, s: Side) => {
    setSide(s)
    setArmed(true)
    if (action.leaves) place((s === 'leading' ? 1 : -1) * width(), true)
    else settle(0)
    if (current === self.current) { unlisten.current?.(); unlisten.current = undefined; current = undefined }
    void Promise.resolve(action.run()).finally(() => {
      // Still here (it failed, or the list hasn't caught up yet): back in place.
      if (action.leaves) setTimeout(() => { if (row.current?.isConnected) settle(0) }, 1500)
    })
  }

  const rowProps = on ? {
    className: 'threads-swipe',
    'data-base-ui-swipe-ignore': '',
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== 'touch' || !event.isPrimary) return
      if ((event.target as Element).closest('.threads-swipe__actions')) return
      row.current = event.currentTarget
      sideways.current = false
      if (current && current !== self.current) current.close()
      gesture.current = { id: event.pointerId, x0: event.clientX, y0: event.clientY, base: offset.current, last: { x: event.clientX, t: event.timeStamp }, v: 0 }
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const g = gesture.current
      if (!g || g.id !== event.pointerId) return
      const dx = event.clientX - g.x0
      const dy = event.clientY - g.y0
      if (!g.axis) {
        if (Math.hypot(dx, dy) < SLOP) return
        g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
        if (g.axis === 'y') { gesture.current = undefined; return }
        // Held by the row as it moves off from under the finger. A pointer already gone (lifted, cancelled) can't be: harmless, as its end comes anyway.
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* see above */ }
        sideways.current = true
        if (current && current !== self.current) current.close()
        current = self.current
      }
      const dt = event.timeStamp - g.last.t
      if (dt > 0) g.v = (event.clientX - g.last.x) / dt
      g.last = { x: event.clientX, t: event.timeStamp }
      follow(g.base + dx)
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const g = gesture.current
      if (g?.id !== event.pointerId) return
      // A tap on an open row closes it, and isn't a tap on the row.
      if (!g.axis && offset.current) {
        gesture.current = undefined
        swallowClick(row.current)
        return settle(0)
      }
      end(false)
    },
    // The page took it (a scroll), or the system did.
    onPointerCancel(event: PointerEvent<HTMLElement>) { if (gesture.current?.id === event.pointerId) end(true) },
  } : {}

  const button = (action: SwipeAction, s: Side) => (
    <button key={action.id} type="button" className={`threads-swipe__action threads-swipe__action--${action.tone}`} data-action={action.id}
      onClick={(event) => { event.stopPropagation(); commit(action, s) }}>
      <action.icon size={20} weight="fill" aria-hidden />
      <span>{action.label}</span>
    </button>
  )
  // Each side from its edge in: the leading's outermost first, the trailing's last.
  const actions: ReactNode = on && side ? (
    <span className={`threads-swipe__actions threads-swipe__actions--${side} ${armed ? 'is-armed' : ''}`} role="group" aria-label="Actions"
      onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      {side === 'leading' ? leading.map((a) => button(a, side)) : [...trailing].reverse().map((a) => button(a, side))}
    </span>
  ) : null
  /** Whether the row is swiped, or its last touch was a swipe: not a long press, whatever the timer says. */
  const swiped = () => sideways.current || offset.current !== 0
  return { rowProps, actions, swiped }
}

/** The click a swipe (or the tap that closed an open row) ends with isn't a tap on what's under it: dropped, on rows. */
function swallowClick(within?: Element | null) {
  const drop = (event: MouseEvent) => {
    const target = event.target as Element
    if (within ? within.contains(target) : target.closest?.('.superego-list-item')) {
      event.preventDefault()
      event.stopPropagation()
    }
    done()
  }
  const timer = setTimeout(() => done(), 600)
  const done = () => { clearTimeout(timer); window.removeEventListener('click', drop, true) }
  window.addEventListener('click', drop, true)
}

const COARSE = '(pointer: coarse)'
/** Whether the device's main pointer is a finger (@superego/ui's touch.ts): swipes are for one. */
export const useCoarse = () => useSyncExternalStore((change) => {
  const list = matchMedia(COARSE)
  list.addEventListener('change', change)
  return () => list.removeEventListener('change', change)
}, () => matchMedia(COARSE).matches)
