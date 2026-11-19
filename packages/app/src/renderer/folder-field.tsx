// A folder to start a thread in: typed, or picked from the folders a machine's threads worked in, most recent first,
// each by its name with the folder it's in beside it. The list opens when asked for (`open()`: the field's key), on ↓,
// a click or typing, and narrows as you type; ↑↓ move, ⏎ takes one, esc closes it (a second esc, the dialog).
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { TextField } from '@superego/ui'
import { score } from './score.ts'
import { shortPath } from './short-path.ts'

/** The projects `threads` worked in (each repository by its main checkout), the most recently active first. */
export function recentFolders(threads: readonly ThreadInfo[]): string[] {
  const sorted = threads.slice().sort((a, b) => (b.activeAt ?? b.createdAt) - (a.activeAt ?? a.createdAt))
  return [...new Set(sorted.map((t) => t.project.root))]
}

/**
 * Those of `folders` that `query` matches, best first: by the folder's name, then its whole path (as typed, `~` and
 * all); the most recent first among equals.
 */
export function matchFolders(folders: readonly string[], query: string): string[] {
  const q = query.trim()
  if (!q) return [...folders]
  const rank = (folder: string) => Math.max(score(folder.split('/').at(-1) ?? folder, q) * 2, score(folder, q), score(shortPath(folder), q))
  return folders.map((folder, index) => ({ folder, index, rank: rank(folder) }))
    .filter((f) => f.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((f) => f.folder)
}

/** How many the list shows at most: it scrolls, and typing finds the rest. */
const SHOWN = 50

/** The field, to its dialog: go to it, its list open. */
export type FolderFieldHandle = { open(): void }

export const FolderField = forwardRef<FolderFieldHandle, {
  value: string
  onChange(folder: string): void
  folders: readonly string[]
  /** Said under the list: why some folders may be missing. */
  problem?: string
  autoFocus?: boolean
}>(function FolderField({ value, onChange, folders, problem, autoFocus }, ref) {
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // What narrows the list: what was typed since it opened. Opened on a folder already there, it lists them all.
  const [query, setQuery] = useState<string>()
  const [active, setActive] = useState(0)
  const shown = matchFolders(folders, query ?? '').slice(0, SHOWN)
  const show = () => {
    setOpen(true)
    setQuery(undefined)
    const at = folders.indexOf(value)
    setActive(at >= 0 && at < SHOWN ? at : 0)
  }
  // The lit one in sight, as ↑↓ move it.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }) }, [active, open])
  useImperativeHandle(ref, () => ({ open() { input.current?.focus(); show() } }), [folders, value])
  const take = (folder: string) => { onChange(folder); setOpen(false) }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) return show()
      if (shown.length) setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
    } else if (event.key === 'Enter' && open && shown[active]) {
      event.preventDefault()
      take(shown[active]!)
    } else if (event.key === 'Escape' && open) {
      // Only the list closes: not the dialog.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }
  return (
    <div className="folder-field">
      <TextField ref={input} aria-label="Folder" placeholder="Home folder" value={value} role="combobox" aria-expanded={open} aria-autocomplete="list"
        spellCheck={false} autoComplete="off" autoFocus={autoFocus}
        onBlur={() => setOpen(false)} onKeyDown={onKeyDown} onClick={() => { if (!open) show() }}
        onChange={(e) => { onChange(e.target.value); setQuery(e.target.value); setActive(0); setOpen(true) }} />
      {open && (shown.length > 0 || problem) && (
        <div ref={list} className="folder-field__list" role="listbox" aria-label="Recent folders">
          {shown.map((folder, index) => (
            <div key={folder} role="option" aria-selected={index === active} className={`folder-field__item ${index === active ? 'is-active' : ''}`}
              onMouseEnter={() => setActive(index)} onMouseDown={(e) => { e.preventDefault(); take(folder) }}>
              <span className="folder-field__name">{folder.split('/').at(-1) || folder}</span>
              <span className="folder-field__path">{shortPath(folder.slice(0, folder.lastIndexOf('/')) || '/')}</span>
            </div>
          ))}
          {problem && <div className="folder-field__problem">{problem}</div>}
        </div>
      )}
    </div>
  )
})
