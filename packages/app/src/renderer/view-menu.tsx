// A view's menu where it's shown: move it to another place it fits, take it out of this one, or edit the layout's text.
// A right-click (or a long press) on a view in the rail, the title bar, the drawer, the thread's header or the menu
// that opens panes; the ··· of a view beside the thread. A pane's tab has a menu of its own (panes.tsx), with Move to
// from here. All of it through `layout.place`, as the user's layout keeps it.
import type { ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { ContextMenu, DotsThreeIcon, IconButton, Menu } from '@superego/ui'
import { placeScope, placingIn, scopedViews, usePlaced, useRegistry } from './extension.tsx'
import { NARROW_PLACES, WIDE_PLACES, type Place } from './layout.ts'

/** What each place is called, wherever the user moves views. */
export const PLACE_TITLES: Record<Place, string> = {
  space: 'Spaces', rail: 'Rail buttons', drawer: 'Drawer buttons', titlebar: 'Title bar', beside: 'Beside the thread', pane: 'Pane menu', header: 'Thread header',
}
/** Where a view goes, to say so: "Show Files beside the thread". */
export const PLACE_PHRASES: Record<Place, string> = {
  space: 'as a space', rail: 'in the rail', drawer: 'in the drawer', titlebar: 'in the title bar', beside: 'beside the thread', pane: 'in the pane menu', header: 'in the thread header',
}

export type ViewMenuProps = {
  view: string
  /** Where it's shown, which "Remove from here" takes it out of. */
  place: Place
  /** The thread it's shown with: moved into the pane menu, it opens there as a pane. */
  machine?: string
  thread?: ThreadInfo
  /** The pane it's open in: moved or removed from there, the pane closes. */
  pane?: string
}

/** Where a view shown in `place` can go instead, and taking it there; none when it isn't declared there. */
function usePlacing({ view, place, machine, thread, pane }: ViewMenuProps) {
  const registry = useRegistry()
  const { placed, narrow, where } = usePlaced(machine && thread ? { machine, thread } : undefined)
  // As it's declared where it's shown: a thread's place, for that thread; the window's, for the window.
  const found = scopedViews(registry, placeScope(place, where)).find((v) => v.id === view)
  if (!found) return undefined
  // The layout keeps a view by id: declared in more than one scope (a profile's on two machines), it moves in each.
  const shared = registry.views.filter((v) => v.id === view).length > 1
  const dispatch = registry.router.dispatch
  const targets = found.fits.filter((p) => (narrow ? NARROW_PLACES : WIDE_PLACES).includes(p) && !placed[p].includes(view))
  const change = async (params: { place: Place; on?: boolean; from?: Place }) => {
    await dispatch('layout.place', { view, ...params, ...(narrow ? { narrow } : {}), ...placingIn(where) }, { source: 'layout' })
    if (!machine || !thread) return
    // Moved out of a pane it's open in: that pane goes. Moved into the pane menu: it opens, so the move shows.
    if (pane && params.on !== true) await dispatch('pane.close', { thread: thread.id, pane }, { machine, source: 'layout' })
    if (params.place === 'pane' && params.on !== false && found.context === 'thread') await dispatch('pane.open', { thread: thread.id, kind: view }, { machine, source: 'layout' })
  }
  return { found, shared, targets, change }
}

const fail = (error: unknown) => console.error(error)

/** Move to → each place in `targets`. */
function MoveTo({ placing: { targets, change }, from }: { placing: NonNullable<ReturnType<typeof usePlacing>>; from: Place }) {
  if (!targets.length) return null
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger>Move to</Menu.SubmenuTrigger>
      <Menu.SubmenuPopup className="view-menu__places">
        {targets.map((to) => <Menu.Item key={to} data-place={to} onClick={() => void change({ place: to, from }).catch(fail)}>{PLACE_TITLES[to]}</Menu.Item>)}
      </Menu.SubmenuPopup>
    </Menu.SubmenuRoot>
  )
}

/**
 * The menu's items: Move to → the other places it fits, Remove from here (the pane menu, from an entry in it), Edit
 * layout…. Not on a pane's tab: its menu is the pane's (see PaneMoveTo).
 */
export function ViewMenuItems(props: ViewMenuProps) {
  const placing = usePlacing(props)
  const dispatch = useRegistry().router.dispatch
  if (!placing) return null
  return (
    <>
      {placing.shared && <Menu.Group><Menu.GroupLabel data-shared>For every thread with {placing.found.title}</Menu.GroupLabel></Menu.Group>}
      <MoveTo placing={placing} from={props.place} />
      <Menu.Item data-remove onClick={() => void placing.change({ place: props.place, on: false }).catch(fail)}>{props.place === 'pane' ? 'Remove from pane menu' : 'Remove from here'}</Menu.Item>
      <Menu.Separator />
      <Menu.Item onClick={() => void dispatch('layout.edit', {}, { source: 'layout' }).catch(fail)}>Edit layout…</Menu.Item>
    </>
  )
}

/**
 * On a view's pane's tab: its menu (`menu`), with Move to → the other places the view fits in it. Only when there are
 * any: otherwise the menu would only repeat the tab's own buttons.
 */
export function PaneMoveTo({ menu, ...props }: Omit<ViewMenuProps, 'place'> & { menu(moveTo: ReactNode): ReactNode }) {
  const placing = usePlacing({ ...props, place: 'pane' })
  if (!placing?.targets.length) return null
  return menu(
    <>
      {placing.shared && <Menu.Group><Menu.GroupLabel data-shared>For every thread with {placing.found.title}</Menu.GroupLabel></Menu.Group>}
      <MoveTo placing={placing} from="pane" />
    </>,
  )
}

/** A view with its menu on a right-click or a long press. */
export function ViewContextMenu({ children, ...props }: ViewMenuProps & { children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger data-view={props.view}>{children}</ContextMenu.Trigger>
      <ContextMenu.Popup className="view-menu"><ViewMenuItems {...props} /></ContextMenu.Popup>
    </ContextMenu.Root>
  )
}

/** A view's ··· button, with its menu. */
export function ViewMenuButton({ title, ...props }: ViewMenuProps & { title: string }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label={`${title}: move or remove`} className="view-menu__button" />}>
        <DotsThreeIcon size={16} weight="bold" aria-hidden />
      </Menu.Trigger>
      <Menu.Popup align="end" className="view-menu"><ViewMenuItems {...props} /></Menu.Popup>
    </Menu.Root>
  )
}

/** A `PlacedViews` frame: each view with its menu on a right-click, there. */
export const withContextMenu = (place: Place, where: { machine?: string; thread?: ThreadInfo } = {}) =>
  (view: { id: string }, drawn: ReactNode) => <ViewContextMenu view={view.id} place={place} {...where}>{drawn}</ViewContextMenu>

/** A `PlacedViews` frame beside the thread: each view in a box of its own, with its ··· at the top. */
export const withMenuButton = (place: Place, where: { machine?: string; thread?: ThreadInfo } = {}) =>
  (view: { id: string; title: string }, drawn: ReactNode) => (
    <div className="placed-view" data-view={view.id}>
      <ViewMenuButton view={view.id} title={view.title} place={place} {...where} />
      {drawn}
    </div>
  )
