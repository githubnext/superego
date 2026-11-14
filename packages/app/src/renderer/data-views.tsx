// Data views: views a machine's daemon extensions declare as data (`superego.view` there), drawn here with the core's
// own components. Their content (`ViewContent`: a note, facts, a list, a table, Markdown, buttons) comes from a live
// value or a method of the extension's; a button runs one of the extension's own actions, there, as the window may.
// Nothing of the extension's runs in the window, so a remote machine's, or a project profile's, needs no consent to run
// code here; its buttons still have that machine's authority. What a machine sends is checked as it lands
// (data-view-check.ts), and a view that fails to draw says so in its place, not in the shell's. The registry makes each
// a view (see `setDataViews`), and the layout places it as any other.
import { Component, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import type { DataIcon, DataViewInfo, Json, Status, ThreadInfo, ViewAction } from '@superego/protocol'
import {
  ArchiveIcon, BellIcon, Button, ChatsIcon, CheckIcon, ColumnsIcon, FileTextIcon, FolderSimpleIcon, GearSixIcon, GlobeIcon, IconButton, ListIcon, Panel,
  SparkleIcon, StatusGlyph, TableIcon, TerminalIcon, WrenchIcon,
} from '@superego/ui'
import type { MachineEntry } from '../shared.ts'
import { call, useValue } from './client.ts'
import { checkContent, warnDropped } from './data-view-check.ts'
import { useRegistry, type Registry } from './extension.tsx'
import type { Place } from './layout.ts'
import { Markdown } from './Markdown.tsx'
import { useAllThreads, useMachines } from './state.tsx'
import { ThreadRef } from './thread-ref.tsx'

type IconComponent = ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
const ICONS: Record<DataIcon, IconComponent> = {
  list: ListIcon, table: TableIcon, folder: FolderSimpleIcon, file: FileTextIcon, bell: BellIcon, check: CheckIcon, gear: GearSixIcon,
  globe: GlobeIcon, sparkle: SparkleIcon, terminal: TerminalIcon, wrench: WrenchIcon, chats: ChatsIcon, archive: ArchiveIcon, columns: ColumnsIcon,
}
/** The glyph a data view names, if it names one there is. */
export const dataIcon = (name: DataIcon | undefined): IconComponent | undefined => name ? ICONS[name] : undefined

/** The declaration of `id` on `machine` that `thread` sees: its profile's own first, else the machine's. */
function declaredOn(registry: Registry, machine: string, id: string, thread?: ThreadInfo): DataViewInfo | undefined {
  const all = (registry.dataViews[machine] ?? []).filter((v) => v.id === id)
  const dir = thread?.profile?.dir
  return all.find((v) => dir && v.profiles?.includes(dir)) ?? all.find((v) => !v.profiles)
}

/**
 * A data view in a place: a thread's, from its machine; the window's, from every machine that has it (each under its
 * name, when there are several).
 */
export function DataViewBody(props: { id: string; place: Place; machine?: MachineEntry; thread?: ThreadInfo }) {
  return <DataViewBoundary id={props.id} place={props.place}><DataViewInner {...props} /></DataViewBoundary>
}

/**
 * A data view that threw as it drew: a quiet word in its place, and Try again; the shell around it goes on. (5A's
 * shared view boundary, once it lands, can take this one's place.)
 */
export class DataViewBoundary extends Component<{ id: string; place: Place; children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) { return { error } }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error(`Data view ${this.props.id} failed to draw`, error, info.componentStack) }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className={`data-view data-view--${this.props.place}`}>
        <div className="data-view__dropped" title={this.state.error.message}>
          {this.props.id} couldn’t be drawn. <button type="button" className="data-view__retry" onClick={() => this.setState({ error: undefined })}>Try again</button>
        </div>
      </div>
    )
  }
}

function DataViewInner({ id, place, machine, thread }: { id: string; place: Place; machine?: MachineEntry; thread?: ThreadInfo }) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const machines = useMachines()
  const view = registry.views.find((v) => v.id === id && v.owner.data)
  // A space is a panel under its title, as the sidebar's are; beside the thread, a heading; a pane's tab says it already.
  const framed = (title: string, children: ReactNode) => place === 'space'
    ? <Panel title={title} className="data-view data-view--space">{children}</Panel>
    : <div className={`data-view data-view--${place}`}>{place === 'aside' && <h5 className="data-view__heading">{title}</h5>}{children}</div>
  if (machine && thread) {
    const info = declaredOn(registry, machine.id, id, thread)
    return info ? framed(info.title, <Source info={info} machine={machine} thread={thread} />) : null
  }
  // A machine away says so, under its name; one switched off isn't there.
  const on = machines.filter((m) => m.state !== 'disabled' && declaredOn(registry, m.id, id))
  return framed(view?.title ?? id, on.map((m) => (
    <section key={m.id} className="data-view__machine">
      {on.length > 1 && <h6 className="data-view__machine-name">{m.label}</h6>}
      <Source info={declaredOn(registry, m.id, id)!} machine={m} />
    </section>
  )))
}

function Source({ info, machine, thread }: { info: DataViewInfo; machine: MachineEntry; thread?: ThreadInfo }) {
  if (machine.state === 'disconnected') return <div className="data-view__empty">{machine.label} is offline.</div>
  return info.value
    ? <FromValue info={info} value={info.value} machine={machine} thread={thread} />
    : <FromMethod info={info} method={info.method!} machine={machine} thread={thread} />
}

/** Fed by a live value: a thread view's holds each thread's content by its id. */
function FromValue({ info, value, machine, thread }: { info: DataViewInfo; value: string; machine: MachineEntry; thread?: ThreadInfo }) {
  // Undefined until it's heard; null when it's never been set, and a thread view's with nothing for this thread: none.
  const live = useValue<Json>(machine.id, machine.state === 'connected', value)
  const content = info.context === 'thread' ? (thread && live && typeof live === 'object' && !Array.isArray(live) ? live[thread.id] ?? null : live === undefined ? undefined : null) : live
  return <DataContent content={content} extension={info.extension} machine={machine} />
}

/** Fed by a method: read again as the thread moves on (a window view: any thread on the machine), and after a button ran. */
function FromMethod({ info, method, machine, thread }: { info: DataViewInfo; method: string; machine: MachineEntry; thread?: ThreadInfo }) {
  const connected = machine.state === 'connected'
  const threads = useAllThreads()[machine.id]
  const moved = info.context === 'thread' ? `${thread?.id}:${thread?.activeAt}:${thread?.status.state}` : (threads ?? []).map((t) => `${t.id}:${t.activeAt}:${t.status.state}`).join()
  const [read, setRead] = useState<{ content?: Json; error?: string }>({})
  // Answered, it's read: null (or nothing) is none.
  const [again, setAgain] = useState(0)
  useEffect(() => {
    if (!connected) return
    let live = true
    call<Json>(machine.id, method, info.context === 'thread' ? { id: thread?.id } : {})
      .then((content) => { if (live) setRead({ content: content ?? null }) }, (error: Error) => { if (live) setRead((r) => ({ ...r, error: error.message })) })
    return () => { live = false }
  }, [machine.id, connected, method, moved, again])
  return <DataContent content={read.content} error={read.error} extension={info.extension} machine={machine} ran={() => setAgain((n) => n + 1)} />
}

/**
 * `extension`'s content, drawn top to bottom: its note, facts, list, table, Markdown and buttons; what it says when
 * there's none. `content` undefined: not read yet.
 */
export function DataContent({ content: raw, error, extension, machine, ran }: { content: unknown; error?: string | undefined; extension: string; machine: MachineEntry; ran?: () => void }) {
  const { content, dropped } = useMemo(() => checkContent(raw, extension), [raw, extension])
  useEffect(() => { warnDropped(machine.id, extension, dropped) }, [dropped])
  const registry = useRegistry()
  const [failed, setFailed] = useState<string>()
  const run = (action: ViewAction) => {
    setFailed(undefined)
    void runViewAction(registry, machine.id, extension, action).then(() => ran?.(), (e: Error) => setFailed(e.message))
  }
  const c = content ?? {}
  const nothing = !c.note && !c.facts?.length && !c.items?.length && !c.table?.rows.length && !c.markdown && !c.actions?.length
  const problem = failed ?? error
  return (
    <>
      {problem && <div className="data-view__error">{problem}</div>}
      {dropped.length > 0 && <div className="data-view__dropped" title={dropped.join('\n')}>Left out some of what {machine.label} sent that this view can’t show.</div>}
      {nothing && !(raw === undefined && error) && <div className="data-view__empty">{raw === undefined ? 'Loading…' : c.empty ?? 'Nothing here yet.'}</div>}
      {c.note && <div className="data-view__note">{c.note}</div>}
      {!!c.facts?.length && <dl className="data-view__facts">{c.facts.map((f, i) => <div key={i}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>}
      {!!c.items?.length && (
        <ul className="data-view__items">
          {c.items.map((item, i) => (
            <li key={item.id ?? i} className="data-view__item">
              <div className="data-view__line">
                {item.status && !item.thread && <StatusGlyph status={{ state: item.status } as Status} />}
                {item.thread ? <ThreadRef machine={machine.id} id={item.thread} className="data-view__title">{item.title}</ThreadRef> : <span className="data-view__title">{item.title}</span>}
                {item.detail && <span className="data-view__detail">{item.detail}</span>}
                {item.actions?.map((action, j) => <ActionButton key={j} action={action} run={run} small />)}
              </div>
              {item.subtitle && <div className="data-view__subtitle">{item.subtitle}</div>}
            </li>
          ))}
        </ul>
      )}
      {c.table && c.table.rows.length > 0 && (
        <div className="data-view__table-wrap">
          <table className="data-view__table">
            <thead><tr>{c.table.columns.map((col, i) => <th key={i}>{col}</th>)}</tr></thead>
            <tbody>{c.table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell ?? ''}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {c.markdown && <div className="data-view__markdown"><Markdown text={c.markdown} /></div>}
      {!!c.actions?.length && <div className="data-view__actions">{c.actions.map((action, i) => <ActionButton key={i} action={action} run={run} />)}</div>}
    </>
  )
}

/**
 * A button of `extension`'s data view on `machine`, pressed: the extension's action it names, run there (never one of
 * the window's, another extension's, or another machine's), as the window may run it (exposed to the UI), logged as
 * this window's are.
 */
export function runViewAction(registry: Pick<Registry, 'router'>, machine: string, extension: string, action: ViewAction): Promise<unknown> {
  if (!action.action.startsWith(`${extension}.`)) return Promise.reject(new Error(`${action.action} isn’t one of ${extension}’s actions`))
  const params = action.params ?? {}
  return registry.router.router.track(action.action, params, `view → ${machine}`, () => call(machine, 'action.run', { id: action.action, params, exposure: 'ui' }))
}

function ActionButton({ action, run, small = false }: { action: ViewAction; run(action: ViewAction): void; small?: boolean }) {
  const Icon = dataIcon(action.icon)
  if (small && Icon) return <IconButton label={action.title} className="data-view__icon-button" onClick={() => run(action)}><Icon size={14} aria-hidden /></IconButton>
  return <Button variant={small ? 'ghost' : 'default'} className="data-view__button" onClick={() => run(action)}>{Icon && <Icon size={14} aria-hidden />}{action.title}</Button>
}
