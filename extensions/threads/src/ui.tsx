/// <reference path="./env.d.ts" />
// threads: the sidebar. Sessions (a project on a machine) and the threads in each; the machine is said on the session,
// where it isn't this computer. One extension with modes, all kept as app settings:
// - sort: recently active, newest first, or needs you first: sessions, and the threads in each
// - show as: a list, or a rail of status glyphs
// - details: a pane beside the thread with what it runs with, spent and touched
// It also draws the thread tools' rows and `thread:` links (rows.tsx); the tools themselves are its daemon half's.
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import {
  call, defineAction, defineUiExtension, MachineDrift, showSession, SORT, unread, useAppSetting, useLocalState, useMachines, useSelection, useSessions, useSidebar, useThreadView, useShell, useShortcut,
  type MachineEntry, type Session, type Sort, type Store, type WindowContext,
} from '@superego/app/ui'
import { rollup, type ThreadInfo } from '@superego/protocol'
import { CaretRightIcon, ChatsIcon, DotsThreeIcon, IconButton, List, ListItem, Menu, PlusIcon, StatusGlyph, Tooltip, TooltipProvider } from '@superego/ui'
import './styles.css'
import { activity, ago } from './groups.ts'
import { registerLinks, registerRows } from './rows.tsx'
import { about } from './shared.ts'

export const VIEW = 'threads.view'
export const DETAILS = 'threads.details'
export type View = 'list' | 'rail'

/**
 * A narrow window folds the list into dots by itself, as if it were set to; the Threads button unfolds it there for a
 * while (until the window is wide again). Shared by the list and the rail.
 */
let unfolded: Store<boolean>

/** Settings and commands act through the app's settings, so every window and the menu agree. */
const set = (c: Pick<WindowContext, 'dispatch'>, key: string, value: string | boolean) =>
  c.dispatch('app.settings.set', { key, value }, { machine: 'app', source: 'threads' })

export default defineUiExtension({
  ...about,
  setup(superego) {
    unfolded = superego.store<boolean>('threads.unfolded', false)
    superego.appSettings({
      id: 'threads', title: 'Sidebar', order: 55,
      settings: [
        { key: VIEW, title: 'Show as', default: 'list', type: 'choice', options: [{ value: 'list', label: 'List' }, { value: 'rail', label: 'Rail' }] },
        { key: DETAILS, title: 'Thread details', description: 'A pane beside the thread: machine, model, cost, tools, files.', default: false, type: 'boolean' },
      ],
    })
    superego.slot('sidebar', Threads)
    superego.slot('rail', ThreadsRail)
    superego.slot('thread.aside', Details)
    superego.slot('thread.header', ModelButton)
    registerRows(superego)
    registerLinks(superego)
    const action = (id: string, title: string, run: (c: WindowContext) => void, keys?: string) =>
      superego.action(defineAction({ id, title, ...(keys ? { keys } : {}), run: (_params, c) => run(c) }))
    action('threads.rail', 'Toggle sidebar rail', (c) => void set(c, VIEW, c.appSetting<View>(VIEW) === 'rail' ? 'list' : 'rail'), 'mod+\\')
    action('threads.details', 'Toggle thread details', (c) => void set(c, DETAILS, !c.appSetting<boolean>(DETAILS)), 'mod+i')
    action('threads.sort.created', 'Sort threads: newest first', (c) => void set(c, SORT, 'created'))
    action('threads.sort.status', 'Sort threads: needs you first', (c) => void set(c, SORT, 'status'))
    action('threads.sort.recent', 'Sort threads: recently active', (c) => void set(c, SORT, 'recent'))
    // ⌘⌥↓ and ⌘⌥↑ too: the same step as thread.next and thread.previous, down the rows the sidebar shows.
    action('threads.next', 'Next thread', (c) => void c.dispatch('thread.next', {}, { source: 'threads' }), 'mod+alt+arrowdown')
    action('threads.previous', 'Previous thread', (c) => void c.dispatch('thread.previous', {}, { source: 'threads' }), 'mod+alt+arrowup')
  },
})

const NARROW = '(min-width: 600px) and (max-width: 760px)'
/** A phone (as the app's own layout takes it): the list is a drawer there, never folded. */
const PHONE = '(max-width: 599px)'
function useFolded(view: View | undefined) {
  const narrow = useSyncExternalStore((change) => { const list = matchMedia(NARROW); list.addEventListener('change', change); return () => list.removeEventListener('change', change) }, () => matchMedia(NARROW).matches)
  const open = unfolded.use()
  useEffect(() => { if (!narrow) unfolded.set(false) }, [narrow])
  const phone = useSyncExternalStore((change) => { const list = matchMedia(PHONE); list.addEventListener('change', change); return () => list.removeEventListener('change', change) }, () => matchMedia(PHONE).matches)
  return { folded: !phone && ((view ?? 'list') === 'rail' || (narrow && !open)), narrow }
}

function Threads() {
  const [view] = useAppSetting<View>(VIEW)
  const { folded } = useFolded(view)
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const { sessions, lastThread, hold } = useSessions()
  const { selection, select } = useSelection()
  // While the pointer is over the list, rows keep their places: a thread changing state doesn't move under it. The
  // order is held for the whole window, so ⌘⇧[ and ⌘⇧] go down the rows as they stand.
  useEffect(() => () => hold(false), [])

  const isOn = (session: Session, thread: ThreadInfo) => selection?.machine === session.machine.id && selection.thread === thread.id
  // The machine is a fact about a session, said where it isn't this computer (or there are several to tell apart).
  const several = machines.length > 1
  const where = (session: Session) => session.machine.state !== 'connected'
    ? `${session.machine.label} · ${session.machine.state === 'connecting' ? 'connecting' : 'offline'}`
    : several || session.machine.id !== 'local' ? session.machine.label : undefined
  const local = machines.find((m) => m.id === 'local')
  const ready = local?.state === 'connected'

  // Folded, the threads are dots in the window's rail (ThreadsRail); the sidebar has nothing to show.
  if (folded) return null
  return (
    <div className={`threads ${ready ? 'is-ready' : ''}`} data-focus-scope onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)}>
      <div className="threads__head">
        <span>Threads</span>
        <span className="threads__actions">
          <Options />
          <NewThreadButton label="New thread…" />
        </span>
      </div>
      {sessions.length === 0 && <div className="threads__empty">{ready ? 'Start a thread in a project folder: it becomes a session here.' : 'Connecting…'}</div>}
      {sessions.map((session) => (
        <section key={session.key} className={`threads-session ${session.machine.state !== 'connected' ? 'is-stale' : ''}`}>
          <div className="threads-session__head">
            <button className="threads-session__name" title={session.root} onClick={() => showSession({ select, lastThread }, session)}>
              {session.name}
              {where(session) && <em>{where(session)}</em>}
              {session.machine.remote && <MachineDrift machine={session.machine} />}
            </button>
            <NewThreadButton label={`New thread in ${session.name}`} machine={session.machine} cwd={session.root} />
          </div>
          <List>
            {session.threads.map((thread) => {
              const level = session.depth[thread.id] ?? 0
              return (
                <ListItem key={thread.id} selected={isOn(session, thread)} leading={<StatusGlyph status={thread.status} />}
                  {...(level ? { className: 'threads-child', style: { '--depth': level } as CSSProperties } : {})}
                  trailing={thread.status.state === 'blocked' ? <span className="threads__why">needs you</span> : thread.status.state === 'error' ? <span className="threads__why threads__why--error">failed</span> : ago(activity(thread))} onClick={() => select({ machine: session.machine.id, thread: thread.id })}>
                  {thread.title}
                </ListItem>
              )
            })}
          </List>
        </section>
      ))}
      <Archived machines={machines} live={sessions} />
    </div>
  )
}

/**
 * Threads put away, from every machine and project in one list, newest activity first; folded until opened. Picking one
 * shows it, read only; its Unarchive button brings it back.
 */
function Archived({ machines, live }: { machines: MachineEntry[]; live: Session[] }) {
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
                <em className="threads-archived__where">{thread.session?.name ?? thread.cwd.split('/').filter(Boolean).at(-1)}{machine.id !== 'local' ? ` · ${machine.label}` : ''}</em>
              </ListItem>
            ))}
          </List>
        ))}
    </section>
  )
}

/** +: the New thread dialog, in a session's folder on its machine when given one. */
function NewThreadButton({ label, machine, cwd }: { label: string; machine?: MachineEntry; cwd?: string }) {
  const { newThread } = useShell()
  return (
    <IconButton label={label} className="threads__new" disabled={machine && machine.state !== 'connected'}
      onClick={() => newThread({ ...(machine ? { machine: machine.id } : {}), ...(cwd ? { cwd } : {}) })}><PlusIcon size={14} aria-hidden /></IconButton>
  )
}

const SORTS: { value: Sort; label: string }[] = [{ value: 'recent', label: 'Recently active' }, { value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' }]

/** The ··· menu: sort, show as, details. */
function Options() {
  const [sort, setSort] = useAppSetting<Sort>(SORT)
  const [view, setView] = useAppSetting<View>(VIEW)
  const [details, setDetails] = useAppSetting<boolean>(DETAILS)
  const railKeys = useShortcut('threads.rail')
  const detailsKeys = useShortcut('threads.details')
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Sidebar options" className="threads-menu-trigger" />}><DotsThreeIcon size={16} weight="bold" aria-hidden /></Menu.Trigger>
      <Menu.Popup className="threads-menu">
        <Menu.Group>
          <Menu.GroupLabel>Sort</Menu.GroupLabel>
          <Menu.RadioGroup value={sort ?? 'recent'} onValueChange={(value) => void setSort(value as Sort)}>
            {SORTS.map((s) => <Menu.RadioItem key={s.value} value={s.value}>{s.label}</Menu.RadioItem>)}
          </Menu.RadioGroup>
        </Menu.Group>
        <Menu.Separator />
        <Menu.Group>
          <Menu.GroupLabel>Show as</Menu.GroupLabel>
          <Menu.RadioGroup value={view ?? 'list'} onValueChange={(value) => void setView(value as View)}>
            <Menu.RadioItem value="list">List</Menu.RadioItem>
            <Menu.RadioItem value="rail" hint={railKeys}>Rail</Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Group>
        <Menu.Separator />
        <Menu.CheckboxItem checked={details ?? false} onCheckedChange={(checked) => void setDetails(checked)} hint={detailsKeys}>Thread details</Menu.CheckboxItem>
      </Menu.Popup>
    </Menu.Root>
  )
}

/**
 * In the window's rail: Threads, lit while the sidebar shows them. A click folds the list into status dots here (and
 * back); with the sidebar closed, it opens it. Something unread you can't see from here shows as a dot on the button,
 * in the most pressing one's colour.
 */
function ThreadsRail() {
  const [view, setView] = useAppSetting<View>(VIEW)
  const sidebar = useSidebar()
  const { sessions } = useSessions()
  const { selection, select } = useSelection()
  const fold = useFolded(view)
  const folded = sidebar.open && fold.folded
  const toggleKeys = useShortcut('threads.rail')
  const waiting = sessions.flatMap((s) => s.threads.filter((t) => unread(t) && !(s.machine.id === selection?.machine && t.id === selection.thread)).map((t) => t.status))
  const badge = !folded && waiting.length ? rollup(waiting).state : undefined
  const click = () => {
    if (fold.narrow) {
      if (!sidebar.open) sidebar.toggle(true)
      if (view === 'rail') void setView('list')
      unfolded.set(sidebar.open ? folded : true)
    } else if (!sidebar.open) { sidebar.toggle(true); if (view === 'rail') void setView('list') }
    else void setView(folded ? 'list' : 'rail')
  }
  const isOn = (session: Session, thread: ThreadInfo) => selection?.machine === session.machine.id && selection.thread === thread.id
  return (
    <TooltipProvider>
      <Tooltip content={`Threads: ${!sidebar.open ? 'show' : folded ? 'show the list' : 'fold to dots'}${toggleKeys ? ` (${toggleKeys})` : ''}`} side="right">
        <IconButton label="Threads" className={`app__rail-button threads-rail__button ${sidebar.open ? 'is-on' : ''}`} onClick={click}>
          <ChatsIcon size={18} aria-hidden />
          {badge && <span className={`threads-rail__badge threads-rail__badge--${badge}`} />}
        </IconButton>
      </Tooltip>
      {folded && (
        <nav className="threads-rail" aria-label="Threads">
          {sessions.map((session, index) => (
            <div key={session.key} className="threads-rail__group">
              {index > 0 && <div className="threads-rail__sep" />}
              {session.threads.map((thread) => (
                <Tooltip key={thread.id} side="right" content={<>{thread.title}<small className="threads-rail__tipnote">{thread.status.state === 'blocked' ? 'needs you' : ago(activity(thread))}</small></>}>
                  <button className={`threads-rail__dot ${isOn(session, thread) ? 'is-on' : ''} ${session.machine.state !== 'connected' ? 'is-stale' : ''}`}
                    aria-label={`${thread.title}, ${thread.status.state}`} onClick={() => select({ machine: session.machine.id, thread: thread.id })}>
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
function ModelButton({ thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const [on, setOn] = useAppSetting<boolean>(DETAILS)
  const keys = useShortcut('threads.details')
  const model = thread.model?.split('/').at(-1) ?? 'No model'
  return (
    <button type="button" className={`threads-model ${on ? 'is-on' : ''}`} aria-pressed={Boolean(on)}
      title={`${thread.model ?? 'No model'}: ${on ? 'hide' : 'show'} thread details${keys ? ` (${keys})` : ''}`}
      onClick={() => void setOn(!on)}>
      {model}
    </button>
  )
}

/** The details pane: facts about the selected thread, and what its tools did. Nothing while it's turned off. */
function Details({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const [on] = useAppSetting<boolean>(DETAILS)
  if (!on) return null
  return <DetailsPane machine={machine} thread={thread} />
}

type ToolCall = { name: string; arguments?: Record<string, unknown> }

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
    </div>
  )
}
