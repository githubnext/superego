// Moving a view: what `layout.place` (⌘I, the views' "Move to…" menus) does to `app.layout`. It takes the views and the
// user's layout and gives the layout after, keeping only what differs from the views' own defaults. `narrow` changes the
// phone's layer (`layout.narrow`) instead, on top of the wide one.
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
