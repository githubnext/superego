// A view's menu where it's shown: move it to another place it fits, take it out of this one, or open Settings → Layout.
// A right-click (or a long press) on a view in the rail, the title bar, the drawer or the thread's header; the ··· of a
// view beside the thread or in a pane. All of it through `layout.place`, as the user's layout keeps it.
import type { ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { ContextMenu, DotsThreeIcon, IconButton, Menu } from '@superego/ui'
import { useLayout, useRegistry } from './extension.tsx'
import type { Place } from './layout.ts'

/** What each place is called, wherever the user moves views. */
export const PLACE_TITLES: Record<Place, string> = {
  space: 'Spaces', rail: 'Rail buttons', drawer: 'Drawer buttons', titlebar: 'Title bar', aside: 'Beside the thread', pane: 'Pane menu', header: 'Thread header',
}
/** The places a wide window shows, and a phone's: views move only among those there are. */
export const WIDE_PLACES: Place[] = ['space', 'rail', 'titlebar', 'aside', 'pane', 'header']
export const NARROW_PLACES: Place[] = ['space', 'drawer', 'pane', 'header']

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

/** The menu's items: Move to → the other places it fits, Remove from here, Customise layout…. */
export function ViewMenuItems({ view, place, machine, thread, pane }: ViewMenuProps) {
  const registry = useRegistry()
  const { placed, narrow } = useLayout()
  const found = registry.views.find((v) => v.id === view)
  if (!found) return null
  const dispatch = registry.router.dispatch
  const fail = (error: unknown) => console.error(error)
  const targets = found.fits.filter((p) => (narrow ? NARROW_PLACES : WIDE_PLACES).includes(p) && !placed[p].includes(view))
  const change = async (params: { place: Place; on?: boolean; from?: Place }) => {
    await dispatch('layout.place', { view, ...params, ...(narrow ? { narrow } : {}) }, { source: 'layout' })
    if (!machine || !thread) return
    // Moved out of a pane it's open in: that pane goes. Moved into the pane menu: it opens, so the move shows.
    if (pane && params.on !== true) await dispatch('pane.close', { id: thread.id, pane }, { machine, source: 'layout' })
    if (params.place === 'pane' && params.on !== false && found.context === 'thread') await dispatch('pane.open', { id: thread.id, kind: view }, { machine, source: 'layout' })
  }
  return (
    <>
      {targets.length > 0 && (
        <Menu.SubmenuRoot>
          <Menu.SubmenuTrigger>Move to</Menu.SubmenuTrigger>
          <Menu.SubmenuPopup className="view-menu__places">
            {targets.map((to) => <Menu.Item key={to} data-place={to} onClick={() => void change({ place: to, from: place }).catch(fail)}>{PLACE_TITLES[to]}</Menu.Item>)}
          </Menu.SubmenuPopup>
        </Menu.SubmenuRoot>
      )}
      <Menu.Item data-remove onClick={() => void change({ place, on: false }).catch(fail)}>Remove from here</Menu.Item>
      <Menu.Separator />
      <Menu.Item onClick={() => void dispatch('layout.customise', {}, { source: 'layout' }).catch(fail)}>Customise layout…</Menu.Item>
    </>
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
