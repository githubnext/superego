// Changing the layout: what Settings → Layout and the views' "Move to…" menus do to `app.layout`. Each takes the views
// and the user's layout and gives the layout after, keeping only what differs from the views' own defaults. `narrow`
// changes the phone's layer (`layout.narrow`) instead, on top of the wide one.
import { placeIn, resolveLayout, type Layout, type Place, type Placeable, type Placement } from './layout.ts'

type Layer = Omit<Layout, 'narrow'>
type Options = { narrow?: boolean }

const list = (placement: Placement | undefined): Place[] => !placement ? [] : Array.isArray(placement) ? placement : [placement]
const same = (a: Place[], b: Place[]) => a.length === b.length && a.every((p) => b.includes(p))
const stored = (places: Place[]) => places.length === 0 ? null : places.length === 1 ? places[0]! : places

/** The layer an edit changes: the wide layout, or its narrow one. */
const layerOf = (layout: Layout | undefined, narrow: boolean): Layer => (narrow ? layout?.narrow : layout) ?? {}

/** `layout` with `layer` as its wide (or narrow) layer, empty parts left out. */
function withLayer(layout: Layout | undefined, layer: Layer, narrow: boolean): Layout {
  const place = layer.place && Object.keys(layer.place).length ? layer.place : undefined
  const order = layer.order ? Object.fromEntries(Object.entries(layer.order).filter(([, ids]) => ids?.length)) : undefined
  const tidy: Layer = { ...(place ? { place } : {}), ...(order && Object.keys(order).length ? { order } : {}) }
  if (!narrow) return { ...tidy, ...(layout?.narrow ? { narrow: layout.narrow } : {}) }
  const { narrow: _old, ...wide } = layout ?? {}
  return { ...wide, ...(Object.keys(tidy).length ? { narrow: tidy } : {}) }
}

/** Where `view` goes in a layer when that layer says nothing of it. */
function baseOf(view: Placeable, layout: Layout | undefined, narrow: boolean): Place[] {
  const user = layout?.place ?? {}
  const places = !narrow ? list(view.default)
    : view.narrow !== undefined ? list(view.narrow)
    : view.id in user ? list(user[view.id])
    : list(view.default)
  return places.filter((p) => view.fits.includes(p))
}

/** The places `view` is in now. */
export const placesOf = (views: readonly Placeable[], layout: Layout | undefined, view: string, { narrow = false }: Options = {}): Place[] =>
  Object.entries(resolveLayout(views, layout, { narrow })).filter(([, ids]) => ids.includes(view)).map(([p]) => p as Place)

/**
 * The layout with `view` put in `place` (`on`) or taken out of it (unset: toggled); with `from`, taken out of that place
 * at the same time (moved). As `layout.place` does.
 */
export function placeView(views: readonly Placeable[], layout: Layout | undefined, view: string, place: Place,
  { on, from, narrow = false }: { on?: boolean; from?: Place } & Options = {}): Layout {
  const found = views.find((v) => v.id === view)
  if (!found) return layout ?? {}
  if (from && from !== place) return placeView(views, placeView(views, layout, view, place, { on: true, narrow }), view, from, { on: false, narrow })
  if (!narrow) return placeIn(views, layout, view, place, on)
  const now = placesOf(views, layout, view, { narrow })
  const want = on ?? !now.includes(place)
  const next = want ? [...new Set([...now, place])] : now.filter((p) => p !== place)
  const layer = layerOf(layout, true)
  const { [view]: _old, ...others } = layer.place ?? {}
  const kept = same(next, baseOf(found, layout, true)) && !found.withoutSpaces ? others : { ...others, [view]: stored(next) }
  return withLayer(layout, { ...layer, place: kept }, true)
}

/** The layout with `view` taken out of `place`, and out of the order kept for it there. */
export function removeView(views: readonly Placeable[], layout: Layout | undefined, view: string, place: Place, options: Options = {}): Layout {
  const narrow = options.narrow ?? false
  const next = placeView(views, layout, view, place, { on: false, narrow })
  const layer = layerOf(next, narrow)
  const ids = layer.order?.[place]
  if (!ids?.includes(view)) return next
  return withLayer(next, { ...layer, order: { ...layer.order, [place]: ids.filter((id) => id !== view) } }, narrow)
}

/** The layout with `view` at `index` among the views in `place` (clamped), the order kept whole for that place. */
export function moveViewTo(views: readonly Placeable[], layout: Layout | undefined, view: string, place: Place, index: number, options: Options = {}): Layout {
  const narrow = options.narrow ?? false
  const ids = resolveLayout(views, layout, { narrow })[place]
  const from = ids.indexOf(view)
  if (from < 0) return layout ?? {}
  const to = Math.max(0, Math.min(ids.length - 1, index))
  if (to === from) return layout ?? {}
  const order = ids.filter((id) => id !== view)
  order.splice(to, 0, view)
  const layer = layerOf(layout, narrow)
  return withLayer(layout, { ...layer, order: { ...layer.order, [place]: order } }, narrow)
}

/** The layout with `view` `by` steps later in `place` (negative: earlier). */
export const moveView = (views: readonly Placeable[], layout: Layout | undefined, view: string, place: Place, by: number, options: Options = {}): Layout =>
  moveViewTo(views, layout, view, place, resolveLayout(views, layout, { narrow: options.narrow ?? false })[place].indexOf(view) + by, options)

/** The views that fit `place` and aren't in it now: what it can add. */
export function addable<V extends Placeable>(views: readonly V[], layout: Layout | undefined, place: Place, { narrow = false }: Options = {}): V[] {
  const placed = resolveLayout(views, layout, { narrow })[place]
  return views.filter((v) => v.fits.includes(place) && !placed.includes(v.id))
}

/** The layout with `place` as the views' defaults say (in its layer): who's there, and in what order. */
export function resetPlace(views: readonly Placeable[], layout: Layout | undefined, place: Place, { narrow = false }: Options = {}): Layout {
  const layer = layerOf(layout, narrow)
  const { [place]: _order, ...order } = layer.order ?? {}
  const kept: Record<string, Place | Place[] | null> = {}
  for (const [id, placement] of Object.entries(layer.place ?? {})) {
    const view = views.find((v) => v.id === id)
    if (!view) { kept[id] = placement; continue }
    const base = baseOf(view, layout, narrow)
    const places = list(placement ?? undefined).filter((p) => p !== place)
    const next = base.includes(place) ? [...places, place] : places
    if (!same(next, base)) kept[id] = stored(next)
  }
  return withLayer(layout, { place: kept, order }, narrow)
}

/** Whether `place` differs from its defaults (in its layer). */
export const isChanged = (views: readonly Placeable[], layout: Layout | undefined, place: Place, options: Options = {}) =>
  JSON.stringify(resetPlace(views, layout, place, options)) !== JSON.stringify(withLayer(layout, layerOf(layout, options.narrow ?? false), options.narrow ?? false))
