/// <reference path="./env.d.ts" />
// files, UI half: a file tree beside every file editor (its bar's button, or ⌘⇧E, shows and hides it), and quick open
// (⌘P): any file in the selected thread's folder by a few letters of its name, opened beside the thread in the pane
// kind that takes it. Clicking a file in the tree shows it in that editor; ⌘-click opens it beside.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react'
import {
  defineAction, defineUiExtension, fileKind, score, useAllThreads, useMachines, useRegistry, useSelection,
  type Dispatch, type EditorSlotProps, type MachineEntry,
} from '@mu/app/ui'
import type { ThreadInfo } from '@mu/protocol'
import { Dialog, IconButton } from '@mu/ui'
import './styles.css'
import { LIST, type FileList } from './shared.ts'

// ── State shared by the tree, its button and quick open, kept in the window ──────────────────────────────────────

function store<T>(key: string | undefined, initial: T) {
  let value: T = initial
  if (key) try { const raw = localStorage.getItem(key); if (raw !== null) value = JSON.parse(raw) as T } catch { /* keep initial */ }
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) { value = next; if (key) localStorage.setItem(key, JSON.stringify(next)); for (const l of listeners) l() },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
/** The tree beside the editor: closed until asked for, then as last left. */
const treeShown = store('mu.files.tree', false)
const quickOpen = store<boolean>(undefined, false)
/** Folders open in the tree, by session. */
const expanded = store<Record<string, string[]>>('mu.files.expanded', {})
const use = <T,>(s: ReturnType<typeof store<T>>) => useSyncExternalStore(s.subscribe, s.get)

let dispatch: Dispatch = () => Promise.reject(new Error('files is not set up'))

/** A thread's files, again whenever it moves on. */
function useFiles(machine: string | undefined, thread: ThreadInfo | undefined) {
  const [list, setList] = useState<FileList>()
  useEffect(() => {
    if (!machine || !thread) return
    let live = true
    dispatch(LIST, { id: thread.id }, { machine, source: 'files' }).then((l) => { if (live) setList(l as FileList) }, () => {})
    return () => { live = false }
  }, [machine, thread?.id, thread?.activeAt])
  return list
}

export default defineUiExtension({
  name: 'files',
  setup(mu) {
    dispatch = mu.dispatch
    mu.slot('editor.side', Tree)
    mu.slot('editor.bar', TreeButton)
    mu.slot('overlay', QuickOpen)
    mu.action(defineAction({ id: 'files.tree', title: 'Toggle file tree', runs: 'window', keys: 'mod+shift+e', run: () => treeShown.set(!treeShown.get()) }))
    mu.action(defineAction({ id: 'files.open', title: 'Open a file…', runs: 'window', keys: 'mod+p', run: () => quickOpen.set(true) }))
  },
})

// ── The tree ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Folder = { name: string; path: string; folders: Map<string, Folder>; files: string[] }

function treeOf(files: string[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.split('/')
    let at = root
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.get(part)
      if (!next) { next = { name: part, path: at.path ? `${at.path}/${part}` : part, folders: new Map(), files: [] }; at.folders.set(part, next) }
      at = next
    }
    at.files.push(file)
  }
  return root
}

function TreeButton() {
  const shown = use(treeShown)
  return (
    <IconButton label={shown ? 'Hide file tree' : 'Show file tree'} className={`files-toggle ${shown ? 'is-on' : ''}`} onClick={() => treeShown.set(!shown)}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
    </IconButton>
  )
}

function Tree({ machine, thread, path, open }: EditorSlotProps) {
  const shown = use(treeShown)
  const list = useFiles(shown ? machine.id : undefined, thread)
  const root = useMemo(() => treeOf(list?.files ?? []), [list])
  const session = thread.session?.root ?? thread.cwd
  const all = use(expanded)
  // The open file's folders start open.
  const ancestors = path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))
  const isOpen = (folder: string) => ancestors.includes(folder) || (all[session] ?? []).includes(folder)
  const toggle = (folder: string) => {
    const now = new Set(all[session] ?? [])
    if (isOpen(folder) && now.has(folder)) now.delete(folder)
    else if (isOpen(folder)) return // an ancestor of the open file: stays open
    else now.add(folder)
    expanded.set({ ...all, [session]: [...now] })
  }
  const here = useRef<HTMLDivElement>(null)
  useEffect(() => { here.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' }) }, [path, list])
  if (!shown) return null
  const pick = (file: string) => (event: MouseEvent) => open(file, { beside: event.metaKey || event.ctrlKey })

  const draw = (folder: Folder, depth: number): React.ReactNode => (
    <>
      {[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => (
        <div key={child.path}>
          <button className="files-tree__row files-tree__folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(child.path)}>
            <span className="files-tree__caret">{isOpen(child.path) ? '▾' : '▸'}</span>{child.name}
          </button>
          {isOpen(child.path) && draw(child, depth + 1)}
        </div>
      ))}
      {folder.files.map((file) => (
        <button key={file} className={`files-tree__row ${file === path ? 'is-current' : ''}`} style={{ paddingLeft: 20 + depth * 12 }}
          title={file} onClick={pick(file)}>
          {file.split('/').at(-1)}
        </button>
      ))}
    </>
  )
  return (
    <div className="files-tree" ref={here} aria-label="Files">
      {!list ? <div className="files-tree__note">Reading…</div> : draw(root, 0)}
      {list?.truncated && <div className="files-tree__note">Only the first {list.files.length} files.</div>}
    </div>
  )
}

// ── Quick open (⌘P) ──────────────────────────────────────────────────────────────────────────────────────────────

/** How well a file matches: its name first, then its whole path. */
const rank = (file: string, query: string) => Math.max(score(file.split('/').at(-1)!, query) * 2, score(file, query))

function QuickOpen() {
  const open = use(quickOpen)
  const { selection } = useSelection()
  if (!open || !selection) return null
  return <QuickOpenDialog machineId={selection.machine} threadId={selection.thread} onClose={() => quickOpen.set(false)} />
}

function QuickOpenDialog({ machineId, threadId, onClose }: { machineId: string; threadId: string; onClose(): void }) {
  const registry = useRegistry()
  const machine = useMachines().find((m) => m.id === machineId) as MachineEntry | undefined
  const thread = useAllThreads()[machineId]?.find((t) => t.id === threadId)
  const list = useFiles(machine?.id, thread)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const matches = useMemo(() => {
    const files = list?.files ?? []
    if (!query.trim()) return files.slice(0, 50)
    return files.map((file) => ({ file, r: rank(file, query) })).filter((m) => m.r > 0).sort((a, b) => b.r - a.r || a.file.length - b.file.length).slice(0, 50).map((m) => m.file)
  }, [list, query])
  const go = (file: string | undefined) => {
    if (!file || !thread || !machine) return
    onClose()
    void dispatch('pane.open', { id: thread.id, kind: fileKind(registry, thread, file), params: { path: file } }, { machine: machine.id, source: 'quick open' })
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    if (event.key === 'Enter') { event.preventDefault(); go(matches[active]) }
  }
  return (
    <Dialog onClose={onClose} size="medium" className="palette files-open" label="Open a file">
      <input className="palette__input" autoFocus placeholder={thread ? `Open a file in ${thread.session?.name ?? 'this thread'}` : 'Open a file'} value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown} />
      <ul className="palette__list" role="listbox">
        {matches.map((file, index) => {
          const slash = file.lastIndexOf('/')
          return (
            <li key={file} role="option" aria-selected={index === active} className={index === active ? 'is-active' : ''}
              onMouseMove={() => setActive(index)} onClick={() => go(file)}>
              <span className="palette__title">{file.slice(slash + 1)}</span>
              {slash > 0 && <span className="palette__detail">{file.slice(0, slash)}</span>}
            </li>
          )
        })}
        {list && matches.length === 0 && <li className="palette__none">Nothing matches</li>}
        {!list && <li className="palette__none">Reading…</li>}
      </ul>
    </Dialog>
  )
}
