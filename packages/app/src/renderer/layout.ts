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
 * - `aside`: a column beside the thread
 * - `pane`: in the thread's pane menu, opened as a pane beside it
 * - `header`: right of the thread's title: a button, a badge
 */
export type Place = 'space' | 'rail' | 'drawer' | 'titlebar' | 'aside' | 'pane' | 'header'
export const PLACES: Place[] = ['space', 'rail', 'drawer', 'titlebar', 'aside', 'pane', 'header']
/** The places that show a thread: a view drawn there gets it. */
export const THREAD_PLACES: Place[] = ['aside', 'pane', 'header']

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

/** Where each view goes, place by place, in order: the views' defaults, then the user's layout; narrow: its own on top. */
export function resolveLayout(views: readonly Placeable[], layout: Layout | undefined, { narrow = false }: { narrow?: boolean } = {}): Placed {
  const user = layout?.place ?? {}
  const small = narrow ? layout?.narrow?.place ?? {} : {}
  /** Where a view goes, and whether the user said so (in the layer that applies). */
  const placesOf = (view: Placeable): { places: Place[]; chosen: boolean } => {
    if (view.id in small) return { places: list(small[view.id]), chosen: true }
    if (narrow && view.narrow !== undefined) return { places: list(view.narrow), chosen: false }
    if (view.id in user) return { places: list(user[view.id]), chosen: true }
    return { places: list(view.default), chosen: false }
  }
  const resolved = views.map((view) => {
    const { places, chosen } = placesOf(view)
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

/**
 * The layout with `view` put in `place` (`on`), or taken out of it; unset, toggled. Changes the wide layout (the narrow
 * one's own changes stay), and keeps only what differs from the view's default.
 */
export function placeIn(views: readonly Placeable[], layout: Layout | undefined, view: string, place: Place, on?: boolean): Layout {
  const found = views.find((v) => v.id === view)
  if (!found) return layout ?? {}
  const now = Object.entries(resolveLayout(views, layout)).filter(([, ids]) => ids.includes(view)).map(([p]) => p as Place)
  const want = on ?? !now.includes(place)
  const next = want ? [...new Set([...now, place])] : now.filter((p) => p !== place)
  const { [view]: _old, ...others } = layout?.place ?? {}
  const same = (a: Place[], b: Place[]) => a.length === b.length && a.every((p) => b.includes(p))
  // Back to its default, nothing is kept; but a view standing in for a space is kept where it's put, space or not.
  const kept = same(next, list(found.default)) && !found.withoutSpaces ? others
    : { ...others, [view]: next.length === 0 ? null : next.length === 1 ? next[0]! : next }
  const { place: _place, ...rest } = layout ?? {}
  return { ...rest, ...(Object.keys(kept).length ? { place: kept } : {}) }
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
