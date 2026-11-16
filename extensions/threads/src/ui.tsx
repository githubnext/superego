/// <reference path="./env.d.ts" />
// threads: the Threads space in the sidebar. Projects (a repository or folder on a machine) and the threads in each; the machine is said on the project,
// where it isn't this computer. Its views:
// - the list (`threads.list`), a space: sorted recently active, newest first, or needs you first (an app setting); with
//   the sidebar hidden, a rail of status glyphs. A row's title is followed by other extensions' marks (the
//   `thread.badge` slot: a worktree's branch, say)
// - details (`threads.details`): what the thread runs with, spent and touched, then what other extensions say of it (the
//   `details.section` slot: its MCP servers, say); beside it or not, ⌘I
// - the model (`threads.model`), in the title bar: a button that shows or hides the details
// It also draws the thread tools' rows and `thread:` links (rows.tsx); the tools themselves are its daemon half's.
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  call, defineAction, defineUiExtension, MachineDrift, showProject, Slot, SORT, unread, useAppSetting, useDispatch, useLocalState, useMachines, usePlacement, useSelection, useProjects, useThreadView, useShell, useShortcut,
  type MachineEntry, type Project, type Sort, type SpaceRailProps, type WindowContext,
} from '@superego/app/ui'
import { rollup, waitingForSignIn, type ThreadInfo } from '@superego/protocol'
import { CaretRightIcon, ChatsIcon, DotsThreeIcon, IconButton, List, ListItem, Menu, PlusIcon, StatusGlyph, Tooltip, TooltipProvider } from '@superego/ui'
import './styles.css'
import { activity, ago } from './groups.ts'
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
    action('threads.sort.created', 'Sort threads: newest first', (c) => void set(c, SORT, 'created'))
    action('threads.sort.status', 'Sort threads: needs you first', (c) => void set(c, SORT, 'status'))
    action('threads.sort.recent', 'Sort threads: recently active', (c) => void set(c, SORT, 'recent'))
    // ⌘⌥↓ and ⌘⌥↑ too: the same step as thread.next and thread.previous, down the rows the sidebar shows.
    action('threads.next', 'Next thread', (c) => void c.dispatch('thread.next', {}, { source: 'threads' }), 'mod+alt+arrowdown')
    action('threads.previous', 'Previous thread', (c) => void c.dispatch('thread.previous', {}, { source: 'threads' }), 'mod+alt+arrowup')
  },
})

function Threads() {
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const { projects, lastThread, hold } = useProjects()
  const { selection, select } = useSelection()
  // While the pointer is over the list, rows keep their places: a thread changing state doesn't move under it. The
  // order is held for the whole window, so ⌘⇧[ and ⌘⇧] go down the rows as they stand.
  useEffect(() => () => hold(false), [])

  const isOn = (project: Project, thread: ThreadInfo) => selection?.machine === project.machine.id && selection.thread === thread.id
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
        <span className="threads__actions">
          <Options />
          <NewThreadButton label="New thread…" />
        </span>
      </div>
      {projects.length === 0 && <div className="threads__empty">{ready ? 'Start a thread in a folder to see its project here.' : 'Connecting…'}</div>}
      {projects.map((project) => (
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
            {project.threads.map((thread) => {
              const level = project.depth[thread.id] ?? 0
              return (
                <ListItem key={thread.id} selected={isOn(project, thread)} leading={<StatusGlyph status={thread.status} />}
                  {...(level ? { className: 'threads-child', style: { '--depth': level } as CSSProperties } : {})}
                  trailing={waitingForSignIn(thread.status) ? <span className="threads__why threads__why--quiet">waiting</span> : thread.status.state === 'blocked' ? <span className="threads__why">needs you</span> : thread.status.state === 'error' ? <span className="threads__why threads__why--error">failed</span> : ago(activity(thread))} onClick={() => select({ machine: project.machine.id, thread: thread.id })}>
                  <span className="threads__title">{thread.title}</span>
                  <Slot name="thread.badge" props={{ machine: project.machine, thread }} />
                </ListItem>
              )
            })}
          </List>
        </section>
      ))}
      <Archived machines={machines} live={projects} />
    </div>
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
      .then((lists) => { if (alive) setThreads(lists.flat().sort((a, b) => activity(b.thread) - activity(a.thread))) })
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
              <ListItem key={`${machine.id}/${thread.id}`} trailing={ago(activity(thread))}
                selected={selection?.machine === machine.id && selection.thread === thread.id}
                onClick={() => select({ machine: machine.id, thread: thread.id })}>
                {thread.title}
                <em className="threads-archived__where">{thread.project?.name ?? thread.cwd.split('/').filter(Boolean).at(-1)}{machine.id !== 'local' ? ` · ${machine.label}` : ''}</em>
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

const SORTS: { value: Sort; label: string }[] = [{ value: 'recent', label: 'Recently active' }, { value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' }]

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
 * dots here, and shows the list again; with another space open (or none: Settings, Ego's thread), it shows the list.
 * Something unread you can't see from here shows as a dot on the button, in the most pressing one's colour.
 */
function ThreadsRail({ open, sidebarHidden, show }: SpaceRailProps) {
  const { projects } = useProjects()
  const { selection, select } = useSelection()
  const hidden = open && sidebarHidden
  const toggleKeys = useShortcut(SIDEBAR)
  const waiting = projects.flatMap((s) => s.threads.filter((t) => unread(t) && !(s.machine.id === selection?.machine && t.id === selection.thread)).map((t) => t.status))
  const badge = !hidden && waiting.length ? rollup(waiting).state : undefined
  const click = () => show(!open || hidden)
  const isOn = (project: Project, thread: ThreadInfo) => selection?.machine === project.machine.id && selection.thread === thread.id
  return (
    <TooltipProvider>
      <Tooltip content={`${!open ? 'Show Threads' : hidden ? 'Show sidebar' : 'Hide sidebar'}${toggleKeys ? ` (${toggleKeys})` : ''}`} side="right">
        <IconButton label="Threads" className={`app__rail-button threads-rail__button ${open ? 'is-on' : ''}`} onClick={click}>
          <ChatsIcon size={18} aria-hidden />
          {badge && <span className={`threads-rail__badge threads-rail__badge--${badge}`} />}
        </IconButton>
      </Tooltip>
      {hidden && (
        <nav className="threads-rail" aria-label="Threads">
          {projects.map((project, index) => (
            <div key={project.key} className="threads-rail__group">
              {index > 0 && <div className="threads-rail__sep" />}
              {project.threads.map((thread) => (
                <Tooltip key={thread.id} side="right" content={<>{thread.title}<small className="threads-rail__tipnote">{waitingForSignIn(thread.status) ? 'waiting for sign-in' : thread.status.state === 'blocked' ? 'needs you' : ago(activity(thread))}</small></>}>
                  <button className={`threads-rail__dot ${isOn(project, thread) ? 'is-on' : ''} ${project.machine.state !== 'connected' ? 'is-stale' : ''}`}
                    aria-label={`${thread.title}, ${thread.status.state}`} onClick={() => select({ machine: project.machine.id, thread: thread.id })}>
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
        <dt>Active</dt><dd>{ago(activity(thread))}</dd>
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
