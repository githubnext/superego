// The lightbox's zoom: a scale and an offset from the image's fitted place, both kept so the image can't be lost off
// the screen. Points are measured from the middle of the stage.

export type View = { scale: number; x: number; y: number }
/** How the image fits the stage, and the stage itself, in pixels: what panning is bounded by. */
export type Bounds = { width: number; height: number; stageWidth: number; stageHeight: number }
export type Point = { x: number; y: number }

export const FIT: View = { scale: 1, x: 0, y: 0 }
export const MAX_SCALE = 8
/** What a click on a fitted image zooms to. */
export const CLICK_SCALE = 2.5

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Panned no further than the zoomed image's edges reach past the stage's; fitted, centred. */
export function clampPan(view: View, bounds: Bounds): View {
  if (view.scale <= 1) return FIT
  const maxX = Math.max(0, (bounds.width * view.scale - bounds.stageWidth) / 2)
  const maxY = Math.max(0, (bounds.height * view.scale - bounds.stageHeight) / 2)
  return { scale: view.scale, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) }
}

/** Zoomed to `scale` with the point `at` staying where it is on screen (under the cursor, between the fingers). */
export function zoomAt(view: View, scale: number, at: Point, bounds: Bounds): View {
  const next = clamp(scale, 1, MAX_SCALE)
  const k = next / view.scale
  return clampPan({ scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, bounds)
}

/** A click: in to `CLICK_SCALE` at the point clicked, or back out to fit. */
export const toggleAt = (view: View, at: Point, bounds: Bounds): View => view.scale > 1 ? FIT : zoomAt(view, CLICK_SCALE, at, bounds)
