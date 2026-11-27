// files, UI half: a file tree beside every file editor (its bar's button, or ⌘⇧T, shows and hides it), and quick open
// (⌘P): any file in the selected thread's folder by a few letters of its name, opened beside the thread in the pane
// kind that takes it. Clicking a file in the tree shows it in that editor; ⌘-click opens it beside. A folder a thread
// names opens in a pane of its own (`folder`), as a tree to open files from, read from disk (ignored files too). The thread's whole folder is a view too
// (`files.folder`), offered beside the thread or in the pane menu: not placed until the user puts it somewhere.
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  ContextMenu, defineAction, defineUiExtension, fileKind, has, Menu, PaneHeader, Picker, score, TextField, useAllThreads, useDispatch, useMachines, useMethod,
  useRegistry, useSelection,
  type EditorSlotProps, type MachineEntry, type PaneProps, type Store, type ViewProps,
} from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { CaretRightIcon, FilePlusIcon, FolderSimpleIcon, FolderSimplePlusIcon, IconButton } from '@superego/ui'
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
      title: 'Files', icon: FolderSimpleIcon, context: 'thread', fits: ['beside', 'pane'],
      component: ({ machine, thread }: ViewProps<'thread'>) => <FolderPane machine={machine} thread={thread} pane={{ id: 'files.folder', kind: FOLDER, params: { path: '' } }} />,
    })
    superego.action(defineAction({ id: 'files.tree', title: 'Toggle file tree', keys: 'mod+shift+t', run: () => treeShown.set((shown) => !shown) }))
    // Files of the thread shown: only while one is.
    // In the folder pane with the keyboard: a new file named in place. (⌘N is New thread's.)
    superego.action(defineAction({
      id: 'files.new', title: 'New file', keys: 'mod+alt+n', when: () => focusedFolder()?.dataset.creates !== undefined,
      run: () => { focusedFolder()?.dispatchEvent(new CustomEvent(NEW_FILE)) },
    }))
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

/** Sent to a folder pane's box: start a new file where it would (⌥⌘N). */
const NEW_FILE = 'files:new-file'
/** The folder pane with the keyboard: the one holding the focus, or the one in the pane that does. */
const focusedFolder = () => {
  const at = document.activeElement
  return at?.closest<HTMLElement>('.files-folder') ?? at?.closest('[data-column]')?.querySelector<HTMLElement>(':scope > .panes__body .files-folder') ?? undefined
}

/** `name` in the folder `dir` (`''`: the thread's folder). */
const inside = (dir: string, name: string) => dir && name ? `${dir}/${name}` : dir || name

/** What's wrong with a name typed for a new file or folder (`docs/new.md` makes `docs` too), if anything. */
function nameProblem(name: string): string | undefined {
  const parts = name.split('/')
  if (parts.some((part) => !part)) return "A name can't start or end with /, or have // in it"
  if (parts.some((part) => part === '.' || part === '..')) return "A name can't be . or .."
  return undefined
}

/** A new file or folder being named, in the folder `in`. */
type Naming = { in: string; folder: boolean }

/**
 * A folder a thread names (`''`: its whole folder), as a tree to browse; a file opens beside the thread (⌘-click too).
 * Unlike the tree beside the editor and quick open, which follow git (ignored files left out), it shows what's on disk
 * on the thread's machine: a folder asked for by its path is shown whole, ignored and untracked files too. A new file
 * or folder is named in place, in the folder selected (a file's, for a file) or right-clicked, else this one.
 */
function FolderPane({ machine, thread, pane }: PaneProps) {
  const registry = useRegistry()
  const dispatch = useDispatch()
  const path = ((pane.params as { path?: string } | undefined)?.path ?? '').replace(/\/+$/, '')
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  /** The row last clicked, and the folder new things go in from there. */
  const [selected, setSelected] = useState<{ path: string; in: string }>()
  const [naming, setNaming] = useState<Naming>()
  /** Read again after making something, so it shows. */
  const [made, setMade] = useState(0)
  const creates = has(machine, 'file-create')
  const toggle = (child: string) => setOpen((was) => { const next = new Set(was); if (!next.delete(child)) next.add(child); return next })
  const show = (file: string) => {
    const kind = fileKind(registry, { machine: machine.id, thread }, file)
    if (kind) void dispatch('pane.open', { thread: thread.id, kind, params: { path: file } }, { machine: machine.id, source: 'folder' })
  }
  const startNaming = (folder: boolean, at = selected?.in ?? path) => {
    if (at !== path) setOpen((was) => new Set(was).add(at))
    setNaming({ in: at, folder })
  }
  const box = useRef<HTMLDivElement>(null)
  const create = async (name: string) => {
    if (!naming) return
    const target = inside(naming.in, name)
    await dispatch('file.create', { thread: thread.id, path: target, ...(naming.folder ? { folder: true } : {}) }, { machine: machine.id, source: 'folder' })
    // The folders on the way to it open, so it shows.
    const parts = name.split('/')
    setOpen((was) => {
      const next = new Set(was)
      for (let i = 1; i < parts.length; i++) next.add(inside(naming.in, parts.slice(0, i).join('/')))
      if (naming.folder) next.add(target)
      return next
    })
    setSelected({ path: target, in: naming.folder ? target : inside(naming.in, parts.slice(0, -1).join('/')) })
    setMade((n) => n + 1)
    // A file opens in the editor, which takes the focus; else it stays in the pane.
    if (naming.folder) stopNaming()
    else { setNaming(undefined); show(target) }
  }
  const stopNaming = () => {
    // The field had the focus: its pane takes it back, rather than nothing having it.
    if (box.current?.contains(document.activeElement)) box.current.closest<HTMLElement>('[data-column]')?.focus({ preventScroll: true })
    setNaming(undefined)
  }
  const startRef = useRef(startNaming)
  startRef.current = startNaming
  useEffect(() => {
    const el = box.current
    if (!el || !creates) return
    const start = () => startRef.current(false)
    el.addEventListener(NEW_FILE, start)
    return () => el.removeEventListener(NEW_FILE, start)
  }, [creates])
  const level: LevelProps = {
    machine: machine.id, thread, depth: 0, made, isOpen: (child) => open.has(child), toggle, pick: show, selected: selected?.path,
    select: (child, folderIn) => setSelected({ path: child, in: folderIn }),
    naming: naming && { ...naming, create, cancel: stopNaming },
    ...(creates ? { startNaming } : {}),
  }
  return (
    <div className="files-folder" ref={box} aria-label={path || 'Files'} data-creates={creates ? '' : undefined}>
      {creates && (
        <PaneHeader>
          <span className="files-folder__actions">
            <IconButton label="New file" className="files-folder__new" onClick={() => startNaming(false)}><FilePlusIcon size={14} aria-hidden /></IconButton>
            <IconButton label="New folder" className="files-folder__new" onClick={() => startNaming(true)}><FolderSimplePlusIcon size={14} aria-hidden /></IconButton>
          </span>
        </PaneHeader>
      )}
      <FolderLevel {...level} path={path} />
    </div>
  )
}

type LevelProps = {
  machine: string; thread: ThreadInfo; depth: number
  /** How many things were made here: each one reads the open folders again. */
  made: number
  isOpen(path: string): boolean; toggle(path: string): void; pick(file: string): void
  selected: string | undefined
  select(path: string, folderIn: string): void
  /** Name a new file or folder in `at` (none where nothing can be made). */
  startNaming?: (folder: boolean, at: string) => void
  naming: (Naming & { create(name: string): Promise<void>; cancel(): void }) | undefined
}

/** One folder's rows in a folder pane, read from the thread's machine as it's shown: folders first, then files. */
function FolderLevel(props: LevelProps & { path: string }) {
  const { machine, thread, path, depth, made, isOpen, toggle, pick, selected, select, startNaming, naming } = props
  const { data, error } = useMethod<FolderEntries>(machine, ENTRIES, { thread: thread.id, path }, { refresh: `${thread.activeAt}/${made}` })
  useEffect(() => { if (error) console.error(`files: couldn't read ${path || thread.cwd}`, error) }, [error, path, thread.cwd])
  const indent = { paddingLeft: 12 + depth * 12 }
  const field = naming?.in === path && <NameField key="naming" depth={depth} folder={naming.folder} create={naming.create} cancel={naming.cancel} />
  if (error) return <div className="files-tree__note files-tree__note--error" style={indent} role="alert">Couldn't read this folder: {error.message}</div>
  if (!data) return <div className="files-tree__note" style={indent}>Reading…</div>
  if (!data.entries.length && !field) return <div className="files-tree__note" style={indent}>{depth ? 'Empty' : 'No files here.'}</div>
  return (
    <>
      {field}
      {data.entries.map(({ name, folder }) => {
        const child = inside(path, name)
        const current = child === selected ? 'is-current' : ''
        if (!folder) {
          return <button key={name} className={`files-tree__row ${current}`} style={{ paddingLeft: 22 + depth * 12 }} title={child}
            onClick={() => { select(child, path); pick(child) }}>{name}</button>
        }
        const row = (
          <button className={`files-tree__row files-tree__folder ${current}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => { select(child, child); toggle(child) }}>
            <CaretRightIcon size={10} weight="bold" className={`files-tree__caret ${isOpen(child) ? 'is-open' : ''}`} aria-hidden />{name}
          </button>
        )
        return (
          <div key={name}>
            {startNaming ? <FolderMenu at={child} start={startNaming}>{row}</FolderMenu> : row}
            {isOpen(child) && <FolderLevel {...props} path={child} depth={depth + 1} />}
          </div>
        )
      })}
    </>
  )
}

/** A folder row's menu, on a right-click or a long press: something new in it. */
function FolderMenu({ at, start, children }: { at: string; start(folder: boolean, at: string): void; children: ReactNode }) {
  // Picked, the focus goes to the name's field rather than back to the row.
  const picked = useRef(false)
  const pick = (folder: boolean) => { picked.current = true; start(folder, at) }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Popup finalFocus={() => { const back = !picked.current; picked.current = false; return back }}>
        <Menu.Item onClick={() => pick(false)}>New file here</Menu.Item>
        <Menu.Item onClick={() => pick(true)}>New folder here</Menu.Item>
      </ContextMenu.Popup>
    </ContextMenu.Root>
  )
}

/** The name of a new file or folder, typed in place: Return makes it, Escape doesn't; why not, under it. */
function NameField({ depth, folder, create, cancel }: { depth: number; folder: boolean; create(name: string): Promise<void>; cancel(): void }) {
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [folder])
  const submit = async () => {
    const typed = name.trim()
    if (!typed) return cancel()
    const wrong = nameProblem(typed)
    if (wrong) return setProblem(wrong)
    setBusy(true)
    try {
      await create(typed)
    } catch (error) {
      console.error(`files: couldn't create ${typed}`, error)
      setProblem((error as Error).message)
      setBusy(false)
      input.current?.focus()
    }
  }
  // Its text where the names beside it start.
  return (
    <div className="files-name" style={{ paddingLeft: 15 + depth * 12 }}>
      <TextField ref={input} className="files-name__field" value={name} readOnly={busy} placeholder={folder ? 'New folder' : 'New file'}
        aria-label={folder ? 'New folder' : 'New file'} aria-invalid={problem ? true : undefined} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        onChange={(event) => { setName(event.target.value); setProblem(undefined) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); void submit() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
        }} />
      {problem && <div className="files-name__problem" role="alert">{problem}</div>}
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
