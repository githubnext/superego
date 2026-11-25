// Where views are drawn: the layout resolved for the window or a thread (the views' defaults and the user's layout,
// narrow on a phone), the views in a place drawn, a view moved in or out of one, and the slots behaviour fills.
import { createContext, Fragment, useContext, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { Json, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import { useSelection } from './state.tsx'
import { useSettings } from './client.ts'
import { useNarrow } from './media.ts'
import { APP, LAYOUT } from '../shared/app-settings.ts'
import { isLayout, PLACES, resolveLayout, THREAD_PLACES, type Layout, type Place, type Placed } from '../shared/layout.ts'
import { Inspected, viewInfo } from './inspect.tsx'
import { Contained } from './contained.tsx'
import type { BehaviourSlot, SlotProps, View, ViewProps } from './extension-api.ts'
import { paneKind } from './lookups.ts'
import { scopeOf, seenIn, useRegistry, type Owned, type Registry, type Where } from './registry.tsx'

/** Draw every component in `slot`, with `props`; each in its `frame`, if given, by a key of its own. */
export function Slot<S extends BehaviourSlot>({ name, props, frame }: { name: S; props: SlotProps[S]; frame?: (key: string, drawn: ReactNode) => ReactNode }) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const { machine, thread } = props as { machine?: MachineEntry; thread?: ThreadInfo }
  const entries = seenIn(registry.slots[name] as Owned<{ component: ComponentType<SlotProps[S]> }>[], machine && thread ? { machine: machine.id, thread } : undefined)
  return <>{entries.map(({ component: Component, owner }, index) => {
    const key = `${owner.profile ?? ''}/${owner.extension}-${index}`
    const drawn = <Contained key={key} name={owner.extension} scope={owner.profile} inline={name === 'header.chips' || name === 'thread.badge' || name === 'editor.bar'}><Component {...props} /></Contained>
    return <Inspected key={key} info={() => ({ kind: 'slot', id: name, title: name, owner })}>{frame ? <Fragment key={key}>{frame(key, drawn)}</Fragment> : drawn}</Inspected>
  })}</>
}

/** The user's layout (`app.layout`), as stored; anything not shaped as one is none. */
export const layoutOf = (value: Json | undefined): Layout | undefined => isLayout(value) ? value : undefined

/**
 * The views `where` sees (a thread's places), one of each id, as its own scope declares it: its profile's (that profile
 * on that machine) over the app's, a data view only from its machine, none of an optional extension its thread goes
 * without. Without `where` (the window's places), the app's. An id is a view's name, one in the layout whatever the
 * scope; what it is, where it fits and goes by default are its declaration's here.
 */
export function scopedViews(registry: Registry, where?: Where): Registry['views'] {
  // A data view shows a thread only from that thread's machine: another's has nothing to say of it.
  const on = (view: Registry['views'][number]) => !where || !view.machines || view.machines.includes(where.machine)
  const byId = new Map<string, Registry['views'][number]>()
  for (const view of seenIn(registry.views, where)) {
    if (!on(view)) continue
    const had = byId.get(view.id)
    if (!had || (!had.owner.profile && view.owner.profile)) byId.set(view.id, view)
  }
  return [...byId.values()]
}

/** Where every view `where` sees goes, place by place (see `scopedViews`): resolved from those, so each is there once. */
export const placedFor = (registry: Registry, layout: Layout | undefined, { narrow = false, where }: { narrow?: boolean; where?: Where | undefined } = {}): Placed =>
  resolveLayout(scopedViews(registry, where), layout, { narrow })

/** Where every view goes now for `where` (the window's, without), place by place: the views' defaults and the user's layout, narrow on a phone. */
export function useLayout(where?: Where): { placed: Placed; narrow: boolean } {
  const registry = useRegistry()
  const version = useSyncExternalStore(registry.subscribe, () => registry.version)
  const stored = useSettings(APP, true)?.values[LAYOUT]
  const narrow = useNarrow()
  const key = JSON.stringify(stored ?? null)
  // What it's resolved for: the machine and profile (`scopeOf`), and the extensions the thread goes without.
  const scope = where ? `${scopeOf(where) ?? where.machine}\u0000${where.thread.without?.join() ?? ''}` : ''
  const placed = useMemo(() => placedFor(registry, layoutOf(stored), { narrow, where }), [version, key, narrow, scope])
  return { placed, narrow }
}

/** The views in `place` for `where` (see `scopedViews`), in the layout's order; `placed` resolved for the same `where`. */
export function viewsIn(registry: Registry, placed: Placed, place: Place, where?: Where) {
  const views = new Map(scopedViews(registry, where).map((view) => [view.id, view]))
  return placed[place].flatMap((id) => views.get(id) ?? [])
}

/** The thread a view is drawn for: `PlacedViews` and a view's pane say, so its hooks read and change its own scope. */
const ViewScope = createContext<Where | undefined>(undefined)
export const ViewScopeProvider = ViewScope.Provider

/** Draw the views in a place: a thread's (`machine`, `thread`), or the window's; each in its `frame`, if given (its menu). */
export function PlacedViews({ place, machine, thread, frame }: {
  place: Place; machine?: MachineEntry; thread?: ThreadInfo; frame?: (view: Registry['views'][number], drawn: ReactNode) => ReactNode
}) {
  const registry = useRegistry()
  const where = machine && thread ? { machine: machine.id, thread } : undefined
  const { placed } = useLayout(where)
  // A view that needs a thread isn't drawn without one.
  return <>{viewsIn(registry, placed, place, where).filter((view) => view.context === 'window' || where).map((view) => {
    const Component = view.component as ComponentType<ViewProps>
    const drawn = <ViewScope.Provider value={where}><Contained name={view.owner.extension} scope={view.owner.profile} inline={place === 'header' || place === 'titlebar' || place === 'rail'}><Component place={place} {...(machine && thread ? { machine, thread } : {})} /></Contained></ViewScope.Provider>
    return <Fragment key={`${view.owner.profile ?? ''}/${view.id}`}><Inspected info={() => viewInfo(view, place)}>{frame ? frame(view, drawn) : drawn}</Inspected></Fragment>
  })}</>
}

/**
 * The scope a view's placement is read and changed in: the scope its place is drawn in. A thread's places (`beside`,
 * `pane`, `header`) are that thread's (`where`); the window's places are the window's, whatever thread asks.
 */
export const placeScope = (place: Place, where: Where | undefined): Where | undefined => THREAD_PLACES.includes(place) ? where : undefined

/**
 * Where every view is now, each place as it's drawn: a thread's places for `where`, else for the thread the asking
 * view is drawn for, else the selected thread's (the window's column beside is its); the window's places for the window.
 * `where` is that thread, to change them in (`layout.place`'s `machine` and `thread`).
 */
export function usePlaced(where?: Where): { placed: Placed; narrow: boolean; where: Where | undefined } {
  const drawnFor = useContext(ViewScope)
  const { selection, machine, thread } = useSelection()
  const scope = where ?? drawnFor ?? (selection && machine && thread ? { machine: machine.id, thread } : undefined)
  const inThread = useLayout(scope)
  const inWindow = useLayout()
  const placed = useMemo(() => Object.fromEntries(PLACES.map((p) => [p, (THREAD_PLACES.includes(p) ? inThread : inWindow).placed[p]])) as Placed, [inThread.placed, inWindow.placed])
  return { placed, narrow: inWindow.narrow, where: scope }
}

/** `layout.place`'s params for the thread `where` (see `usePlaced`): its place is changed as it's drawn there. */
export const placingIn = (where: Where | undefined) => where ? { machine: where.machine, thread: where.thread.id } : {}

/**
 * Whether `view` is in `place` now, and a way to put it there or take it out (toggled, unless `on` is given): as the
 * place is drawn (see `usePlaced`: for `where`, the thread the view is drawn for, or the selected one). The layout
 * keeps it by id: put in a thread's place, it's there in every thread that has the view.
 */
export function usePlacement(view: string, place: Place, where?: Where): [boolean, (on?: boolean) => void] {
  const registry = useRegistry()
  const { placed, narrow, where: scope } = usePlaced(where)
  // The layer it's seen in: on a phone, the narrow one.
  const toggle = (on?: boolean) => void registry.router.dispatch('layout.place', {
    view, place, ...(on === undefined ? {} : { on }), ...(narrow ? { narrow } : {}), ...placingIn(scope),
  }, { source: 'layout' }).catch((error) => console.error(error))
  return [placed[place].includes(view), toggle]
}

/** The panes a thread's menu offers: the views the layout puts in `pane` that it has a kind of, in order; each with an icon, the view's or else its kind's. */
export function paneMenu(registry: Registry, placed: Placed, where: Where): { kind: string; title: string; icon?: View['icon'] }[] {
  return viewsIn(registry, placed, 'pane', where).flatMap(({ id, title, icon }) => {
    const kind = paneKind(registry, id, where)
    if (!kind) return []
    const shown = icon ?? kind.icon
    return [{ kind: id, title, ...(shown ? { icon: shown } : {}) }]
  })
}
