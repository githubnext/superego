/// <reference path="./env.d.ts" />
// threads: the thread sidebar. One extension with modes, all kept as app settings:
// - sort: newest first (by machine), recently active (by machine), or needs you first (by status, across machines)
// - show as: a list, or a rail of status glyphs
// - details: a pane beside the thread with what it runs with, spent and touched
// UI only: it uses the core's thread methods and facts.
import { Fragment, useMemo, useRef, useState } from 'react'
import {
  defineAction, type Dispatch, defineUiExtension, useAllThreads, useAppSetting, useMachines, useSelection, useThreadView, useShell, useShortcut,
  type MachineEntry,
} from '@mu/app/ui'
import type { ThreadInfo, Status } from '@mu/protocol'
import { IconButton, List, ListItem, Menu, Panel, StatusGlyph, Tooltip, TooltipProvider } from '@mu/ui'
import './styles.css'
import { activity, ago, groupThreads, type Group, type Row, type Sort } from './groups.ts'

export const SORT = 'threads.sort'
export const VIEW = 'threads.view'
export const DETAILS = 'threads.details'
export type View = 'list' | 'rail'

/** Settings and commands act through the app's settings, so every window and the menu agree. */
let dispatch: Dispatch = () => Promise.reject(new Error('threads is not set up'))
const set = (key: string, value: string | boolean) => dispatch('app.settings.set', { key, value }, { machine: 'app', source: 'threads' })
let current: { sort: Sort; view: View; details: boolean } = { sort: 'created', view: 'list', details: false }

export default defineUiExtension({
  name: 'threads',
  setup(mu) {
    dispatch = mu.dispatch
    mu.appSettings({
      id: 'threads', title: 'Sidebar', order: 55,
      settings: [
        { key: SORT, title: 'Sort threads', default: 'created', type: 'choice', options: [
          { value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' }, { value: 'recent', label: 'Recently active' },
        ] },
        { key: VIEW, title: 'Show as', default: 'list', type: 'choice', options: [{ value: 'list', label: 'List' }, { value: 'rail', label: 'Rail' }] },
        { key: DETAILS, title: 'Thread details', description: 'A pane beside the thread: machine, model, cost, tools, files.', default: false, type: 'boolean' },
      ],
    })
    mu.slot('sidebar', Threads)
    mu.slot('thread.aside', Details)
    const action = (id: string, title: string, run: () => void, keys?: string) =>
      mu.action(defineAction({ id, title, runs: 'window', ...(keys ? { keys } : {}), run }))
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
  current = { sort: sort ?? 'created', view: view ?? 'list', details: details ?? false }
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const threads = useAllThreads()
  const { selection, select } = useSelection()
  const live = useMemo(() => groupThreads(machines, threads, current.sort), [machines, threads, current.sort])

  // While the pointer is over the list, rows keep their places: a thread changing state doesn't move under it.
  const [hovering, setHovering] = useState(false)
  const frozen = useRef(live)
  if (!hovering) frozen.current = live
  const groups = hovering ? freeze(frozen.current, live) : live

  const order = groups.flatMap((g) => g.rows)
  step = (by) => {
    const index = order.findIndex((r) => r.machine.id === selection?.machine && r.thread.id === selection.thread)
    const next = order[(index + by + order.length) % order.length]
    if (next) select({ machine: next.machine.id, thread: next.thread.id })
  }
  const isOn = (r: Row) => selection?.machine === r.machine.id && selection.thread === r.thread.id

  if (current.view === 'rail') return <Rail groups={groups} isOn={isOn} onPick={(r) => select({ machine: r.machine.id, thread: r.thread.id })} />
  return (
    <div className="threads" onPointerEnter={() => setHovering(true)} onPointerLeave={() => setHovering(false)}>
      <div className="threads__head">
        <span>Threads</span>
        <span className="threads__actions">
          {current.sort === 'status' && <NewThread machine={machines.find((m) => m.id === 'local')} />}
          <Options />
        </span>
      </div>
      {groups.map((group) => (
        <Panel key={group.id} className={`threads-group ${group.machine ? 'threads-machine' : ''} ${group.note ? 'is-stale' : ''}`}
          title={<span className="threads-machine__title">{group.title}{group.note ? <em>{group.note}</em> : group.machine ? null : <em>{group.rows.length}</em>}</span>}
          actions={group.machine && <NewThread machine={group.machine} />}>
          <List>
            {group.rows.map((r) => (
              <ListItem key={`${r.machine.id}/${r.thread.id}`} selected={isOn(r)} leading={<StatusGlyph status={r.thread.status} />}
                className={r.machine.state !== 'connected' ? 'is-stale' : ''}
                trailing={!group.machine && machines.length > 1 && r.machine.state !== 'connected' ? r.machine.label : ago(activity(r.thread))}
                onClick={() => select({ machine: r.machine.id, thread: r.thread.id })}>
                {r.thread.title}
              </ListItem>
            ))}
          </List>
        </Panel>
      ))}
    </div>
  )
}

/** The frozen order, with each row's current data; rows that appeared since go at the end of their group. */
function freeze(frozen: Group[], live: Group[]): Group[] {
  const now = new Map(live.flatMap((g) => g.rows).map((r) => [`${r.machine.id}/${r.thread.id}`, r]))
  const seen = new Set<string>()
  const kept = frozen.map((g) => ({ ...g, rows: g.rows.flatMap((r) => {
    const key = `${r.machine.id}/${r.thread.id}`
    const row = now.get(key)
    if (!row) return []
    seen.add(key)
    return [row]
  }) }))
  for (const g of live) {
    const extra = g.rows.filter((r) => !seen.has(`${r.machine.id}/${r.thread.id}`))
    if (!extra.length) continue
    const into = kept.find((k) => k.id === g.id)
    if (into) into.rows.push(...extra)
    else kept.push({ ...g, rows: extra })
  }
  return kept.filter((g) => g.rows.length || g.machine)
}

/** + opens the New thread dialog on this machine. */
function NewThread({ machine }: { machine: MachineEntry | undefined }) {
  const { newThread } = useShell()
  if (!machine) return null
  return <IconButton label={`New thread on ${machine.label}`} disabled={machine.state !== 'connected'} onClick={() => newThread({ machine: machine.id })}>+</IconButton>
}

const SORTS: { value: Sort; label: string }[] = [{ value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' }, { value: 'recent', label: 'Recently active' }]

/** The ··· menu: sort, show as, details. */
function Options() {
  const railKeys = useShortcut('threads.rail')
  const detailsKeys = useShortcut('threads.details')
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Sidebar options" className="threads-menu-trigger" />}>···</Menu.Trigger>
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

/** The sidebar as a column of status glyphs: hover for the title, ⌘\ for the list again. */
function Rail({ groups, isOn, onPick }: { groups: Group[]; isOn(r: Row): boolean; onPick(r: Row): void }) {
  return (
    <TooltipProvider>
      <nav className="threads-rail is-compact" aria-label="Threads">
        <Tooltip content="Show the list (⌘\)">
          <IconButton label="Show the list" className="threads-rail__expand" onClick={() => void set(VIEW, 'list')}>›</IconButton>
        </Tooltip>
        {groups.map((group, index) => (
          <div key={group.id} className="threads-rail__group">
            {index > 0 && <div className="threads-rail__sep" />}
            {group.rows.map((r) => (
              <Tooltip key={`${r.machine.id}/${r.thread.id}`} content={<>{r.thread.title}<small className="threads-rail__tipnote">{r.thread.status.state} · {ago(activity(r.thread))}</small></>}>
                <button className={`threads-rail__dot ${isOn(r) ? 'is-on' : ''} ${r.machine.state !== 'connected' ? 'is-stale' : ''}`}
                  aria-label={`${r.thread.title}, ${r.thread.status.state}`} onClick={() => onPick(r)}>
                  <StatusGlyph status={r.thread.status} />
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
