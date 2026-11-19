import { useCallback, useMemo, useRef, useState } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePortalAttributes } from './portal.tsx'
import { autoFocusOnOpen } from './touch.ts'

/** Whether `family` draws every glyph the same width: "iiii" and "WWWW" measure alike. */
export function isMonospace(family: string): boolean {
  const known = isMonospace.known.get(family)
  if (known !== undefined) return known
  const context = (isMonospace.canvas ??= document.createElement('canvas')).getContext('2d')!
  context.font = `16px "${family}", serif`
  const narrow = context.measureText('iiiiiiii').width
  const wide = context.measureText('WWWWWWWW').width
  const mono = Math.abs(narrow - wide) < 0.5
  isMonospace.known.set(family, mono)
  return mono
}
isMonospace.canvas = undefined as HTMLCanvasElement | undefined
isMonospace.known = new Map<string, boolean>()

/** The "no font set" item: a family can be called anything, so not a string. */
const DEFAULT = Symbol('default')
type Choice = string | typeof DEFAULT

/** A row's height before it's measured (every row is drawn the same height; see `.superego-font-picker__item`). */
const ROW = 26

/**
 * Pick a font family: a button that shows the current one in itself, and a searchable list (Base UI's Combobox, the
 * search in the popup) where every family is drawn in its own face. `fonts` is the list known already (kept from
 * before, say), shown at once; `loadFonts` runs on first open (font access needs the user's gesture), and draws the
 * list where `fonts` doesn't follow it. With `monospace`, only fixed-width families are listed unless "all fonts" is
 * ticked. A machine has hundreds of families, so only the rows in view are drawn.
 */
export function FontPicker({ value, onChange, fonts: known, loadFonts, monospace, nullLabel = 'Default', label }: {
  value: string | null
  onChange(value: string | null): void
  fonts?: string[]
  loadFonts(): Promise<string[]>
  monospace?: boolean
  nullLabel?: string
  label: string
}) {
  const marked = usePortalAttributes()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<string[]>()
  const fonts = known ?? loaded
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(!monospace)

  const mono = useMemo(() => fonts && monospace ? new Set(fonts.filter(isMonospace)) : undefined, [fonts, monospace])
  const items = useMemo<Choice[]>(() => [DEFAULT, ...(fonts ?? []).filter((family) => all || !mono || mono.has(family))], [fonts, all, mono])
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? items.filter((item) => item !== DEFAULT && item.toLowerCase().includes(needle)) : items
  }, [items, query])

  const scroller = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    enabled: open, count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12,
  })
  const scrollerRef = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element
    if (element) virtualizer.measure()
  }, [virtualizer])

  const toggle = (next: boolean) => {
    setOpen(next)
    if (!next) setQuery('')
    if (next && !loaded) loadFonts().then(setLoaded, (e: Error) => { console.error('Listing fonts failed', e); setError(e.message) })
  }

  const note = !fonts && error ? error : !fonts ? 'Loading fonts…' : undefined
  return (
    <Combobox.Root<Choice> virtualized autoHighlight items={items} filteredItems={shown}
      value={value ?? DEFAULT} onValueChange={(next) => onChange(next === DEFAULT || next === null ? null : next)}
      itemToStringLabel={(item) => item === DEFAULT ? nullLabel : item} itemToStringValue={(item) => item === DEFAULT ? '' : item}
      open={open} onOpenChange={toggle} inputValue={query} onInputValueChange={setQuery}
      onItemHighlighted={(item, { reason, index }) => {
        // Rows out of view aren't drawn, so the list scrolls to the highlight itself: on opening (the current font),
        // on typing (the first match) and when the keys wrap around past either end.
        if (item === undefined) return
        const end = index === shown.length - 1
        if (reason === 'none' || (reason === 'keyboard' && (index === 0 || end))) {
          queueMicrotask(() => virtualizer.scrollToIndex(index, { align: reason === 'none' ? 'auto' : end ? 'start' : 'end' }))
        }
      }}>
      <Combobox.Trigger className="superego-field superego-select superego-font-picker__button" aria-label={label}
        style={value ? { fontFamily: `"${value}"` } : undefined}>
        {value ?? nullLabel}
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner {...marked} className="superego-layer" side="bottom" align="end" sideOffset={6}>
          <Combobox.Popup className="superego-popover superego-font-picker__popover" initialFocus={autoFocusOnOpen()}>
            <Combobox.Input className="superego-field" placeholder="Search fonts" aria-label={`Search ${label}`} />
            {monospace && (
              <label className="superego-font-picker__all"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all fonts</label>
            )}
            {note ? <div className="superego-font-picker__note">{note}</div> : (
              <>
                <Combobox.Empty className="superego-font-picker__note">No fonts match</Combobox.Empty>
                <Combobox.List className="superego-font-picker__list">
                  {shown.length > 0 && (
                    <div role="presentation" ref={scrollerRef} className="superego-font-picker__scroller">
                      <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                        {virtualizer.getVirtualItems().map((row) => {
                          const item = shown[row.index]!
                          return (
                            <Combobox.Item key={row.key} index={row.index} data-index={row.index} ref={virtualizer.measureElement} value={item}
                              aria-setsize={shown.length} aria-posinset={row.index + 1} className="superego-font-picker__item"
                              style={{ transform: `translateY(${row.start}px)`, ...(item === DEFAULT ? {} : { fontFamily: `"${item}"` }) }}>
                              {item === DEFAULT ? nullLabel : item}
                            </Combobox.Item>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </Combobox.List>
              </>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
