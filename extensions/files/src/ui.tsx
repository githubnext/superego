/// <reference path="./env.d.ts" />
// files, UI half: a file tree beside every file editor (its bar's button, or ⌘⇧T, shows and hides it), and quick open
// (⌘P): any file in the selected thread's folder by a few letters of its name, opened beside the thread in the pane
// kind that takes it. Clicking a file in the tree shows it in that editor; ⌘-click opens it beside. A folder a thread
// names opens in a pane of its own (`folder`), as a tree to open files from.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  call, defineAction, defineUiExtension, fileKind, score, useAllThreads, useDispatch, useMachines, useRegistry, useSelection,
  type EditorSlotProps, type MachineEntry, type PaneProps, type Store,
} from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { CaretRightIcon, Dialog, FolderSimpleIcon, IconButton } from '@superego/ui'
import './styles.css'
import { about, FOLDER, LIST, type FileList } from './shared.ts'

// The tree, its button and quick open share what's shown, kept in the window (set in setup).
/** The tree beside the editor: closed until asked for, then as last left. */
let treeShown: Store<boolean>
let quickOpen: Store<boolean>
/** Folders open in the tree, by session. */
let expanded: Store<Record<string, string[]>>

/** A thread's files, again whenever it moves on. */
function useFiles(machine: string | undefined, thread: ThreadInfo | undefined) {
  const [list, setList] = useState<FileList>()
  useEffect(() => {
    if (!machine || !thread) return
    let live = true
    call<FileList>(machine, LIST, { id: thread.id }).then((l) => { if (live) setList(l) }, () => {})
    return () => { live = false }
  }, [machine, thread?.id, thread?.activeAt])
  return list
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    treeShown = superego.store<boolean>('files.tree', false, { persist: true })
    quickOpen = superego.store<boolean>('files.open', false)
    expanded = superego.store<Record<string, string[]>>('files.expanded', {}, { persist: true })
    superego.slot('editor.side', Tree)
    superego.slot('editor.bar', TreeButton)
    superego.slot('overlay', QuickOpen)
    superego.pane(FOLDER, {
      title: (pane) => folderTitle((pane.params as { path?: string } | undefined)?.path), icon: FolderSimpleIcon, component: FolderPane, folders: true,
    })
    superego.action(defineAction({ id: 'files.tree', title: 'Toggle file tree', keys: 'mod+shift+t', run: () => treeShown.set((shown) => !shown) }))
    // Files of the thread shown: only while one is.
    superego.action(defineAction({ id: 'files.open', title: 'Open a file…', keys: 'mod+p', when: (c) => Boolean(c.selection), run: () => quickOpen.set(true) }))
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
  const shown = treeShown.use()
  return (
    <IconButton label={shown ? 'Hide file tree' : 'Show file tree'} className={`files-toggle ${shown ? 'is-on' : ''}`} onClick={() => treeShown.set(!shown)}>
      <FolderSimpleIcon size={15} aria-hidden />
    </IconButton>
  )
}

function Tree({ machine, thread, path, open }: EditorSlotProps) {
  const shown = treeShown.use()
  const list = useFiles(shown ? machine.id : undefined, thread)
  const root = useMemo(() => treeOf(list?.files ?? []), [list])
  const session = thread.session?.root ?? thread.cwd
  const all = expanded.use()
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
  const pick = (file: string, event: MouseEvent) => open(file, { beside: event.metaKey || event.ctrlKey })

  return (
    <div className="files-tree" ref={here} aria-label="Files">
      {!list ? <div className="files-tree__note">Reading…</div> : <FolderRows folder={root} depth={0} isOpen={isOpen} toggle={toggle} pick={pick} current={path} />}
      {list?.truncated && <div className="files-tree__note">Only the first {list.files.length} files.</div>}
    </div>
  )
}

/** A folder's rows, folders first: each folder a row that opens and closes, then its files by name. */
function FolderRows({ folder, depth, isOpen, toggle, pick, current }: {
  folder: Folder; depth: number; isOpen(path: string): boolean; toggle(path: string): void; pick(file: string, event: MouseEvent): void; current?: string
}) {
  return (
    <>
      {[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => (
        <div key={child.path}>
          <button className="files-tree__row files-tree__folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(child.path)}>
            <CaretRightIcon size={10} weight="bold" className={`files-tree__caret ${isOpen(child.path) ? 'is-open' : ''}`} aria-hidden />{child.name}
          </button>
          {isOpen(child.path) && <FolderRows folder={child} depth={depth + 1} isOpen={isOpen} toggle={toggle} pick={pick} {...(current ? { current } : {})} />}
        </div>
      ))}
      {folder.files.map((file) => (
        <button key={file} className={`files-tree__row ${file === current ? 'is-current' : ''}`} style={{ paddingLeft: 22 + depth * 12 }}
          title={file} onClick={(event) => pick(file, event)}>
          {file.split('/').at(-1)}
        </button>
      ))}
    </>
  )
}

// ── A folder, in a pane ──────────────────────────────────────────────────────────────────────────────────────────

/** A folder pane's tab: the folder's own name. */
const folderTitle = (path: string | undefined) => path ? `${path.split('/').at(-1)}/` : undefined

/** A folder a thread names (`''`: its whole folder), as a tree to browse; a file opens beside the thread (⌘-click too). */
function FolderPane({ machine, thread, pane }: PaneProps) {
  const registry = useRegistry()
  const dispatch = useDispatch()
  const path = ((pane.params as { path?: string } | undefined)?.path ?? '').replace(/\/+$/, '')
  const list = useFiles(machine.id, thread)
  // The thread's whole tree, shown from this folder down.
  const folder = useMemo(() => path.split('/').filter(Boolean).reduce<Folder | undefined>((at, part) => at?.folders.get(part), treeOf(list?.files ?? [])), [list, path])
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (child: string) => setOpen((was) => { const next = new Set(was); if (!next.delete(child)) next.add(child); return next })
  const show = (file: string) =>
    void dispatch('pane.open', { id: thread.id, kind: fileKind(registry, { machine: machine.id, thread }, file), params: { path: file } }, { machine: machine.id, source: 'folder' })
  return (
    <div className="files-folder" aria-label={path || 'Files'}>
      {!list ? <div className="files-tree__note">Reading…</div>
        : !folder ? <div className="files-tree__note">No files here.</div>
        : <FolderRows folder={folder} depth={0} isOpen={(child) => open.has(child)} toggle={toggle} pick={show} />}
      {list?.truncated && <div className="files-tree__note">Only the first {list.files.length} files.</div>}
    </div>
  )
}

// ── Quick open (⌘P) ──────────────────────────────────────────────────────────────────────────────────────────────

/** How well a file matches: its name first, then its whole path. */
const rank = (file: string, query: string) => Math.max(score(file.split('/').at(-1)!, query) * 2, score(file, query))

function QuickOpen() {
  const open = quickOpen.use()
  const { selection } = useSelection()
  if (!open || !selection) return null
  return <QuickOpenDialog machineId={selection.machine} threadId={selection.thread} onClose={() => quickOpen.set(false)} />
}

function QuickOpenDialog({ machineId, threadId, onClose }: { machineId: string; threadId: string; onClose(): void }) {
  const registry = useRegistry()
  const dispatch = useDispatch()
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
    void dispatch('pane.open', { id: thread.id, kind: fileKind(registry, { machine: machine.id, thread }, file), params: { path: file } }, { machine: machine.id, source: 'quick open' })
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
