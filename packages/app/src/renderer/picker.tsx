// A picker: a dialog with a box to type in and a list under it that narrows as you type, for going to or running one
// thing (the palette, quick open, links). ↑↓ (or ⌃P/⌃N) move, ⏎ picks, ⌘⏎ picks it beside, esc closes. With `digits`,
// ⌃1–⌃9 pick the first nine (⌃⌘ beside), each showing its key. On Base UI's Autocomplete: the box is a combobox and
// the lit row its active descendant, so a screen reader follows along.
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { autoFocusOnOpen, Dialog } from '@superego/ui'
import { keyLabel } from './keys.ts'

/** An item as a line of the list: a glyph before it, its title, more after it, and its key. */
export type PickerRow = { key: string; title: ReactNode; glyph?: ReactNode; detail?: ReactNode; keys?: string; className?: string }

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
  row(item: T): PickerRow
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
export function Picker<T>({ label, placeholder, className = '', items, filter, row, onPick, onClose, digits, empty = 'Nothing matches', footer }: PickerProps<T>) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filter ? filter(items, query) : items, [items, query, filter])
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
    <Dialog onClose={onClose} size="medium" className={`palette ${className}`} label={label}>
      <Autocomplete.Root inline open items={items} filteredItems={shown} autoHighlight="always" keepHighlight loopFocus={false}
        value={query} onValueChange={(value, details) => { if (details.reason !== 'item-press') setQuery(value) }}
        onItemHighlighted={(item) => { lit.current = item }}>
        <Autocomplete.Input className="palette__input" autoFocus={autoFocusOnOpen()} placeholder={placeholder} onKeyDown={onKeyDown} />
        <Autocomplete.List className="palette__list" render={<ul />}>
          {shown.map((item, index) => {
            const line = row(item)
            const keys = line.keys ?? (digits && index < 9 ? `ctrl+${index + 1}` : undefined)
            return (
              <Autocomplete.Item key={line.key} value={item} index={index} render={<li />}
                className={(state) => `${line.className ?? ''} ${state.highlighted ? 'is-active' : ''}`.trim()}
                onClick={(event) => onPick(item, { beside: event.metaKey })}>
                {line.glyph !== undefined && <span className="palette__glyph">{line.glyph}</span>}
                <span className="palette__title">{line.title}</span>
                {line.detail !== undefined && line.detail !== null && line.detail !== '' && line.detail !== false && <span className="palette__detail">{line.detail}</span>}
                {keys && <kbd>{keyLabel(keys)}</kbd>}
              </Autocomplete.Item>
            )
          })}
        </Autocomplete.List>
        <Autocomplete.Empty className="palette__none">{empty}</Autocomplete.Empty>
      </Autocomplete.Root>
      {footer}
    </Dialog>
  )
}
