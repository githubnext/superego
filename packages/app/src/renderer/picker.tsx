// A picker: a dialog with a box to type in and a list under it that narrows as you type, for going to or running one
// thing (the palette, quick open, links). ↑↓ (or ⌃P/⌃N) move, ⏎ picks, ⌘⏎ picks it beside, esc closes. With `digits`,
// ⌃1–⌃9 pick the first nine (⌃⌘ beside), each showing its key. Browsing (nothing typed), items in a group of their own
// run under its name; searching, they're one list, best first. On Base UI's Autocomplete: the box is a combobox and
// the lit row its active descendant, so a screen reader follows along.
import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { autoFocusOnOpen, BaseUI, Dialog } from '@superego/ui'
import { keyLabel } from './keys.ts'

/** An item as a line of the list: a glyph before it, its title, more after it, and its key. */
export type PickerRow = { key: string; title: ReactNode; glyph?: ReactNode; detail?: ReactNode; keys?: string; className?: string }

/** A run of a `Picker`'s list, its group's name over it when given. */
export type PickerRun<T> = { group?: string; items: T[] }

/** A `Picker`'s items, how each looks, and what picking one does. */
export type PickerProps<T> = {
  /** Names the dialog, for those who can't see it. */
  label: string
  placeholder: string
  /** On the dialog, beside `palette`: a class of its own to style it by. */
  className?: string
  items: readonly T[]
  /** The items that match what's typed, best first. Default: all of them. */
  filter?: (items: readonly T[], query: string) => readonly T[]
  row(item: T, options: { grouped: boolean }): PickerRow
  /** Browsing (nothing typed): an item's group, named over the run of items in it. Items of a group come together. */
  group?(item: T): string | undefined
  /** An item picked: by ⏎ or a click, `beside` with ⌘. The picker doesn't close itself. */
  onPick(item: T, options: { beside: boolean }): void
  onClose(): void
  /** ⌃1–⌃9 pick the first nine. */
  digits?: boolean
  /** Said when nothing's listed. Default: "Nothing matches". */
  empty?: ReactNode
  /** Under the list: the keys it takes, say. */
  footer?: ReactNode
}

/** A key pressed in the box, as far as the picker cares. */
export type PickerKey = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>

/**
 * What a key does beyond the Autocomplete's own (↑↓ move, ⏎ picks the lit row): ⌃N/⌃P move as ↓/↑ do (`as`), ⌘⏎
 * picks the lit row beside (`lit`), and with `digits` ⌃1–⌃9 (⌃⌘ beside) pick by place, going by the key's place as ⌃
 * may change what it types.
 */
export function pickerKey(event: PickerKey, { digits = false }: { digits?: boolean } = {}):
  { as: 'ArrowDown' | 'ArrowUp' } | { lit: true; beside: true } | { pick: number; beside: boolean } | undefined {
  if (digits && event.ctrlKey && !event.altKey && /^Digit[1-9]$/.test(event.code)) return { pick: Number(event.code.slice(5)) - 1, beside: event.metaKey }
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'n') return { as: 'ArrowDown' }
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'p') return { as: 'ArrowUp' }
  if (event.metaKey && event.key === 'Enter') return { lit: true, beside: true }
  return undefined
}

/** A dialog to pick an item from a list, filtered as you type: the palette's, for an extension's own (a quick open). */
export function Picker<T>({ label, placeholder, className = '', items, filter, row, group, onPick, onClose, digits, empty = 'Nothing matches', footer }: PickerProps<T>) {
  const [query, setQuery] = useState('')
  const grouped = Boolean(group) && !query.trim()
  const runs = useMemo(() => pickerRuns(filter ? filter(items, query) : items, grouped ? group : undefined), [items, query, filter, grouped, group])
  // As listed, run after run: what the keys go through.
  const shown = useMemo(() => runs.flatMap((run) => run.items), [runs])
  // The row lit, as the Autocomplete has it (it keeps the index itself): for ⌘⏎, which it leaves to us.
  const lit = useRef<T | undefined>(undefined)
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const does = pickerKey(event, { digits })
    if (!does) return
    event.preventDefault()
    // ⌃N/⌃P are ↓/↑ by another name: pressed as those, the Autocomplete moves (and stops at the ends) as it does for them.
    if ('as' in does) event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key: does.as, bubbles: true, cancelable: true }))
    else if ('lit' in does) { if (lit.current !== undefined) onPick(lit.current, { beside: true }) }
    else if (shown[does.pick] !== undefined) onPick(shown[does.pick]!, { beside: does.beside })
  }
  return (
    <Dialog onClose={onClose} size="medium" flush className={`palette ${className}`} label={label}>
      <BaseUI.Autocomplete.Root inline open items={items} filteredItems={shown} autoHighlight="always" keepHighlight loopFocus={false}
        value={query} onValueChange={(value, details) => { if (details.reason !== 'item-press') setQuery(value) }}
        onItemHighlighted={(item) => { lit.current = item }}>
        <BaseUI.Autocomplete.Input className="superego-dialog__search palette__input" autoFocus={autoFocusOnOpen()} placeholder={placeholder} onKeyDown={onKeyDown} />
        <BaseUI.Autocomplete.List className="palette__list" render={<ul />}>
          {runs.map((run, at) => (
            <Fragment key={run.group ?? `run-${at}`}>
              {run.group && <li className="palette__group" role="presentation">{run.group}</li>}
              {run.items.map((item, within) => {
                const index = runs.slice(0, at).reduce((n, before) => n + before.items.length, 0) + within
                const line = row(item, { grouped })
                const keys = line.keys ?? (digits && index < 9 ? `ctrl+${index + 1}` : undefined)
                return (
                  <BaseUI.Autocomplete.Item key={line.key} value={item} index={index} render={<li />}
                    className={(state) => `${line.className ?? ''} ${state.highlighted ? 'is-active' : ''}`.trim()}
                    onClick={(event) => onPick(item, { beside: event.metaKey })}>
                    {line.glyph !== undefined && <span className="palette__glyph">{line.glyph}</span>}
                    <span className="palette__title">{line.title}</span>
                    {line.detail !== undefined && line.detail !== null && line.detail !== '' && line.detail !== false && <span className="palette__detail">{line.detail}</span>}
                    {keys && <kbd>{keyLabel(keys)}</kbd>}
                  </BaseUI.Autocomplete.Item>
                )
              })}
            </Fragment>
          ))}
        </BaseUI.Autocomplete.List>
        <BaseUI.Autocomplete.Empty className="palette__none">{empty}</BaseUI.Autocomplete.Empty>
      </BaseUI.Autocomplete.Root>
      {footer}
    </Dialog>
  )
}

/**
 * `items` as the picker lists them: by `group`, each group's items run together (where its first is), named over them;
 * without one, a single run.
 */
export function pickerRuns<T>(items: readonly T[], group?: (item: T) => string | undefined): PickerRun<T>[] {
  if (!group) return [{ items: [...items] }]
  const runs = new Map<string | undefined, T[]>()
  for (const item of items) {
    const name = group(item)
    runs.set(name, [...runs.get(name) ?? [], item])
  }
  return [...runs].map(([name, list]) => ({ ...(name !== undefined ? { group: name } : {}), items: list }))
}
