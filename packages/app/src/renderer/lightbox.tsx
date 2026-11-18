// The lightbox: an image of a thread's (one an agent showed, or one in a message or a rendered file) over the whole window, to look at closely. Click or tap to zoom in where you click (again to
// fit), scroll or pinch to zoom, drag to pan; ←/→, the side buttons or a swipe go through the set; Esc, the close
// button or a click beside the image close it. The focus stays inside while it is open and goes back where it was.
// It reads each image whole, showing its thumbnail (what the thread showed) meanwhile.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { CaretLeftIcon, CaretRightIcon, ImageBrokenIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, XIcon } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { describeImage, imageReadAlready, imageSourceOf, useImageSource, type ImageItem } from './images.tsx'
import { CLICK_SCALE, clampPan, FIT, toggleAt, zoomAt, type Bounds, type Point, type View } from './zoom.ts'

/** How far a finger or the mouse may move and still be a click; how far a swipe must go to turn the page. */
const SLOP = 6
const SWIPE = 60

type Gesture = {
  start: Point
  view: View
  moved: boolean
  onImage: boolean
  /** With two fingers down: their distance and midpoint when the pinch began, and the view then. */
  pinch?: { distance: number; mid: Point; view: View }
}

export function Lightbox({ machine, thread, images, start, onClose }: {
  machine: MachineEntry
  thread: string
  images: ImageItem[]
  start: number
  onClose(): void
}) {
  const [index, setIndex] = useState(start)
  const [view, setView] = useState<View>(FIT)
  // A swipe in progress, fitted: how far the image follows the finger.
  const [drag, setDrag] = useState(0)
  // A finger or the mouse on the image: it follows exactly, without easing.
  const [moving, setMoving] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | undefined>(undefined)
  const image = images[index]!
  const whole = useImageSource(machine, thread, image, true, 'whole')
  const { broken, problem } = whole
  const src = whole.src ?? imageReadAlready(machine, thread, image, 'thumbnail')
  // Which image was drawn, and whether whole (any version of it: a newer one swaps in without the spinner between).
  const [drawn, setDrawn] = useState<{ which: string | undefined; whole: boolean }>()
  const which = image.url ?? image.path ?? (image.entry && `${image.entry.id}:${image.entry.message}:${image.entry.block}`)
  const many = images.length > 1

  const go = useCallback((by: number) => {
    if (!many) return
    setIndex((i) => (i + by + images.length) % images.length)
    setView(FIT)
  }, [many, images.length])

  // Its neighbours, read ahead so going through the set doesn't wait.
  useEffect(() => {
    if (!many) return
    // Not there, it's said when it's shown.
    for (const by of [1, -1]) void imageSourceOf(machine, thread, images[(index + by + images.length) % images.length]!, 'whole').catch(() => {})
  }, [machine, thread, images, index, many])

  // The focus inside while it's open, and back where it was after.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null
    root.current?.focus()
    return () => { before?.focus?.() }
  }, [])

  const bounds = (): Bounds => ({
    width: img.current?.offsetWidth ?? 0, height: img.current?.offsetHeight ?? 0,
    stageWidth: stage.current?.clientWidth ?? 0, stageHeight: stage.current?.clientHeight ?? 0,
  })
  /** A point on screen, from the middle of the stage. */
  const fromMiddle = (x: number, y: number): Point => {
    const rect = stage.current!.getBoundingClientRect()
    return { x: x - (rect.left + rect.width / 2), y: y - (rect.top + rect.height / 2) }
  }

  // Scrolling zooms: a trackpad's pinch arrives as a wheel with ctrl, in finer steps.
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002))
      const at = fromMiddle(event.clientX, event.clientY)
      setView((v) => zoomAt(v, v.scale * factor, at, bounds()))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  const down = (event: PointerEvent) => {
    if (event.button !== 0) return
    stage.current?.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const points = [...pointers.current.values()]
    setMoving(true)
    if (points.length === 1) {
      gesture.current = { start: points[0]!, view, moved: false, onImage: event.target === img.current }
    } else if (points.length === 2 && gesture.current) {
      const [a, b] = points as [Point, Point]
      gesture.current.moved = true
      gesture.current.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: fromMiddle((a.x + b.x) / 2, (a.y + b.y) / 2), view }
      setDrag(0)
    }
  }
  const move = (event: PointerEvent) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const g = gesture.current
    const points = [...pointers.current.values()]
    if (g.pinch && points.length >= 2) {
      const [a, b] = points as [Point, Point]
      const mid = fromMiddle((a.x + b.x) / 2, (a.y + b.y) / 2)
      const zoomed = zoomAt(g.pinch.view, g.pinch.view.scale * Math.hypot(a.x - b.x, a.y - b.y) / g.pinch.distance, g.pinch.mid, bounds())
      setView(clampPan({ ...zoomed, x: zoomed.x + mid.x - g.pinch.mid.x, y: zoomed.y + mid.y - g.pinch.mid.y }, bounds()))
      return
    }
    const dx = event.clientX - g.start.x
    const dy = event.clientY - g.start.y
    if (!g.moved && Math.hypot(dx, dy) < SLOP) return
    g.moved = true
    if (g.view.scale > 1) setView(clampPan({ ...g.view, x: g.view.x + dx, y: g.view.y + dy }, bounds()))
    else if (many) setDrag(dx)
  }
  const up = (event: PointerEvent) => {
    if (!pointers.current.delete(event.pointerId)) return
    const g = gesture.current
    if (!g) return
    const left = [...pointers.current.values()]
    if (left.length === 1) {
      // A pinch ended with a finger still down: it pans from here.
      gesture.current = { start: left[0]!, view, moved: true, onImage: false }
      return
    }
    if (left.length) return
    gesture.current = undefined
    setDrag(0)
    setMoving(false)
    if (event.type === 'pointercancel') return
    const dx = event.clientX - g.start.x
    const dy = event.clientY - g.start.y
    if (!g.moved) {
      if (g.onImage) setView((v) => toggleAt(v, fromMiddle(event.clientX, event.clientY), bounds()))
      else onClose()
    } else if (!g.pinch && g.view.scale <= 1 && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1)
  }

  const zoomBy = (factor: number) => setView((v) => zoomAt(v, v.scale * factor, { x: 0, y: 0 }, bounds()))
  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      Escape: onClose,
      ArrowLeft: () => go(-1),
      ArrowRight: () => go(1),
      '+': () => zoomBy(1.5),
      '=': () => zoomBy(1.5),
      '-': () => zoomBy(1 / 1.5),
      '0': () => setView(FIT),
    }
    if (event.key === 'Tab') {
      // Round the lightbox's own buttons, never out behind it.
      const stops = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled)')]
      const at = stops.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length
      stops[next]?.focus()
    } else if (keys[event.key] && !event.metaKey && !event.ctrlKey && !event.altKey) keys[event.key]!()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const label = describeImage(image)
  const zoomed = view.scale > 1
  return createPortal(
    <div ref={root} className="lightbox" role="dialog" aria-modal="true" aria-label={many ? `${label}, ${index + 1} of ${images.length}` : label} tabIndex={-1} onKeyDown={onKeyDown}>
      <div
        ref={stage}
        className={`lightbox__stage ${zoomed ? 'is-zoomed' : ''} ${moving ? 'is-moving' : ''}`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      >
        {broken ? (
          <div className="lightbox__broken"><ImageBrokenIcon size={32} aria-hidden /><span>{image.name} can’t be shown</span>{problem && <span className="lightbox__why">{problem}</span>}</div>
        ) : src && (
          <img
            ref={img}
            key={which}
            src={src}
            alt={image.alt ?? image.caption ?? ''}
            draggable={false}
            className={`lightbox__image ${drawn?.which === which ? 'is-ready' : ''}`}
            onLoad={() => setDrawn({ which, whole: src === whole.src })}
            style={{ transform: `translate(${view.x + drag}px, ${view.y}px) scale(${view.scale})` }}
          />
        )}
        {!broken && !(drawn?.which === which && drawn?.whole) && <div className="lightbox__loading" aria-hidden />}
      </div>
      <div className="lightbox__bar">
        {many && <span className="lightbox__count" aria-hidden>{index + 1} / {images.length}</span>}
        <button type="button" className="lightbox__button" aria-label={zoomed ? 'Zoom out' : 'Zoom in'} title={zoomed ? 'Zoom out (0)' : 'Zoom in (+)'}
          onClick={() => setView((v) => v.scale > 1 ? FIT : zoomAt(v, CLICK_SCALE, { x: 0, y: 0 }, bounds()))} disabled={broken}>
          {zoomed ? <MagnifyingGlassMinusIcon size={18} aria-hidden /> : <MagnifyingGlassPlusIcon size={18} aria-hidden />}
        </button>
        <button type="button" className="lightbox__button" aria-label="Close" title="Close (Esc)" onClick={onClose}><XIcon size={18} aria-hidden /></button>
      </div>
      {many && (
        <>
          <button type="button" className="lightbox__button lightbox__side lightbox__side--prev" aria-label="Previous image" onClick={() => go(-1)}><CaretLeftIcon size={20} weight="bold" aria-hidden /></button>
          <button type="button" className="lightbox__button lightbox__side lightbox__side--next" aria-label="Next image" onClick={() => go(1)}><CaretRightIcon size={20} weight="bold" aria-hidden /></button>
        </>
      )}
      {image.caption && <div className="lightbox__caption">{image.caption}</div>}
    </div>,
    document.body,
  )
}
