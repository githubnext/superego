// files, UI half: a file tree beside every file editor (its bar's button, or ⌘⇧T, shows and hides it), and quick open
// (⌘P): any file in the selected thread's folder by a few letters of its name, opened beside the thread in the pane
// kind that takes it. Clicking a file in the tree shows it in that editor; ⌘-click opens it beside. A folder a thread
// names opens in a pane of its own (`folder`), as a tree to open files from, read from disk (ignored files too). The thread's whole folder is a view too
// (`files.folder`), offered for a sidebar, beside the thread or the pane menu: not placed until the user puts it somewhere.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  defineAction, defineUiExtension, fileKind, Picker, score, useAllThreads, useDispatch, useMachines, useMethod, useRegistry, useSelection,
  type EditorSlotProps, type MachineEntry, type PaneProps, type Store, type ViewProps,
} from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { CaretRightIcon, FolderSimpleIcon, IconButton } from '@superego/ui'
import './styles.css'
import { about, ENTRIES, FOLDER, LIST, type FileList, type FolderEntries } from './shared.ts'

// The tree, its button and quick open share what's shown, kept in the window (set in setup).
/** The tree beside the editor: closed until asked for, then as last left. */
let treeShown: Store<boolean>
let quickOpen: Store<boolean>
/** Folders open in the tree, by project. */
let expanded: Store<Record<string, string[]>>

/** A thread's files, again whenever it moves on. */
function useFiles(machine: string | undefined, thread: ThreadInfo | undefined) {
  return useMethod<FileList>(machine ?? '', LIST, { thread: thread?.id }, { enabled: Boolean(machine && thread), refresh: thread?.activeAt }).data
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    treeShown = superego.store<boolean>('tree', false, { persist: true })
    quickOpen = superego.store<boolean>('open', false)
    expanded = superego.store<Record<string, string[]>>('expanded', {}, { persist: true })
    superego.slot('editor.side', Tree)
    superego.slot('editor.bar', TreeButton)
    superego.slot('overlay', QuickOpen)
    superego.pane(FOLDER, {
      title: (pane) => folderTitle((pane.params as { path?: string } | undefined)?.path), icon: FolderSimpleIcon, component: FolderPane, folders: true,
    })
    superego.view('files.folder', {
      title: 'Files', icon: FolderSimpleIcon, context: 'thread', fits: ['sidebar', 'beside', 'pane'],
      component: ({ machine, thread }: ViewProps<'thread'>) => <FolderPane machine={machine} thread={thread} pane={{ id: 'files.folder', kind: FOLDER, params: { path: '' } }} />,
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
  const project = thread.project.root
  const all = expanded.use()
  // The open file's folders start open.
  const ancestors = path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))
  const isOpen = (folder: string) => ancestors.includes(folder) || (all[project] ?? []).includes(folder)
  const toggle = (folder: string) => {
    const now = new Set(all[project] ?? [])
    if (isOpen(folder) && now.has(folder)) now.delete(folder)
    else if (isOpen(folder)) return // an ancestor of the open file: stays open
    else now.add(folder)
    expanded.set({ ...all, [project]: [...now] })
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
  folder: Folder; depth: number; isOpen(path: string): boolean; toggle(path: string): void; pick(file: string, event: MouseEvent): void; current: string
}) {
  return (
    <>
      {[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => (
        <div key={child.path}>
          <button className="files-tree__row files-tree__folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(child.path)}>
            <CaretRightIcon size={10} weight="bold" className={`files-tree__caret ${isOpen(child.path) ? 'is-open' : ''}`} aria-hidden />{child.name}
          </button>
          {isOpen(child.path) && <FolderRows folder={child} depth={depth + 1} isOpen={isOpen} toggle={toggle} pick={pick} current={current} />}
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

/**
 * A folder a thread names (`''`: its whole folder), as a tree to browse; a file opens beside the thread (⌘-click too).
 * Unlike the tree beside the editor and quick open, which follow git (ignored files left out), it shows what's on disk
 * on the thread's machine: a folder asked for by its path is shown whole, ignored and untracked files too.
 */
function FolderPane({ machine, thread, pane }: PaneProps) {
  const registry = useRegistry()
  const dispatch = useDispatch()
  const path = ((pane.params as { path?: string } | undefined)?.path ?? '').replace(/\/+$/, '')
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (child: string) => setOpen((was) => { const next = new Set(was); if (!next.delete(child)) next.add(child); return next })
  const show = (file: string) => {
    const kind = fileKind(registry, { machine: machine.id, thread }, file)
    if (kind) void dispatch('pane.open', { thread: thread.id, kind, params: { path: file } }, { machine: machine.id, source: 'folder' })
  }
  return (
    <div className="files-folder" aria-label={path || 'Files'}>
      <FolderLevel machine={machine.id} thread={thread} path={path} depth={0} isOpen={(child) => open.has(child)} toggle={toggle} pick={show} />
    </div>
  )
}

/** One folder's rows in a folder pane, read from the thread's machine as it's shown: folders first, then files. */
function FolderLevel({ machine, thread, path, depth, isOpen, toggle, pick }: {
  machine: string; thread: ThreadInfo; path: string; depth: number; isOpen(path: string): boolean; toggle(path: string): void; pick(file: string): void
}) {
  const { data, error } = useMethod<FolderEntries>(machine, ENTRIES, { thread: thread.id, path }, { refresh: thread.activeAt })
  useEffect(() => { if (error) console.error(`files: couldn't read ${path || thread.cwd}`, error) }, [error, path, thread.cwd])
  const indent = { paddingLeft: 12 + depth * 12 }
  if (error) return <div className="files-tree__note files-tree__note--error" style={indent} role="alert">Couldn't read this folder: {error.message}</div>
  if (!data) return <div className="files-tree__note" style={indent}>Reading…</div>
  if (!data.entries.length) return <div className="files-tree__note" style={indent}>{depth ? 'Empty' : 'No files here.'}</div>
  return (
    <>
      {data.entries.map(({ name, folder }) => {
        const child = path ? `${path}/${name}` : name
        return folder ? (
          <div key={name}>
            <button className="files-tree__row files-tree__folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(child)}>
              <CaretRightIcon size={10} weight="bold" className={`files-tree__caret ${isOpen(child) ? 'is-open' : ''}`} aria-hidden />{name}
            </button>
            {isOpen(child) && <FolderLevel machine={machine} thread={thread} path={child} depth={depth + 1} isOpen={isOpen} toggle={toggle} pick={pick} />}
          </div>
        ) : (
          <button key={name} className="files-tree__row" style={{ paddingLeft: 22 + depth * 12 }} title={child} onClick={() => pick(child)}>{name}</button>
        )
      })}
    </>
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
  const files = useMemo(() => list?.files ?? [], [list])
  const go = (file: string) => {
    if (!thread || !machine) return
    onClose()
    const kind = fileKind(registry, { machine: machine.id, thread }, file)
    if (kind) void dispatch('pane.open', { thread: thread.id, kind, params: { path: file } }, { machine: machine.id, source: 'quick open' })
  }
  return (
    <Picker label="Open a file" className="files-open" placeholder={thread ? `Open a file in ${thread.project.name}` : 'Open a file'}
      items={files} onPick={go} onClose={onClose} empty={list ? 'Nothing matches' : 'Reading…'}
      filter={(all, query) => !query.trim() ? all.slice(0, 50)
        : all.map((file) => ({ file, r: rank(file, query) })).filter((m) => m.r > 0).sort((a, b) => b.r - a.r || a.file.length - b.file.length).slice(0, 50).map((m) => m.file)}
      row={(file) => {
        const slash = file.lastIndexOf('/')
        return { key: file, title: file.slice(slash + 1), ...(slash > 0 ? { detail: file.slice(0, slash) } : {}) }
      }} />
  )
}
