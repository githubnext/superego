/// <reference path="./env.d.ts" />
// threads: the sidebar. Sessions (a project on a machine) and the threads in each; the machine is said on the session,
// where it isn't this computer. One extension with modes, all kept as app settings:
// - sort: recently active, newest first, or needs you first: sessions, and the threads in each
// - show as: a list, or a rail of status glyphs
// - details: a pane beside the thread with what it runs with, spent and touched
// UI only: it uses the core's thread methods and facts.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  call, defineAction, type Dispatch, defineUiExtension, showSession, SORT, useAppSetting, useLocalState, useMachines, useSelection, useSessions, useThreadView, useShell, useShortcut,
  type MachineEntry, type Session, type Sort,
} from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { CaretRightIcon, DotsThreeIcon, IconButton, List, ListItem, Menu, PlusIcon, StatusGlyph, Tooltip, TooltipProvider } from '@superego/ui'
import './styles.css'
import { activity, ago, freeze } from './groups.ts'

export const VIEW = 'threads.view'
export const DETAILS = 'threads.details'
export type View = 'list' | 'rail'

/** Settings and commands act through the app's settings, so every window and the menu agree. */
let dispatch: Dispatch = () => Promise.reject(new Error('threads is not set up'))
const set = (key: string, value: string | boolean) => dispatch('app.settings.set', { key, value }, { machine: 'app', source: 'threads' })
let current: { sort: Sort; view: View; details: boolean } = { sort: 'recent', view: 'list', details: false }

export default defineUiExtension({
  name: 'threads',
  setup(superego) {
    dispatch = superego.dispatch
    superego.appSettings({
      id: 'threads', title: 'Sidebar', order: 55,
      settings: [
        { key: SORT, title: 'Sort sessions and threads', default: 'recent', type: 'choice', options: [
          { value: 'recent', label: 'Recently active' }, { value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' },
        ] },
        { key: VIEW, title: 'Show as', default: 'list', type: 'choice', options: [{ value: 'list', label: 'List' }, { value: 'rail', label: 'Rail' }] },
        { key: DETAILS, title: 'Thread details', description: 'A pane beside the thread: machine, model, cost, tools, files.', default: false, type: 'boolean' },
      ],
    })
    superego.slot('sidebar', Threads)
    superego.slot('thread.aside', Details)
    const action = (id: string, title: string, run: () => void, keys?: string) =>
      superego.action(defineAction({ id, title, runs: 'window', ...(keys ? { keys } : {}), run }))
    action('threads.rail', 'Toggle sidebar rail', () => void set(VIEW, current.view === 'rail' ? 'list' : 'rail'), 'mod+\\')
    action('threads.details', 'Toggle thread details', () => void set(DETAILS, !current.details), 'mod+i')
    action('threads.sort.created', 'Sort threads: newest first', () => void set(SORT, 'created'))
    action('threads.sort.status', 'Sort threads: needs you first', () => void set(SORT, 'status'))
    action('threads.sort.recent', 'Sort threads: recently active', () => void set(SORT, 'recent'))
    action('threads.next', 'Next thread', () => step(1), 'mod+alt+arrowdown')
    action('threads.previous', 'Previous thread', () => step(-1), 'mod+alt+arrowup')
  },
})

/** Moving between threads from a command: set by the mounted sidebar, which knows the order shown. */
let step: (by: number) => void = () => {}

function Threads() {
  const [sort] = useAppSetting<Sort>(SORT)
  const [view] = useAppSetting<View>(VIEW)
  const [details] = useAppSetting<boolean>(DETAILS)
  current = { sort: sort ?? 'recent', view: view ?? 'list', details: details ?? false }
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const { sessions: live, lastThread } = useSessions()
  const { selection, select } = useSelection()

  // While the pointer is over the list, rows keep their places: a thread changing state doesn't move under it.
  const [hovering, setHovering] = useState(false)
  const frozen = useRef(live)
  if (!hovering) frozen.current = live
  const sessions = hovering ? freeze(frozen.current, live) : live

  const order = sessions.flatMap((s) => s.threads.map((thread) => ({ machine: s.machine, thread })))
  step = (by) => {
    const index = order.findIndex((r) => r.machine.id === selection?.machine && r.thread.id === selection.thread)
    const next = order[(index + by + order.length) % order.length]
    if (next) select({ machine: next.machine.id, thread: next.thread.id })
  }
  const isOn = (session: Session, thread: ThreadInfo) => selection?.machine === session.machine.id && selection.thread === thread.id
  // The machine is a fact about a session, said where it isn't this computer (or there are several to tell apart).
  const several = machines.length > 1
  const where = (session: Session) => session.machine.state !== 'connected'
    ? `${session.machine.label} · ${session.machine.state === 'connecting' ? 'connecting' : 'offline'}`
    : several || session.machine.id !== 'local' ? session.machine.label : undefined
  const local = machines.find((m) => m.id === 'local')
  const ready = local?.state === 'connected'

  if (current.view === 'rail') return <Rail sessions={sessions} isOn={isOn} onPick={(s, t) => select({ machine: s.machine.id, thread: t.id })} ready={ready} />
  return (
    <div className={`threads ${ready ? 'is-ready' : ''}`} data-focus-scope onPointerEnter={() => setHovering(true)} onPointerLeave={() => setHovering(false)}>
      <div className="threads__head">
        <span>Sessions</span>
        <span className="threads__actions">
          <NewThreadButton label="New thread…" />
          <Options />
        </span>
      </div>
      {sessions.length === 0 && <div className="threads__empty">{ready ? 'Start a thread in a project folder: it becomes a session here.' : 'Connecting…'}</div>}
      {sessions.map((session) => (
        <section key={session.key} className={`threads-session ${session.machine.state !== 'connected' ? 'is-stale' : ''}`}>
          <div className="threads-session__head">
            <button className="threads-session__name" title={session.root} onClick={() => showSession({ select, lastThread }, session)}>
              {session.name}
              {where(session) && <em>{where(session)}</em>}
            </button>
            <NewThreadButton label={`New thread in ${session.name}`} machine={session.machine} cwd={session.root} />
          </div>
          <List>
            {session.threads.map((thread) => (
              <ListItem key={thread.id} selected={isOn(session, thread)} leading={<StatusGlyph status={thread.status} />}
                trailing={ago(activity(thread))} onClick={() => select({ machine: session.machine.id, thread: thread.id })}>
                {thread.title}
              </ListItem>
            ))}
          </List>
        </section>
      ))}
      <Archived machines={machines} live={live} />
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
  const railKeys = useShortcut('threads.rail')
  const detailsKeys = useShortcut('threads.details')
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Sidebar options" className="threads-menu-trigger" />}><DotsThreeIcon size={16} weight="bold" aria-hidden /></Menu.Trigger>
      <Menu.Popup className="threads-menu">
        <Menu.Group>
          <Menu.GroupLabel>Sort</Menu.GroupLabel>
          <Menu.RadioGroup value={current.sort} onValueChange={(value) => void set(SORT, value as string)}>
            {SORTS.map((s) => <Menu.RadioItem key={s.value} value={s.value}>{s.label}</Menu.RadioItem>)}
          </Menu.RadioGroup>
        </Menu.Group>
        <Menu.Separator />
        <Menu.Group>
          <Menu.GroupLabel>Show as</Menu.GroupLabel>
          <Menu.RadioGroup value={current.view} onValueChange={(value) => void set(VIEW, value as string)}>
            <Menu.RadioItem value="list">List</Menu.RadioItem>
            <Menu.RadioItem value="rail" hint={railKeys}>Rail</Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Group>
        <Menu.Separator />
        <Menu.CheckboxItem checked={current.details} onCheckedChange={(checked) => void set(DETAILS, checked)} hint={detailsKeys}>Thread details</Menu.CheckboxItem>
      </Menu.Popup>
    </Menu.Root>
  )
}

/** The sidebar as a column of status glyphs, a gap between sessions: hover for the title, ⌘\ for the list again. */
function Rail({ sessions, isOn, onPick, ready }: { sessions: Session[]; isOn(s: Session, t: ThreadInfo): boolean; onPick(s: Session, t: ThreadInfo): void; ready: boolean }) {
  return (
    <TooltipProvider>
      <nav className={`threads-rail is-compact ${ready ? 'is-ready' : ''}`} aria-label="Threads">
        <Tooltip content="Show the list (⌘\)">
          <IconButton label="Show the list" className="threads-rail__expand" onClick={() => void set(VIEW, 'list')}><CaretRightIcon size={14} aria-hidden /></IconButton>
        </Tooltip>
        {sessions.map((session, index) => (
          <div key={session.key} className="threads-rail__group">
            {index > 0 && <div className="threads-rail__sep" />}
            {session.threads.map((thread) => (
              <Tooltip key={thread.id} content={<>{session.name} · {thread.title}<small className="threads-rail__tipnote">{thread.status.state} · {ago(activity(thread))}</small></>}>
                <button className={`threads-rail__dot ${isOn(session, thread) ? 'is-on' : ''} ${session.machine.state !== 'connected' ? 'is-stale' : ''}`}
                  aria-label={`${thread.title}, ${thread.status.state}`} onClick={() => onPick(session, thread)}>
                  <StatusGlyph status={thread.status} />
                </button>
              </Tooltip>
            ))}
          </div>
        ))}
      </nav>
    </TooltipProvider>
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
