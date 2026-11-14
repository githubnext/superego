// Settings → Layout: each place in the window with the views the layout puts there, in order. Reorder them (drag, the
// arrows, or ⌥↑ ⌥↓ on a row), remove them (× or ⌫), add what fits, reset a place or the lot. A phone has places of its
// own, edited as the layout's narrow layer. What differs from the views' defaults is all that is stored (`app.layout`).
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowDownIcon, ArrowUpIcon, Button, IconButton, Menu, PlusIcon, XIcon } from '@superego/ui'
import { useSettings } from './client.ts'
import { layoutOf, useRegistry, type View } from './extension.tsx'
import { LAYOUT, resolveLayout, type Layout, type Place } from './layout.ts'
import { addable, isChanged, moveView, moveViewTo, placeView, removeView, resetPlace } from './layout-edit.ts'
import { NARROW_PLACES, PLACE_TITLES, WIDE_PLACES } from './view-menu.tsx'

type Listed = View & { id: string; from: string }

/** The views to list: one of each id, the app's before a profile's. */
function useViews(): Listed[] {
  const registry = useRegistry()
  const titles = new Map(registry.extensions.map((e) => [e.name, e.title ?? e.name]))
  const seen = new Set<string>()
  return [...registry.views].sort((a, b) => Number(Boolean(a.owner.profile)) - Number(Boolean(b.owner.profile))).flatMap((view) => {
    if (seen.has(view.id)) return []
    seen.add(view.id)
    const from = view.owner.extension === 'core' ? registry.app.name : titles.get(view.owner.extension) ?? view.owner.extension
    return [{ ...view, from: view.owner.profile ? `${from} · a profile's` : from }]
  })
}

export function LayoutSettings() {
  const registry = useRegistry()
  const views = useViews()
  const layout = layoutOf(useSettings('app', true)?.values[LAYOUT]) ?? {}
  const [phone, setPhone] = useState(false)
  const [error, setError] = useState<string>()
  const apply = (next: Layout) => {
    setError(undefined)
    registry.router.dispatch('app.settings.set', { key: LAYOUT, value: next }, { machine: 'app', source: 'settings' }).catch((e: Error) => setError(e.message))
  }
  const placed = resolveLayout(views, layout, { narrow: phone })
  const changed = Object.keys(layout).length > 0
  return (
    <section className="settings-section layout-settings">
      <h2>Layout</h2>
      <div className="layout-settings__head">
        <div className="layout-settings__tabs" role="tablist" aria-label="Layout for">
          {([['Window', false], ['Phone', true]] as const).map(([label, on]) => (
            <button key={label} role="tab" aria-selected={phone === on} className={phone === on ? 'is-selected' : ''} onClick={() => setPhone(on)}>{label}</button>
          ))}
        </div>
        {changed && <Button onClick={() => apply({})}>Reset all</Button>}
      </div>
      <p className="settings__note">⌥↑ and ⌥↓ move the view you're on, ⌫ removes it. Right-click a view in the window to move it from there.</p>
      {error && <div className="setting__error">{error}</div>}
      {(phone ? NARROW_PLACES : WIDE_PLACES).map((place) => (
        <PlaceGroup key={place} place={place} narrow={phone} ids={placed[place]} views={views} layout={layout} apply={apply} />
      ))}
    </section>
  )
}

function PlaceGroup({ place, narrow, ids, views, layout, apply }: {
  place: Place; narrow: boolean; ids: string[]; views: Listed[]; layout: Layout; apply(next: Layout): void
}) {
  const list = useRef<HTMLDivElement>(null)
  // The row to keep the focus on once the change shows (moved, or the one after a removed one).
  const refocus = useRef<string | undefined>(undefined)
  const [dragging, setDragging] = useState<string>()
  const options = { narrow }
  const offered = addable(views, layout, place, options)
  useEffect(() => {
    if (refocus.current === undefined) return
    const rows = [...list.current?.querySelectorAll<HTMLElement>('.layout-row') ?? []]
    ;(rows.find((row) => row.dataset.view === refocus.current) ?? rows.at(-1) ?? list.current?.querySelector<HTMLElement>('.layout-place__add'))?.focus()
    refocus.current = undefined
  })
  const move = (id: string, by: number) => { refocus.current = id; apply(moveView(views, layout, id, place, by, options)) }
  const remove = (id: string) => {
    const at = ids.indexOf(id)
    refocus.current = ids[at + 1] ?? ids[at - 1] ?? ''
    apply(removeView(views, layout, id, place, options))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.target !== event.currentTarget) return
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (step && (event.altKey || event.metaKey)) { event.preventDefault(); move(id, step) }
    else if (step) {
      event.preventDefault()
      const rows = [...list.current?.querySelectorAll<HTMLElement>('.layout-row') ?? []]
      rows[rows.indexOf(event.currentTarget) + step]?.focus()
    } else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); remove(id) }
  }
  const drop = (event: DragEvent, index: number) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('application/x-superego-view')
    setDragging(undefined)
    if (ids.includes(id)) apply(moveViewTo(views, layout, id, place, index, options))
  }
  return (
    <div className="layout-place" data-place={place} ref={list}>
      <div className="layout-place__head">
        <h3>{PLACE_TITLES[place]}</h3>
        {isChanged(views, layout, place, options) && <Button className="layout-place__reset" onClick={() => apply(resetPlace(views, layout, place, options))}>Reset</Button>}
      </div>
      {ids.length === 0 && <div className="layout-place__empty">Nothing here</div>}
      {ids.map((id, index) => {
        const view = views.find((v) => v.id === id)
        if (!view) return null
        const Icon = view.icon
        return (
          <div key={id} className={`layout-row ${dragging === id ? 'is-dragging' : ''}`} data-view={id} tabIndex={0} draggable
            aria-label={`${view.title}, ${index + 1} of ${ids.length}`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Backspace"
            onKeyDown={(event) => onKeyDown(event, id)}
            onDragStart={(event) => { event.dataTransfer.setData('application/x-superego-view', id); event.dataTransfer.effectAllowed = 'move'; setDragging(id) }}
            onDragEnd={() => setDragging(undefined)}
            onDragOver={(event) => { if (dragging) event.preventDefault() }}
            onDrop={(event) => drop(event, index)}>
            <span className="layout-row__icon">{Icon && <Icon size={16} aria-hidden />}</span>
            <span className="layout-row__title">{view.title}</span>
            <span className="layout-row__from">{view.from}</span>
            <span className="layout-row__tools">
              <IconButton label="Move up" tabIndex={-1} disabled={index === 0} onClick={() => move(id, -1)}><ArrowUpIcon size={13} aria-hidden /></IconButton>
              <IconButton label="Move down" tabIndex={-1} disabled={index === ids.length - 1} onClick={() => move(id, 1)}><ArrowDownIcon size={13} aria-hidden /></IconButton>
              <IconButton label="Remove" tabIndex={-1} onClick={() => remove(id)}><XIcon size={13} aria-hidden /></IconButton>
            </span>
          </div>
        )
      })}
      {offered.length > 0 && (
        <Menu.Root>
          <Menu.Trigger render={<Button className="layout-place__add" />}><PlusIcon size={13} aria-hidden /> Add</Menu.Trigger>
          <Menu.Popup className="layout-place__offered">
            {offered.map((view) => (
              <Menu.Item key={view.id} data-view={view.id} hint={view.from} onClick={() => { refocus.current = view.id; apply(placeView(views, layout, view.id, place, { on: true, narrow })) }}>
                {view.title}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Root>
      )}
    </div>
  )
}
