import { useMemo, useState } from 'react'
import { Popover } from './popover.tsx'

/** Whether `family` draws every glyph the same width: "iiii" and "WWWW" measure alike. */
export function isMonospace(family: string): boolean {
  const context = (isMonospace.canvas ??= document.createElement('canvas')).getContext('2d')!
  context.font = `16px "${family}", serif`
  const narrow = context.measureText('iiiiiiii').width
  const wide = context.measureText('WWWWWWWW').width
  return Math.abs(narrow - wide) < 0.5
}
isMonospace.canvas = undefined as HTMLCanvasElement | undefined

/**
 * Pick a font family: a button that shows the current one in itself, and a searchable list where every family is
 * drawn in its own face. `loadFonts` runs on first open (font access needs the user's gesture). With `monospace`,
 * only fixed-width families are listed unless "all fonts" is ticked.
 */
export function FontPicker({ value, onChange, loadFonts, monospace, nullLabel = 'Default', label }: {
  value: string | null
  onChange(value: string | null): void
  loadFonts(): Promise<string[]>
  monospace?: boolean
  nullLabel?: string
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [fonts, setFonts] = useState<string[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(!monospace)

  const mono = useMemo(() => fonts && monospace ? new Set(fonts.filter(isMonospace)) : undefined, [fonts, monospace])
  const shown = (fonts ?? []).filter((family) => (all || !mono || mono.has(family)) && family.toLowerCase().includes(query.toLowerCase()))

  const toggle = (next: boolean) => {
    setOpen(next)
    if (next && !fonts) loadFonts().then(setFonts, (e: Error) => setError(e.message))
  }
  const choose = (family: string | null) => { onChange(family); setOpen(false); setQuery('') }

  return (
    <div className="superego-font-picker">
      <Popover open={open} onOpenChange={toggle} className="superego-font-picker__popover"
        trigger={<button type="button" className="superego-field superego-select superego-font-picker__button" aria-label={label} style={value ? { fontFamily: `"${value}"` } : undefined}>{value ?? nullLabel}</button>}>
        <input className="superego-field" autoFocus placeholder="Search fonts" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) choose(shown[0]) }} />
        {monospace && (
          <label className="superego-font-picker__all"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all fonts</label>
        )}
        <div className="superego-font-picker__list" role="listbox">
          {!query && <button type="button" role="option" aria-selected={value === null} onClick={() => choose(null)}>{nullLabel}</button>}
          {error ? <div className="superego-font-picker__note">{error}</div>
            : !fonts ? <div className="superego-font-picker__note">Loading fonts…</div>
            : shown.length === 0 ? <div className="superego-font-picker__note">No fonts match</div>
            : shown.map((family) => (
              <button key={family} type="button" role="option" aria-selected={family === value} style={{ fontFamily: `"${family}"` }} onClick={() => choose(family)}>
                {family}
              </button>
            ))}
        </div>
      </Popover>
    </div>
  )
}
