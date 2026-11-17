// threads: the Threads space in the sidebar. The pinned threads first, from every project and machine, then projects (a
// repository or folder on a machine) and the threads in each, its pinned at its top; the machine is said on the project,
// where it isn't this computer. Its views:
// - the list (`threads.list`), a space: sorted recently active, newest first, or needs you first (an app setting); with
//   the sidebar hidden, a rail of status glyphs; the key to go anywhere (⌘L) beside its heading, while pointed at. A row's title is followed by other extensions' marks (the
//   `thread.badge` slot: a worktree's branch, say); a right-click on it pins or unpins it, or archives it. Pinned
//   rows are dragged to reorder them, and a project's row dragged among them is pinned there
// - details (`threads.details`): what the thread runs with, spent and touched, then what other extensions say of it (the
//   `details.section` slot: its MCP servers, say); beside it or not, ⌘I
// - the model (`threads.model`), in the title bar: a button that shows or hides the details
// It also draws the thread tools' rows and `thread:` links (rows.tsx); the tools themselves are thread-tools'.
import { Fragment, useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import {
  call, defineAction, defineUiExtension, isPinned, MachineDrift, RailButton, showProject, Slot, SORT, unreadList, useAppSetting, useDispatch, useLocalState, useMachines, usePlacement, useSelection, useProjects, useThreadView, useShell, useShortcut, useRailShortcut,
  type MachineEntry, type Pin, type Project, type Sort, type SpaceRailProps, type WindowContext,
} from '@superego/app/ui'
import { rollup, statusLabel, STATUS_WORDS, waitingForSignIn, type ThreadInfo } from '@superego/protocol'
import { CaretRightIcon, ChatsIcon, ContextMenu, DotsThreeIcon, IconButton, List, ListItem, Menu, PlusIcon, PushPinIcon, StatusGlyph, Tooltip, TooltipProvider } from '@superego/ui'
import './styles.css'
import { ago } from './ago.ts'
import { registerLinks, registerRows } from './rows.tsx'
import { about } from './shared.ts'

/** The details view, and the action that puts it beside the thread or takes it away. */
const DETAILS = 'threads.details'
/** The shell's action that hides the sidebar, and shows it again: hidden, the list is dots in the rail. */
const SIDEBAR = 'app.sidebar'
/** How a project's machine is described while it isn't connected; anything else is offline. */
const STATE_WORDS: Partial<Record<MachineEntry['state'], string>> = { connecting: 'connecting', 'needs-login': 'needs login', 'host-key': 'host key to check', disabled: 'off' }

/** Settings and commands act through the app's settings, so every window and the menu agree. */
const set = (c: Pick<WindowContext, 'dispatch'>, key: string, value: string | boolean) =>
  c.dispatch('app.settings.set', { key, value }, { machine: 'app', source: 'threads' })

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.view('threads.list', { title: 'Threads', icon: ChatsIcon, context: 'window', fits: ['space'], default: 'space', component: Threads, railButton: ThreadsRail })
    superego.view(DETAILS, { title: 'Thread details', context: 'thread', fits: ['beside', 'pane'], component: DetailsPane })
    superego.view('threads.model', { title: 'Model', context: 'thread', fits: ['header'], default: 'header', component: ModelButton })
    registerRows(superego)
    registerLinks(superego)
    const action = (id: string, title: string, run: (c: WindowContext) => void, keys?: string) =>
      superego.action(defineAction({ id, title, ...(keys ? { keys } : {}), run: (_params, c) => run(c) }))
    action(DETAILS, 'Toggle thread details', (c) => void c.dispatch('layout.place', { view: DETAILS, place: 'beside' }, { source: 'threads' }), 'mod+i')
    for (const { value, label } of SORTS) action(`threads.sort.${value}`, `Sort threads: ${label.toLowerCase()}`, (c) => void set(c, SORT, value))
    // ⌘⌥↓ and ⌘⌥↑ too: the same step as thread.next and thread.previous, down the rows the sidebar shows.
    action('threads.next', 'Next thread', (c) => void c.dispatch('thread.next', {}, { source: 'threads' }), 'mod+alt+arrowdown')
    action('threads.previous', 'Previous thread', (c) => void c.dispatch('thread.previous', {}, { source: 'threads' }), 'mod+alt+arrowup')
  },
})

function Threads() {
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const { projects, sidebar, lastThread, hold } = useProjects()
  const { selection, select } = useSelection()
  // While the pointer is over the list, rows keep their places: a thread changing state doesn't move under it. The
  // order is held for the whole window, so ⌘⇧[ and ⌘⇧] go down the rows as they stand.
  useEffect(() => () => hold(false), [])

  // The machine is a fact about a project, said where it isn't this computer (or there are several to tell apart).
  const several = machines.length > 1
  const where = (project: Project) => project.machine.state !== 'connected'
    ? `${project.machine.label} · ${STATE_WORDS[project.machine.state] ?? 'offline'}`
    : several || project.machine.id !== 'local' ? project.machine.label : undefined
  const local = machines.find((m) => m.id === 'local')
  const ready = local?.state === 'connected'

  return (
    <div className={`threads ${ready ? 'is-ready' : ''}`} data-focus-scope onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)}>
      <div className="threads__head">
        <span>Threads</span>
        <GoKeys />
        <span className="threads__actions">
          <Options />
          <NewThreadButton label="New thread…" />
        </span>
      </div>
      {projects.length === 0 && <div className="threads__empty">{ready ? 'Start a thread in a folder to see its project here.' : local?.state === 'connecting' || !local?.error ? 'Connecting…' : local.error}</div>}
      {sidebar.pinned.length > 0 && <Pinned where={(project) => [project.name, where(project)].filter(Boolean).join(' · ')} />}
      {sidebar.projects.map((project) => (
        <section key={project.key} className={`threads-project ${project.machine.state !== 'connected' ? 'is-stale' : ''}`}>
          <div className="threads-project__head">
            <button className="threads-project__name" title={project.root} onClick={() => showProject({ select, lastThread }, project)}>
              {project.name}
              {where(project) && <em>{where(project)}</em>}
              {project.machine.remote && <MachineDrift machine={project.machine} />}
            </button>
            <NewThreadButton label={`New thread in ${project.name}`} machine={project.machine} cwd={project.root} />
          </div>
          <List>
            {project.threads.map((thread) => (
              <ThreadRow key={thread.id} machine={project.machine} thread={thread} level={project.depth[thread.id] ?? 0}
                selected={selection?.machine === project.machine.id && selection.thread === thread.id} />
            ))}
          </List>
        </section>
      ))}
      <Archived machines={machines} live={projects} />
    </div>
  )
}

/** What a dragged row carries: its thread, as a pin. */
const DRAGGED = 'application/x-superego-thread'

/**
 * The pinned threads, from every project and machine, in the order they were pinned, each saying where it is. Dragged,
 * a row moves; a project's row dropped here is pinned where it's dropped.
 */
function Pinned({ where }: { where(project: Project): string }) {
  const { sidebar } = useProjects()
  const { selection } = useSelection()
  const dispatch = useDispatch()
  // The gap a drop would land in: before the row at this index (the count: after the last).
  const [gap, setGap] = useState<number>()
  const gapAt = (event: DragEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-pin]')
    if (!row) return sidebar.pinned.length
    const box = row.getBoundingClientRect()
    return Number(row.dataset.pin) + (event.clientY > box.top + box.height / 2 ? 1 : 0)
  }
  const over = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAGGED)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setGap(gapAt(event))
  }
  const drop = (event: DragEvent) => {
    const raw = event.dataTransfer.getData(DRAGGED)
    setGap(undefined)
    if (!raw) return
    event.preventDefault()
    const pin = JSON.parse(raw) as Pin
    // Where it lands among the others: past its own place, one less.
    const from = sidebar.pinned.findIndex(({ project, thread }) => project.machine.id === pin.machine && thread.id === pin.thread)
    const to = gapAt(event)
    const at = from >= 0 && from < to ? to - 1 : to
    if (from === at) return
    void dispatch('thread.pin', { ...pin, at }, { source: 'threads' }).catch((error) => console.error(error))
  }
  return (
    <section className="threads-project threads-pinned" onDragOver={over} onDrop={drop} onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setGap(undefined)
    }}>
      <div className="threads-project__head"><span className="threads-project__name">Pinned</span></div>
      <List>
        {sidebar.pinned.map(({ project, thread }, index) => (
          <ThreadRow key={`${project.machine.id}/${thread.id}`} machine={project.machine} thread={thread} where={where(project)}
            selected={selection?.machine === project.machine.id && selection.thread === thread.id}
            className={`${project.machine.state !== 'connected' ? 'is-stale' : ''} ${gap === index ? 'is-drop-before' : ''} ${gap === index + 1 && index === sidebar.pinned.length - 1 ? 'is-drop-after' : ''}`}
            data-pin={index} />
        ))}
      </List>
    </section>
  )
}

/**
 * A thread's row: its status, title and marks (`thread.badge`), why it waits or when it was last active. Among the
 * pinned, where it is too; under its project, pinned, a pin. A right-click pins or unpins it, or archives it; it can be dragged into the pinned.
 */
function ThreadRow({ machine, thread, selected, level = 0, where, className = '', ...data }: {
  machine: MachineEntry; thread: ThreadInfo; selected: boolean; level?: number; where?: string; className?: string; 'data-pin'?: number
}) {
  const { select } = useSelection()
  const { pins } = useProjects()
  const dispatch = useDispatch()
  const archiveKeys = useShortcut('thread.archive')
  const at = { machine: machine.id, thread: thread.id }
  const on = isPinned(pins, at)
  const run = (id: string, options: { machine?: string } = {}) => () =>
    void dispatch(id, id === 'thread.archive' ? { thread: thread.id } : at, { source: 'threads', ...options }).catch((error) => console.error(error))
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <ListItem selected={selected} leading={<StatusGlyph status={thread.status} />} draggable {...data}
          className={`${level ? 'threads-child' : ''} ${className}`} {...(level ? { style: { '--depth': level } as CSSProperties } : {})}
          onDragStart={(event) => { event.dataTransfer.setData(DRAGGED, JSON.stringify(at)); event.dataTransfer.effectAllowed = 'move' }}
          trailing={waitingForSignIn(thread.status) ? <span className="threads__why threads__why--quiet">Waiting</span> : thread.status.state === 'blocked' ? <span className="threads__why">{STATUS_WORDS.blocked}</span> : thread.status.state === 'error' ? <span className="threads__why threads__why--error">{STATUS_WORDS.error}</span> : ago(thread.activeAt)}
          onClick={() => select(at)}>
          <span className="threads__title">{thread.title}</span>
          {on && !where && <PushPinIcon className="threads__pin" size={11} weight="fill" aria-label="Pinned" />}
          <Slot name="thread.badge" props={{ machine, thread }} />
          {where && <em className="threads-pinned__where">{where}</em>}
        </ListItem>
      </ContextMenu.Trigger>
      <ContextMenu.Popup className="threads-row-menu">
        <Menu.Item onClick={run(on ? 'thread.unpin' : 'thread.pin')}>{on ? 'Unpin' : 'Pin'}</Menu.Item>
        <Menu.Item onClick={run('thread.archive', { machine: machine.id })} hint={archiveKeys}>Archive</Menu.Item>
      </ContextMenu.Popup>
    </ContextMenu.Root>
  )
}

/** The key that goes to any project, thread or pane (the shell's navigator): a faint keycap, shown while pointed at. */
function GoKeys() {
  const dispatch = useDispatch()
  const keys = useShortcut('app.navigator')
  if (!keys) return null
  return (
    <button type="button" className="threads__go" title="Go to a project, thread or pane"
      onClick={() => void dispatch('app.navigator', {}, { source: 'threads' }).catch((error) => console.error(error))}>{keys}</button>
  )
}

/**
 * Threads put away, from every machine and project in one list, newest activity first; closed until opened. Picking one
 * shows it, read only; its Unarchive button brings it back.
 */
function Archived({ machines, live }: { machines: MachineEntry[]; live: Project[] }) {
  const [open, setOpen] = useLocalState('threads.archived.open', false)
  const { selection, select } = useSelection()
  const [threads, setThreads] = useState<{ machine: MachineEntry; thread: ThreadInfo }[]>()
  const connected = machines.filter((m) => m.state === 'connected')
  // Asked again whenever the threads in use change: archiving one moves it here, unarchiving moves it back.
  const inUse = live.flatMap((s) => s.threads.map((t) => `${s.machine.id}/${t.id}`)).sort().join(' ')
  const asked = connected.map((m) => m.id).join(' ')
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.all(connected.map((machine) => call<ThreadInfo[]>(machine.id, 'thread.list', { archived: true })
      .then((list) => list.map((thread) => ({ machine, thread })), () => [])))
      .then((lists) => { if (alive) setThreads(lists.flat().sort((a, b) => b.thread.activeAt - a.thread.activeAt)) })
    return () => { alive = false }
  }, [open, inUse, asked])
  return (
    <section className={`threads-archived ${open ? 'is-open' : ''}`}>
      <button className="threads-archived__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <CaretRightIcon className="threads-archived__caret" size={11} weight="bold" aria-hidden />
        Archived
        {open && threads && <em>{threads.length}</em>}
      </button>
      {open && (threads?.length === 0
        ? <div className="threads__empty">Nothing archived.</div>
        : (
          <List>
            {(threads ?? []).map(({ machine, thread }) => (
              <ListItem key={`${machine.id}/${thread.id}`} trailing={ago(thread.activeAt)}
                selected={selection?.machine === machine.id && selection.thread === thread.id}
                onClick={() => select({ machine: machine.id, thread: thread.id })}>
                {thread.title}
                <em className="threads-archived__where">{thread.project.name}{machine.id !== 'local' ? ` · ${machine.label}` : ''}</em>
              </ListItem>
            ))}
          </List>
        ))}
    </section>
  )
}

/** +: the New thread dialog, in a project's folder on its machine when given one. */
function NewThreadButton({ label, machine, cwd }: { label: string; machine?: MachineEntry; cwd?: string }) {
  const { newThread } = useShell()
  return (
    <IconButton label={label} className="threads__new" disabled={machine && machine.state !== 'connected'}
      onClick={() => newThread({ ...(machine ? { machine: machine.id } : {}), ...(cwd ? { cwd } : {}) })}><PlusIcon size={14} aria-hidden /></IconButton>
  )
}

const SORTS: { value: Sort; label: string }[] = [{ value: 'recent', label: 'Recently active' }, { value: 'created', label: 'Newest first' }, { value: 'status', label: `${STATUS_WORDS.blocked} first` }]

/** The ··· menu: sort, details, hiding the sidebar. */
function Options() {
  const [sort, setSort] = useAppSetting<Sort>(SORT)
  const [details, setDetails] = usePlacement(DETAILS, 'beside')
  const dispatch = useDispatch()
  const sidebarKeys = useShortcut(SIDEBAR)
  const detailsKeys = useShortcut(DETAILS)
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Threads options" className="threads-menu-trigger" />}><DotsThreeIcon size={16} weight="bold" aria-hidden /></Menu.Trigger>
      <Menu.Popup className="threads-menu">
        <Menu.Group>
          <Menu.GroupLabel>Sort</Menu.GroupLabel>
          <Menu.RadioGroup value={sort ?? 'recent'} onValueChange={(value) => void setSort(value as Sort)}>
            {SORTS.map((s) => <Menu.RadioItem key={s.value} value={s.value}>{s.label}</Menu.RadioItem>)}
          </Menu.RadioGroup>
        </Menu.Group>
        <Menu.Separator />
        <Menu.CheckboxItem checked={details} onCheckedChange={(checked) => setDetails(checked)} hint={detailsKeys}>Thread details</Menu.CheckboxItem>
        <Menu.Item onClick={() => void dispatch(SIDEBAR, {}, { source: 'threads' }).catch((error) => console.error(error))} hint={sidebarKeys}>Hide sidebar</Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  )
}

/**
 * In the window's rail: Threads, lit while they're the open space. A click hides the sidebar, the threads then status
 * dots here (the pinned first, as the list has them), and shows the list again; with another space open (or none: Settings, Ego's thread), it shows the list.
 * Something unread you can't see from here shows as a dot on the button, in the most pressing one's colour.
 */
function ThreadsRail({ open, sidebarHidden, show }: SpaceRailProps) {
  const { projects, sidebar } = useProjects()
  const { selection, select } = useSelection()
  const hidden = open && sidebarHidden
  const toggleKeys = useShortcut(SIDEBAR)
  const tabKeys = useRailShortcut()
  const waiting = unreadList(projects, selection).map(({ thread }) => thread.status)
  const badge = !hidden && waiting.length ? rollup(waiting).state : undefined
  const click = () => show(!open || hidden)
  // As the sidebar lists them, each once: the pinned first, then each project's others.
  const pinned = new Set(sidebar.pinned.map(({ project, thread }) => `${project.machine.id}/${thread.id}`))
  const groups = [
    ...(sidebar.pinned.length ? [{ key: 'pinned', threads: sidebar.pinned }] : []),
    ...sidebar.projects.map((project) => ({
      key: project.key, threads: project.threads.filter((t) => !pinned.has(`${project.machine.id}/${t.id}`)).map((thread) => ({ project, thread })),
    })).filter((group) => group.threads.length),
  ]
  return (
    <TooltipProvider>
      <Tooltip content={!open ? `Show Threads${tabKeys ? ` (${tabKeys})` : ''}` : `${hidden ? 'Show sidebar' : 'Hide sidebar'}${toggleKeys ? ` (${toggleKeys})` : ''}`} side="right">
        <RailButton label="Threads" className="threads-rail__button" on={open} onClick={click}>
          <ChatsIcon size={18} aria-hidden />
          {badge && <span className={`threads-rail__badge threads-rail__badge--${badge}`} />}
        </RailButton>
      </Tooltip>
      {hidden && (
        <nav className="threads-rail" aria-label="Threads">
          {groups.map((group, index) => (
            <div key={group.key} className="threads-rail__group">
              {index > 0 && <div className="threads-rail__sep" />}
              {group.threads.map(({ project, thread }) => (
                <Tooltip key={`${project.machine.id}/${thread.id}`} side="right" content={<>{thread.title}<small className="threads-rail__tipnote">{waitingForSignIn(thread.status) || thread.status.state === 'blocked' ? statusLabel(thread.status) : ago(thread.activeAt)}</small></>}>
                  <button className={`threads-rail__dot ${selection?.machine === project.machine.id && selection.thread === thread.id ? 'is-on' : ''} ${project.machine.state !== 'connected' ? 'is-stale' : ''}`}
                    aria-label={`${thread.title}, ${statusLabel(thread.status)}`} onClick={() => select({ machine: project.machine.id, thread: thread.id })}>
                    <StatusGlyph status={thread.status} />
                  </button>
                </Tooltip>
              ))}
            </div>
          ))}
        </nav>
      )}
      <div className="threads-rail__rule" />
    </TooltipProvider>
  )
}

/**
 * In the title bar: the model the thread runs with, as a button that shows or hides its details (what it runs with,
 * spent and touched), lit while they're shown.
 */
function ModelButton({ thread }: { thread: ThreadInfo }) {
  const [on, setOn] = usePlacement(DETAILS, 'beside')
  const keys = useShortcut(DETAILS)
  const model = thread.model?.split('/').at(-1) ?? 'No model'
  return (
    <button type="button" className={`threads-model ${on ? 'is-on' : ''}`} aria-pressed={Boolean(on)}
      title={`${thread.model ?? 'No model'}: ${on ? 'hide' : 'show'} thread details${keys ? ` (${keys})` : ''}`}
      onClick={() => setOn()}>
      {model}
    </button>
  )
}

type ToolCall = { name: string; arguments?: Record<string, unknown> }

/** The details: facts about the thread, and what its tools did. */
function DetailsPane({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const view = useThreadView(machine.id, machine.state === 'connected', thread.id)
  const { tools, files } = useMemo(() => {
    const tools = new Map<string, { count: number; failed: number }>()
    const files = new Set<string>()
    const failed = new Set<string>()
    for (const entry of view?.entries ?? []) {
      const message = entry.model?.[0] as { role?: string; isError?: boolean; toolCallId?: string; content?: unknown } | undefined
      if (message?.role === 'toolResult' && message.isError && message.toolCallId) failed.add(message.toolCallId)
    }
    for (const entry of view?.entries ?? []) {
      const message = entry.model?.[0] as { role?: string; content?: ({ type: string; id?: string } & ToolCall)[] } | undefined
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue
        const t = tools.get(block.name) ?? { count: 0, failed: 0 }
        t.count++
        if (block.id && failed.has(block.id)) t.failed++
        tools.set(block.name, t)
        const path = block.arguments?.path
        if (typeof path === 'string' && ['read', 'write', 'edit'].includes(block.name)) files.add(path)
      }
    }
    return { tools, files: [...files] }
  }, [view?.entries])
  const time = (at: number) => new Date(at).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
  return (
    <div className="threads-details">
      <h5>Thread</h5>
      <dl>
        <dt>Machine</dt><dd>{machine.label}</dd>
        <dt>Folder</dt><dd>{thread.cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')}</dd>
        {thread.model && <><dt>Model</dt><dd>{thread.model}</dd></>}
        <dt>Started</dt><dd>{time(thread.createdAt)}</dd>
        <dt>Active</dt><dd>{ago(thread.activeAt)}</dd>
        {thread.cost !== undefined && <><dt>Cost</dt><dd>${thread.cost.toFixed(2)}</dd></>}
      </dl>
      {tools.size > 0 && (
        <>
          <h5>Tools</h5>
          <dl>{[...tools].map(([name, t]) => <Fragment key={name}><dt>{name}</dt><dd>{t.count}{t.failed ? ` · ${t.failed} failed` : ''}</dd></Fragment>)}</dl>
        </>
      )}
      {files.length > 0 && (
        <>
          <h5>Files touched</h5>
          {files.map((file) => <div key={file} className="threads-details__file">{file}</div>)}
        </>
      )}
      <Slot name="details.section" props={{ machine, thread }} />
    </div>
  )
}
