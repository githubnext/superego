// The navigator (⌘L), after Fut's: every project, its threads, and their panes, as one tree to go anywhere from
// anywhere; pinned threads first, as the sidebar lists them. Typing searches the whole path ("superego login diff"); without a query the tree is browsable: ← to the parent,
// → to the first child. ⌃P, ⌃T and ⌃G show only projects, threads or panes (again: everything). Enter goes there.
// ⌥A adds the archived threads, after the rest (asked of each machine the first time, for as long as it's open); each
// opening starts without them, as getting about is the live work.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArchiveIcon, autoFocusOnOpen, Dialog, PushPinIcon, StatusGlyph } from '@superego/ui'
import { unread, type Status, type ThreadInfo } from '@superego/protocol'
import { score } from './score.ts'
import { useRegistry } from './registry.tsx'
import { paneTitle, shownPanes } from './lookups.ts'
import { useMachines, useSelection, useProjects } from './state.tsx'
import { showProject } from './actions.tsx'
import type { Project } from './projects.ts'
import { focusColumn } from './focus.ts'
import { call } from './client.ts'
import { keyLabel } from './keys.ts'
import type { MachineEntry } from '../shared/bridge.ts'

type Kind = 'project' | 'thread' | 'pane'
type Row = {
  key: string
  kind: Kind
  depth: number
  title: string
  /** What else to show: the machine, a branch, a pane's thread. */
  detail?: string
  status?: Status
  /** A thread that reports to another: its work grey, its finished runs nothing new. */
  quiet?: boolean
  /** A thread that wants a look: its title semibold, as in the sidebar. */
  unread?: boolean
  /** Searched: the project, thread and pane titles it sits under. */
  path: string
  /** Where it is: the selected thread's row, or its pane in front. */
  current: boolean
  /** A pinned thread: listed first, as in the sidebar, and again at its project's top. */
  pinned?: boolean
  /** Its row (or a pane's) under its project, a pinned thread's second: a search lists it once, from the first. */
  again?: boolean
  /** An archived thread: muted, after the rest. */
  archived?: boolean
  /** Browsing, the name over the run of rows it starts: Pinned, Archived. */
  group?: string
  go(): void
}

/** The archived threads, each machine's (or why it couldn't say). */
type Archived = { threads: { machine: MachineEntry; thread: ThreadInfo }[]; failed: { machine: MachineEntry; message: string }[] }

const KINDS: Record<string, Kind> = { p: 'project', t: 'thread', g: 'pane' }
const FILTERS: { kind: Kind; label: string; keys: string }[] = [
  { kind: 'project', label: 'Projects', keys: 'ctrl+p' }, { kind: 'thread', label: 'Threads', keys: 'ctrl+t' }, { kind: 'pane', label: 'Panes', keys: 'ctrl+g' },
]

/** What a key in the navigator's field does to which rows it lists: ⌃P/⌃T/⌃G one kind (again: all), ⌃A all, ⌥A archived too. */
export function navigatorToggle(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>):
  { only: Kind } | 'all' | 'archived' | undefined {
  // By the key's place: ⌥ changes what it types (å).
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyA') return 'archived'
  if (!event.ctrlKey || event.metaKey || event.altKey) return undefined
  if (KINDS[event.key]) return { only: KINDS[event.key]! }
  if (event.key === 'a') return 'all'
  return undefined
}

/** Every connected machine's archived threads, newest first; a machine that fails says so. */
async function listArchived(machines: MachineEntry[]): Promise<Archived> {
  const answers = await Promise.all(machines.filter((m) => m.state === 'connected').map((machine) =>
    call<ThreadInfo[]>(machine.id, 'thread.list', { archived: true }).then(
      (list) => ({ machine, list }),
      (error: unknown) => {
        console.error(`Listing ${machine.label}'s archived threads`, error)
        return { machine, message: error instanceof Error ? error.message : String(error) }
      })))
  return {
    threads: answers.flatMap((a) => 'list' in a ? a.list.map((thread) => ({ machine: a.machine, thread })) : []).sort((a, b) => b.thread.activeAt - a.thread.activeAt),
    failed: answers.flatMap((a) => 'message' in a ? [{ machine: a.machine, message: a.message }] : []),
  }
}

export function Navigator({ onClose }: { onClose(): void }) {
  const registry = useRegistry()
  const machines = useMachines()
  const { sidebar, pins: pinList, lastThread } = useProjects()
  const { selection, select } = useSelection()
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState<Kind>()
  const [withArchived, setWithArchived] = useState(false)
  const [archived, setArchived] = useState<Archived>()
  const dispatch = registry.router.dispatch
  // Asked the first time they're shown, then kept while the navigator's open.
  const asked = useRef(false)
  useEffect(() => {
    if (!withArchived || asked.current) return
    asked.current = true
    void listArchived(machines).then(setArchived)
  }, [withArchived])

  const rows = useMemo<Row[]>(() => {
    const several = machines.filter((m) => m.state !== 'disabled').length > 1
    const where = (project: Project) => several || project.machine.id !== 'local' ? project.machine.label : undefined
    const go = (fn: () => void) => () => { onClose(); fn() }
    const pins = new Set(pinList.map(({ machine, thread }) => `${machine}/${thread}`))
    const listedPinned = new Set(sidebar.pinned.map(({ project, thread }) => `${project.machine.id}/${thread.id}`))
    // A thread, a level under its project (or on its own, among the pinned: `top`), and its panes under it.
    const threadRows = (project: Project, thread: ThreadInfo, top: boolean): Row[] => {
      const pinned = pins.has(`${project.machine.id}/${thread.id}`)
      const depth = top ? 0 : 1
      // Its own keys in each place it's listed; listed again under its project, it's left out of a search.
      const key = `${top ? 'pinned:' : ''}${project.key}/${thread.id}`
      const again = !top && listedPinned.has(`${project.machine.id}/${thread.id}`)
      const isOn = project.machine.id === selection?.machine && thread.id === selection.thread
      const show = () => void dispatch('thread.select', { machine: project.machine.id, thread: thread.id }, { source: 'navigator' })
      const at = { machine: project.machine.id, thread }
      // Pinned: where it is. Else its branch, when the worktrees extension gave it one of its own.
      const detail = top ? [project.name, where(project)].filter(Boolean).join(' · ') : branchOf(thread)
      return [
        {
          key, kind: 'thread', depth, title: thread.title, status: thread.status, quiet: Boolean(thread.quiet), unread: unread(thread), pinned, again,
          ...(detail ? { detail } : {}),
          path: `${project.name} ${thread.title}`, current: isOn && !thread.pane,
          go: go(() => {
            show()
            if (thread.pane) void dispatch('pane.focus', { thread: thread.id }, { machine: project.machine.id, source: 'navigator' })
          }),
        },
        ...shownPanes(registry, at).map((pane): Row => ({
          key: `${key}/${pane.id}`, kind: 'pane', again, depth: depth + 1, title: paneTitle(registry, pane, at),
          path: `${project.name} ${thread.title} ${paneTitle(registry, pane, at)}`, current: isOn && thread.pane === pane.id,
          go: go(() => {
            show()
            void dispatch('pane.focus', { thread: thread.id, pane: pane.id }, { machine: project.machine.id, source: 'navigator' })
            focusColumn(pane.id)
          }),
        })),
      ]
    }
    // As the sidebar lists them: the pinned threads first, then every project with its threads, its pinned at its top.
    const archivedRows = (withArchived ? archived?.threads ?? [] : []).map(({ machine, thread }): Row => ({
      key: `archived:${machine.id}/${thread.id}`, kind: 'thread', depth: 0, title: thread.title, archived: true, group: 'Archived',
      detail: [thread.project.name, several || machine.id !== 'local' ? machine.label : undefined].filter(Boolean).join(' · '),
      path: `${thread.project.name} ${thread.title}`, current: machine.id === selection?.machine && thread.id === selection.thread,
      // As the sidebar's Archived does: shown, read only, to unarchive from its title bar.
      go: go(() => void dispatch('thread.select', { machine: machine.id, thread: thread.id }, { source: 'navigator' })),
    }))
    return [
      ...sidebar.pinned.flatMap(({ project, thread }) => threadRows(project, thread, true).map((row) => ({ ...row, group: 'Pinned' }))),
      ...sidebar.projects.flatMap((project: Project): Row[] => [
        {
          key: project.key, kind: 'project', depth: 0, title: project.name, status: project.status, path: project.name, current: false,
          ...(where(project) ? { detail: where(project) } : {}),
          go: go(() => showProject({ select, lastThread }, project)),
        },
        ...project.threads.flatMap((thread) => threadRows(project, thread, false)),
      ]),
      ...archivedRows,
    ]
  }, [sidebar, pinList, machines, selection?.machine, selection?.thread, lastThread, withArchived, archived])

  // Searching flattens to the matches, best first; browsing keeps the tree (or one kind of row in it).
  const shown = useMemo(() => {
    const kept = rows.filter((r) => !only || r.kind === only)
    if (!query.trim()) return kept
    // The archived after the rest, however well they match.
    return kept.filter((row) => !row.again).map((row) => ({ row, rank: score(row.path, query) })).filter(({ rank }) => rank > 0)
      .sort((a, b) => Number(Boolean(a.row.archived)) - Number(Boolean(b.row.archived)) || b.rank - a.rank).map(({ row }) => row)
  }, [rows, query, only])

  const [active, setActive] = useState(() => Math.max(0, rows.findIndex((r) => r.current)))
  useEffect(() => { setActive(query ? 0 : Math.max(0, shown.findIndex((r) => r.current))) }, [query, only])
  const list = useRef<HTMLUListElement>(null)
  // The box is a combobox and the lit row its active descendant, as in the palette: a screen reader follows along.
  const listId = useId()
  const optionId = (index: number) => `${listId}-${index}`
  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }) }, [active])

  const browsing = !query && !only
  const filterTo = (kind: Kind) => setOnly((was) => was === kind ? undefined : kind)
  const move = (to: number) => setActive(Math.max(0, Math.min(shown.length - 1, to)))
  const onKeyDown = (event: KeyboardEvent) => {
    const row = shown[active]
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
    if (event.key === 'ArrowDown' || (ctrl && event.key === 'j')) { event.preventDefault(); move(active + 1) }
    else if (event.key === 'ArrowUp' || (ctrl && event.key === 'k')) { event.preventDefault(); move(active - 1) }
    else if (event.key === 'PageDown' || (ctrl && event.key === 'd')) { event.preventDefault(); move(active + 10) }
    else if (event.key === 'PageUp' || (ctrl && event.key === 'u')) { event.preventDefault(); move(active - 10) }
    else if (event.key === 'Home' && !query) { event.preventDefault(); move(0) }
    else if (event.key === 'End' && !query) { event.preventDefault(); move(shown.length - 1) }
    else if (navigatorToggle(event)) {
      event.preventDefault()
      const toggle = navigatorToggle(event)!
      if (toggle === 'archived') setWithArchived((was) => !was)
      else if (toggle === 'all') { setOnly(undefined); setQuery('') }
      else filterTo(toggle.only)
    }
    else if (browsing && event.key === 'ArrowLeft' && row) {
      event.preventDefault()
      for (let i = active - 1; i >= 0; i--) if (shown[i]!.depth < row.depth) return move(i)
    } else if (browsing && event.key === 'ArrowRight' && row) {
      event.preventDefault()
      if (shown[active + 1] && shown[active + 1]!.depth > row.depth) move(active + 1)
    } else if (event.key === 'Enter') { event.preventDefault(); row?.go() }
  }

  // A run's name over it: browsing, Pinned and Archived; searching, Archived still, as they come after the rest.
  const heading = (row: Row, index: number): ReactNode => {
    const group = browsing || row.archived ? row.group : undefined
    const before = shown[index - 1]
    return group && (!before || before.group !== row.group) ? <li className="palette__group" role="presentation">{group}</li> : null
  }
  // A filter's chip: clicked, it toggles as its key does, the focus left in the field.
  const chip = (label: string, keys: string, on: boolean, toggle: () => void, icon?: ReactNode) => (
    <button type="button" className={`navigator__chip ${on ? 'is-on' : ''}`} aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()} onClick={toggle}>{icon}{label}<kbd>{keyLabel(keys)}</kbd></button>
  )
  const none = withArchived && !archived ? 'Listing archived threads…' : 'Nothing matches'

  return (
    <Dialog onClose={onClose} size="medium" className="palette navigator" label="Go to">
      <input className="superego-dialog__search palette__input" autoFocus={autoFocusOnOpen()} value={query} onKeyDown={onKeyDown}
        role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={shown[active] ? optionId(active) : undefined}
        placeholder={only ? `Go to a ${only}` : 'Go to a project, thread or pane'}
        onChange={(e) => setQuery(e.target.value)} />
      <ul className="palette__list" role="listbox" id={listId} aria-label="Projects, threads and panes" ref={list}>
        {shown.map((row, index) => (
          <Fragment key={row.key}>
            {heading(row, index)}
            <li id={optionId(index)} role="option" aria-selected={index === active}
              className={`navigator__row navigator__row--${row.kind} ${index === active ? 'is-active' : ''} ${row.current ? 'is-current' : ''} ${row.archived ? 'is-archived' : ''}`}
              style={browsing ? { paddingLeft: `${8 + row.depth * 18}px` } : undefined}
              onMouseMove={() => setActive(index)} onClick={row.go}>
              <span className="palette__glyph">
                {row.archived ? <ArchiveIcon size={13} aria-label="Archived" /> : row.status ? <StatusGlyph status={row.status} quiet={row.quiet} /> : null}
              </span>
              <span className={`palette__title ${row.unread ? 'is-unread' : ''}`}>{row.title}</span>
              {row.pinned && <PushPinIcon className="navigator__pin" size={11} weight="fill" aria-label="Pinned" />}
              {!browsing && row.depth > 0 && <span className="navigator__crumb">{row.path.slice(0, row.path.length - row.title.length).trim()}</span>}
              {row.detail && <span className="palette__detail">{row.detail}</span>}
            </li>
          </Fragment>
        ))}
        {shown.length === 0 && <li className="palette__none" role="presentation">{none}</li>}
        {withArchived && archived?.failed.map(({ machine, message }) => (
          <li key={`failed:${machine.id}`} className="navigator__failed" role="presentation">Couldn’t list {machine.label}’s archived threads: {message}</li>
        ))}
        {withArchived && archived && !archived.threads.length && !archived.failed.length && browsing && shown.length > 0 && <li className="palette__none" role="presentation">Nothing archived</li>}
      </ul>
      <div className="navigator__foot">
        {FILTERS.map(({ kind, label, keys }) => <Fragment key={kind}>{chip(label, keys, only === kind, () => filterTo(kind))}</Fragment>)}
        <span className="navigator__hint">{browsing ? '←→ parent, child' : ''}</span>
        {chip('Archived', 'alt+a', withArchived, () => setWithArchived((was) => !was), <ArchiveIcon size={12} aria-hidden />)}
      </div>
    </Dialog>
  )
}

/** A thread's own branch, as the worktrees extension says (`facts.worktrees`). */
const branchOf = (thread: ThreadInfo) => (thread.facts?.worktrees as { branch?: string } | undefined)?.branch
