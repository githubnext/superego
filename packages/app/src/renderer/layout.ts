// Where views go. Extensions declare views (`superego.view`): what each is, the context it needs and the places it fits,
// and where it goes by default. The shell has places and knows no extension. The app setting `app.layout` holds what
// the user changed, as `app.keys` does for shortcuts: resolving puts every view in its places, defaults first, then
// the user's changes, and on a phone (or a narrow window) the narrow ones.
import type { Json } from '@superego/protocol'

/**
 * A kind of place in the window:
 * - `space`: a button in the rail, and the sidebar while it's the open one (on a phone, the drawer)
 * - `rail`: a button in the rail that isn't a space (Ego's)
 * - `drawer`: at the foot of a phone's drawer, beside Settings, where there's no rail
 * - `titlebar`: at the title bar's start, after back and forward (the core's thread picker, with no space)
 * - `beside`: a column beside the thread
 * - `pane`: in the thread's pane menu, opened as a pane beside it
 * - `header`: right of the thread's title: a button, a badge
 */
export type Place = 'space' | 'rail' | 'drawer' | 'titlebar' | 'beside' | 'pane' | 'header'
export const PLACES: Place[] = ['space', 'rail', 'drawer', 'titlebar', 'beside', 'pane', 'header']
/** The places a wide window draws, and a phone's (the column beside the thread in its sheet; its title bar only while there's no space). */
export const WIDE_PLACES: Place[] = ['space', 'rail', 'titlebar', 'beside', 'pane', 'header']
export const NARROW_PLACES: Place[] = ['space', 'drawer', 'beside', 'pane', 'header']
/** The places that show a thread: a view drawn there gets it. */
export const THREAD_PLACES: Place[] = ['beside', 'pane', 'header']

/** Where a view goes: a place, several, or none (`false`, `null`: offered, not placed). */
export type Placement = Place | Place[] | false | null

/** The app setting `app.layout`: only what differs from the views' own defaults, by view id. Unknown ids are ignored. */
export type Layout = {
  /** Where each view goes; `null` hides it. */
  place?: Record<string, Place | Place[] | null>
  /** Order within a place: the ids listed come first, in that order; the rest after, as the views' `order` says. */
  order?: Partial<Record<Place, string[]>>
  /** On a phone or narrow window, changes on top: unset, what's above applies. */
  narrow?: Omit<Layout, 'narrow'>
}

export const LAYOUT = 'app.layout'

/** What resolving needs of a view: its id, where it fits, and its defaults. */
export type Placeable = {
  id: string
  fits: Place[]
  /** Where it goes unless the layout says otherwise. */
  default?: Placement
  /** On a phone or narrow window, where it goes by default instead. Unset: as wide. */
  narrow?: Placement
  /** Where it goes by default while no view is in `space` (a window with no sidebar). */
  withoutSpaces?: Placement
  /** Order within a place, where nothing says otherwise (100 when unset; then as registered). */
  order?: number
}

/** Every place's views, in order. */
export type Placed = Record<Place, string[]>

const list = (placement: Placement | undefined): Place[] => !placement ? [] : Array.isArray(placement) ? placement : [placement]

/**
 * Where `view` goes, and whether the user said so. What the user says beats what the view says, and on a phone the
 * phone's beats the wide:
 * 1. on a phone, the user's narrow layer (when `layers`);
 * 2. the user's wide layout: hidden is hidden everywhere; places are kept on a phone if it draws any of them;
 * 3. on a phone, the view's own `narrow`;
 * 4. the view's `default`.
 */
function placesOf(view: Placeable, layout: Layout | undefined, narrow: boolean, layers = true): { places: Place[]; chosen: boolean } {
  const user = layout?.place ?? {}
  const small = narrow && layers ? layout?.narrow?.place ?? {} : {}
  if (view.id in small) return { places: list(small[view.id]), chosen: true }
  if (view.id in user) {
    const places = list(user[view.id])
    // Put where a phone has no room (the rail), it goes where the view goes on a phone instead.
    if (!narrow || !places.length || view.narrow === undefined || places.some((p) => NARROW_PLACES.includes(p))) return { places, chosen: true }
  }
  if (narrow && view.narrow !== undefined) return { places: list(view.narrow), chosen: false }
  return { places: list(view.default), chosen: false }
}

/** `views` with one of each id: the first declared (an id declared in several scopes, a profile on two machines, is one view to place). */
const once = <V extends Placeable>(views: readonly V[]): V[] => {
  const seen = new Set<string>()
  return views.filter((view) => !seen.has(view.id) && Boolean(seen.add(view.id)))
}

/**
 * Where each view goes, place by place, in order: the views' defaults, then the user's layout; narrow: its own on top.
 * An id is placed once, however many declare it: as the first declared says.
 */
export function resolveLayout(views: readonly Placeable[], layout: Layout | undefined, { narrow = false }: { narrow?: boolean } = {}): Placed {
  const resolved = once(views).map((view) => {
    const { places, chosen } = placesOf(view, layout, narrow)
    return { view, chosen, places: [...new Set(places)].filter((place) => view.fits.includes(place)) }
  })
  // With no space placed, the views that stand in for one go where they say (unless the user placed them).
  if (!resolved.some((r) => r.places.includes('space'))) {
    for (const r of resolved) if (!r.chosen && r.view.withoutSpaces) r.places = [...new Set([...r.places, ...list(r.view.withoutSpaces).filter((p) => r.view.fits.includes(p))])]
  }
  const order = { ...layout?.order, ...(narrow ? layout?.narrow?.order : {}) }
  const placed = Object.fromEntries(PLACES.map((place) => [place, [] as string[]])) as Placed
  for (const place of PLACES) {
    const listed = order[place] ?? []
    const rank = (id: string) => { const at = listed.indexOf(id); return at < 0 ? listed.length : at }
    placed[place] = resolved.map((r, index) => ({ ...r, index })).filter((r) => r.places.includes(place))
      .sort((a, b) => rank(a.view.id) - rank(b.view.id) || (a.view.order ?? 100) - (b.view.order ?? 100) || a.index - b.index)
      .map((r) => r.view.id)
  }
  return placed
}

/** The places `view` is in now. */
export const placesNow = (views: readonly Placeable[], layout: Layout | undefined, view: string, { narrow = false }: { narrow?: boolean } = {}): Place[] =>
  Object.entries(resolveLayout(views, layout, { narrow })).filter(([, ids]) => ids.includes(view)).map(([p]) => p as Place)

type Layer = Omit<Layout, 'narrow'>

/** `layout` with `layer` as its wide (or narrow) layer, empty parts left out. */
function withLayer(layout: Layout | undefined, layer: Layer, narrow: boolean): Layout {
  const place = layer.place && Object.keys(layer.place).length ? layer.place : undefined
  const order = layer.order ? Object.fromEntries(Object.entries(layer.order).filter(([, ids]) => ids?.length)) : undefined
  const tidy: Layer = { ...(place ? { place } : {}), ...(order && Object.keys(order).length ? { order } : {}) }
  const { narrow: small, ...wide } = layout ?? {}
  if (!narrow) return { ...tidy, ...(small ? { narrow: small } : {}) }
  return { ...wide, ...(Object.keys(tidy).length ? { narrow: tidy } : {}) }
}

/**
 * The layout with `view` put in `place` (`on`) or taken out of it (unset: toggled); with `from`, taken out of that place
 * in the same change (moved). `narrow` changes the phone's layer, on top of the wide one; else the wide one (the narrow
 * one's own changes stay). Only what differs from where the view would go anyway is kept. As `layout.place` does.
 */
export function placeView(views: readonly Placeable[], layout: Layout | undefined, view: string, place: Place,
  { on, from, narrow = false }: { on?: boolean; from?: Place; narrow?: boolean } = {}): Layout {
  const found = once(views).find((v) => v.id === view)
  if (!found) return layout ?? {}
  if (from && from !== place) return placeView(views, placeView(views, layout, view, place, { on: true, narrow }), view, from, { on: false, narrow })
  const now = placesNow(views, layout, view, { narrow })
  const want = on ?? !now.includes(place)
  const next = want ? [...new Set([...now, place])] : now.filter((p) => p !== place)
  const layer: Layer = (narrow ? layout?.narrow : layout) ?? {}
  const { [view]: _old, ...others } = layer.place ?? {}
  // Where it goes with this layer saying nothing of it: the default wide, the wide layout's on a phone.
  const base = (narrow ? placesOf(found, layout, true, false).places : list(found.default)).filter((p) => found.fits.includes(p))
  const same = next.length === base.length && next.every((p) => base.includes(p))
  // Back where it goes anyway, nothing is kept; but a view standing in for a space is kept where it's put, space or not.
  const kept = same && !found.withoutSpaces ? others : { ...others, [view]: next.length === 0 ? null : next.length === 1 ? next[0]! : next }
  return withLayer(layout, { ...layer, place: kept }, narrow)
}

/** Whether `value` is shaped as a layout (ids and places aren't checked: unknown ones are ignored). */
export function isLayout(value: Json | undefined, nested = false): value is Layout & Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { place, order, narrow, ...rest } = value as Record<string, Json>
  if (Object.keys(rest).length) return false
  const strings = (v: Json) => typeof v === 'string' || Array.isArray(v) && v.every((s) => typeof s === 'string')
  if (place !== undefined && (!place || typeof place !== 'object' || Array.isArray(place) || !Object.values(place).every((p) => p === null || strings(p)))) return false
  if (order !== undefined && (!order || typeof order !== 'object' || Array.isArray(order) || !Object.values(order).every((ids) => Array.isArray(ids) && strings(ids)))) return false
  if (narrow !== undefined && (nested || !isLayout(narrow, true))) return false
  return true
}
