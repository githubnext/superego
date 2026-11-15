// A picker: a dialog with a box to type in and a list under it that narrows as you type, for going to or running one
// thing (the palette, quick open, links). ↑↓ (or ⌃P/⌃N) move, ⏎ picks, ⌘⏎ picks it beside, esc closes. With `digits`,
// ⌃1–⌃9 pick the first nine (⌃⌘ beside), each showing its key.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Dialog } from '@superego/ui'
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
 * What a key does, with `active` the row lit of `count` listed: light another (`move`), pick one (`pick`, `beside`
 * with ⌘), or nothing of the picker's. ⌃1–⌃9 (⌃⌘ beside) go by the key's place, as ⌃ may change what it types.
 */
export function pickerKey(event: PickerKey, { active, count, digits = false }: { active: number; count: number; digits?: boolean }):
  { move: number } | { pick: number; beside: boolean } | undefined {
  if (digits && event.ctrlKey && !event.altKey && /^Digit[1-9]$/.test(event.code)) return { pick: Number(event.code.slice(5)) - 1, beside: event.metaKey }
  const last = Math.max(count - 1, 0)
  if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) return { move: Math.min(active + 1, last) }
  if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) return { move: Math.max(active - 1, 0) }
  if (event.key === 'Enter') return { pick: active, beside: event.metaKey }
  return undefined
}

/** A dialog to pick an item from a list, filtered as you type: the palette's, for an extension's own (a quick open). */
export function Picker<T>({ label, placeholder, className = '', items, filter, row, onPick, onClose, digits, empty = 'Nothing matches', footer }: PickerProps<T>) {
  const [query, setQuery] = useState('')
  const [lit, setActive] = useState(0)
  const shown = useMemo(() => filter ? filter(items, query) : items, [items, query, filter])
  // Within the list as it is now: it may have shrunk since (the palette's actions changing, say).
  const active = Math.min(lit, Math.max(shown.length - 1, 0))
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' }) }, [active])
  const pick = (item: T | undefined, beside: boolean) => { if (item !== undefined) onPick(item, { beside }) }
  const onKeyDown = (event: KeyboardEvent) => {
    const does = pickerKey(event, { active, count: shown.length, digits })
    if (!does) return
    event.preventDefault()
    if ('move' in does) setActive(does.move)
    else pick(shown[does.pick], does.beside)
  }
  return (
    <Dialog onClose={onClose} size="medium" className={`palette ${className}`} label={label}>
      <input className="palette__input" autoFocus placeholder={placeholder} value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown} />
      <ul className="palette__list" role="listbox" ref={list}>
        {shown.map((item, index) => {
          const line = row(item)
          const keys = line.keys ?? (digits && index < 9 ? `ctrl+${index + 1}` : undefined)
          return (
            <li key={line.key} role="option" aria-selected={index === active} className={`${line.className ?? ''} ${index === active ? 'is-active' : ''}`.trim()}
              onMouseMove={() => setActive(index)} onClick={(e) => pick(item, e.metaKey)}>
              {line.glyph !== undefined && <span className="palette__glyph">{line.glyph}</span>}
              <span className="palette__title">{line.title}</span>
              {line.detail !== undefined && line.detail !== null && line.detail !== '' && line.detail !== false && <span className="palette__detail">{line.detail}</span>}
              {keys && <kbd>{keyLabel(keys)}</kbd>}
            </li>
          )
        })}
        {shown.length === 0 && <li className="palette__none">{empty}</li>}
      </ul>
      {footer}
    </Dialog>
  )
}
