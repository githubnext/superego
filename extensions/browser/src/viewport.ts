// The sizes a Browser pane's page can be shown at (its toolbar's size menu): a phone's, a tablet's, a laptop's, the
// pane's own (none), or one typed in. And how a page at a size fits its pane: centred, scaled down when it's wider or
// taller than the pane, never up.
import type { Viewport } from './shared.ts'

export const PRESETS = [
  { id: 'small', label: 'Small', width: 390 },
  { id: 'medium', label: 'Medium', width: 768 },
  { id: 'large', label: 'Large', width: 1280 },
] as const

export type Preset = (typeof PRESETS)[number]

/** The preset a viewport is, if it's one (a width alone). */
export const presetOf = (viewport: Viewport | undefined) =>
  viewport && viewport.height === undefined ? PRESETS.find((p) => p.width === viewport.width) : undefined

/** The smallest and largest a side may be. */
const MIN = 100, MAX = 8000

/** A size typed in: `1024`, `1024x768`, `1024 × 768` (px optional); none when it isn't one. */
export function parseViewport(text: string): Viewport | undefined {
  const match = /^\s*(\d+)\s*(?:px)?\s*(?:[x×*,]\s*(\d+)\s*(?:px)?)?\s*$/i.exec(text)
  if (!match) return undefined
  const width = Number(match[1]), height = match[2] === undefined ? undefined : Number(match[2])
  if ([width, height ?? MIN].some((side) => side < MIN || side > MAX)) return undefined
  return height === undefined ? { width } : { width, height }
}

/** A viewport as the toolbar says it: `390`, `1024×768`. */
export const viewportText = ({ width, height }: Viewport) => height === undefined ? String(width) : `${width}×${height}`

/** Whether a pane's params hold a viewport: a positive width, and a height if any. */
export const isViewport = (value: unknown): value is Viewport => {
  const v = value as Viewport | undefined
  return typeof v?.width === 'number' && v.width > 0 && (v.height === undefined || (typeof v.height === 'number' && v.height > 0))
}

/** Where a page at `viewport` goes in a stage `width` × `height`: its box's size, place and scale. None: it fills the stage. */
export type Fit = { width: number; height: number; left: number; top: number; scale: number }

export function fit(viewport: Viewport | undefined, width: number, height: number): Fit | undefined {
  if (!viewport) return undefined
  // A stage not laid out (yet) doesn't scale it.
  const scale = Math.min(1, width ? width / viewport.width : 1, viewport.height !== undefined && height ? height / viewport.height : 1)
  return {
    width: viewport.width, height: viewport.height ?? height / scale, scale,
    left: width ? (width - viewport.width * scale) / 2 : 0,
    top: viewport.height !== undefined && height ? (height - viewport.height * scale) / 2 : 0,
  }
}
