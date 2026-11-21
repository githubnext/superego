// The model menu: a button showing the model, and a list to pick another from, with a search field. The user's favourite
// models first (those that can't be used here greyed, with why), then every other model of the signed-in providers,
// by provider; where asked for (`agents`), other kinds of agent's (Claude Agent's) between the two, a group each, which
// start a thread on that kind. A star on each row (shown on the row pointed at or highlighted, and on the favourites) stars or unstars
// it; so does ⌘D (Ctrl+D) on the highlighted row.
import { useMemo, useRef, useState } from 'react'
import type { ModelCatalog } from '@superego/protocol'
import { BaseUI, popupFocus, StarIcon, usePortalAttributes } from '@superego/ui'
import { keyLabel } from '../shared/shortcuts.ts'

const { Combobox } = BaseUI

/** The key that stars or unstars the highlighted model. */
export const STAR_KEYS = 'mod+d'

/** `catalog` with `next` as its favourites, as the daemon will have them once it's told: to show at once. */
export function withFavourites(catalog: ModelCatalog, next: string[]): ModelCatalog {
  const known = new Map([...catalog.models, ...catalog.favourites ?? []].map((m) => [m.value, m]))
  return { ...catalog, favourites: next.flatMap((value) => { const m = known.get(value); return m ? [{ value, label: m.label, group: m.group, ...('unavailable' in m && m.unavailable ? { unavailable: m.unavailable } : {}) }] : [] }) }
}

type Row = { value: string | null; label: string; group: string; unavailable?: string; starred: boolean; kind?: string }
type Group = { group: string; items: Row[]; about?: string }

/**
 * Pick a model from `catalog`: `value` is `provider/model`, or null for `nullLabel` (the default), listed first when
 * given. `onStar` stars or unstars a model (the new favourites, in order); without it, there are no stars. `agents`:
 * other kinds of agent's models too (`ModelCatalog.agents`, never starred), each kind's group said to run `where`
 * ("on this Mac"): all of them (`all`), or one kind's alone, without the providers' (a profile of that kind's picked).
 */
export function ModelPicker({ catalog, value, onChange, onStar, nullLabel, label, disabled, placeholder, agents, where }: {
  catalog: ModelCatalog | undefined
  value: string | null
  onChange(value: string | null): void
  onStar?(favourites: string[]): void
  nullLabel?: string
  label: string
  disabled?: boolean
  /** What the button says with no model to show (none chosen and no `nullLabel`, or no catalog yet): "Loading…". */
  placeholder?: string
  agents?: 'all' | { only: string }
  where?: string
}) {
  const marked = usePortalAttributes()
  const popup = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const highlighted = useRef<Row | undefined>(undefined)
  const favourites = catalog?.favourites ?? []

  const groups = useMemo<Group[]>(() => {
    if (!catalog) return []
    const starred = new Set(favourites.map((f) => f.value))
    const out: Group[] = []
    if (nullLabel !== undefined) out.push({ group: '', items: [{ value: null, label: nullLabel, group: '', starred: false }] })
    const only = agents && agents !== 'all' ? agents.only : undefined
    if (!only && favourites.length) out.push({ group: 'Favourites', items: favourites.map((f) => ({ ...f, starred: true })) })
    // Other kinds of agent next: few, and a choice of their own.
    for (const menu of agents ? catalog.agents ?? [] : []) {
      if (only && menu.kind !== only) continue
      out.push({
        group: menu.title, about: [menu.description && where ? `${menu.description} ${where}` : menu.description, menu.unavailable].filter(Boolean).join(' · '),
        items: menu.models.map((m) => ({ value: m.value, label: m.label, group: menu.title, starred: false, kind: menu.kind, ...(menu.unavailable ? { unavailable: menu.unavailable } : {}) })),
      })
    }
    if (!only) {
      const byProvider = new Map<string, Row[]>()
      for (const model of catalog.models) {
        if (starred.has(model.value)) continue
        byProvider.set(model.group, [...byProvider.get(model.group) ?? [], { value: model.value, label: model.label, group: model.group, starred: false }])
      }
      for (const [group, items] of byProvider) out.push({ group, items })
    }
    return out
  }, [catalog, nullLabel, agents && agents !== 'all' ? agents.only : agents, where])

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return groups
    const matches = (row: Row) => row.value !== null && words.every((word) => `${row.label} ${row.value} ${row.group}`.toLowerCase().includes(word))
    return groups.map((g) => ({ ...g, items: g.items.filter(matches) })).filter((g) => g.items.length)
  }, [groups, query])

  const star = (row: Row) => {
    if (!onStar || row.value === null) return
    const values = favourites.map((f) => f.value)
    onStar(row.starred ? values.filter((v) => v !== row.value) : [...values, row.value])
  }

  const current = groups.flatMap((g) => g.items).find((row) => row.value === value)
  // Another kind's model says whose it is: "Claude Agent · Opus".
  const currentLabel = current && (current.kind ? `${current.group} · ${current.label}` : current.label)
  const shownLabel = (catalog && (currentLabel ?? value ?? nullLabel)) ?? placeholder ?? ''
  return (
    <Combobox.Root<Row> items={groups} filteredItems={shown} autoHighlight
      value={current ?? null} onValueChange={(row) => { if (row && !row.unavailable) onChange(row.value) }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      itemToStringLabel={(row) => row.label} itemToStringValue={(row) => row.value ?? ''}
      inputValue={query} onInputValueChange={setQuery} onOpenChange={(open) => { if (!open) setQuery('') }}
      onItemHighlighted={(row) => { highlighted.current = row }} disabled={disabled || !catalog}>
      <Combobox.Trigger className="superego-field superego-select model-picker__button" aria-label={label}>{shownLabel}</Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner {...marked} className="superego-layer" side="bottom" align="start" sideOffset={6}>
          <Combobox.Popup ref={popup} className="superego-popover model-picker__popover" initialFocus={popupFocus(popup)}>
            <Combobox.Input className="superego-field" placeholder="Search models" aria-label={`Search ${label}`}
              onKeyDown={(e) => {
                if (!onStar || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'd' || !highlighted.current) return
                e.preventDefault()
                star(highlighted.current)
              }} />
            <Combobox.Empty className="model-picker__note">No models match</Combobox.Empty>
            <Combobox.List className="model-picker__list">
              {(group: Group) => (
                <Combobox.Group key={group.group} items={group.items} className="model-picker__group">
                  {group.group && (
                    <Combobox.GroupLabel className="model-picker__heading">
                      {group.group}{group.about && <span className="model-picker__about">{group.about}</span>}
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(row: Row) => (
                      <Combobox.Item key={row.value ?? ''} value={row} disabled={Boolean(row.unavailable)}
                        className={`model-picker__item ${row.unavailable ? 'is-unavailable' : ''}`} title={row.unavailable}>
                        <span className="model-picker__label">
                          {row.label}
                          {row.unavailable && !row.kind ? <span className="model-picker__why">{row.unavailable}</span>
                            : row.starred && row.group && <span className="model-picker__why">{row.group}</span>}
                        </span>
                        {onStar && row.value !== null && !row.kind && (
                          <button type="button" tabIndex={-1} className={`model-picker__star ${row.starred ? 'is-on' : ''}`}
                            aria-label={row.starred ? `Unstar ${row.label}` : `Star ${row.label}`} title={`${row.starred ? 'Unstar' : 'Star'} (${keyLabel(STAR_KEYS)})`}
                            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); star(row) }}>
                            <StarIcon weight={row.starred ? 'fill' : 'regular'} />
                          </button>
                        )}
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
