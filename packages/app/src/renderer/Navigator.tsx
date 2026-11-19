// The navigator (⌘L), after Fut's: every project, its threads, and their panes, as one tree to go anywhere from
// anywhere; pinned threads first, as the sidebar lists them. Typing searches the whole path ("superego login diff"); without a query the tree is browsable: ← to the parent,
// → to the first child. ⌃P, ⌃T and ⌃G show only projects, threads or panes (again: everything). Enter goes there.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { autoFocusOnOpen, Dialog, PushPinIcon, StatusGlyph } from '@superego/ui'
import { unread, type Status, type ThreadInfo } from '@superego/protocol'
import { score } from './score.ts'
import { useRegistry } from './registry.tsx'
import { paneTitle, shownPanes } from './lookups.ts'
import { useMachines, useSelection, useProjects } from './state.tsx'
import { showProject } from './actions.tsx'
import type { Project } from './projects.ts'
import { focusColumn } from './focus.ts'

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
  go(): void
}

const KINDS: Record<string, Kind> = { p: 'project', t: 'thread', g: 'pane' }

export function Navigator({ onClose }: { onClose(): void }) {
  const registry = useRegistry()
  const machines = useMachines()
  const { sidebar, pins: pinList, lastThread } = useProjects()
  const { selection, select } = useSelection()
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState<Kind>()
  const dispatch = registry.router.dispatch

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
    return [
      ...sidebar.pinned.flatMap(({ project, thread }) => threadRows(project, thread, true)),
      ...sidebar.projects.flatMap((project: Project): Row[] => [
        {
          key: project.key, kind: 'project', depth: 0, title: project.name, status: project.status, path: project.name, current: false,
          ...(where(project) ? { detail: where(project) } : {}),
          go: go(() => showProject({ select, lastThread }, project)),
        },
        ...project.threads.flatMap((thread) => threadRows(project, thread, false)),
      ]),
    ]
  }, [sidebar, pinList, machines, selection?.machine, selection?.thread, lastThread])

  // Searching flattens to the matches, best first; browsing keeps the tree (or one kind of row in it).
  const shown = useMemo(() => {
    const kept = rows.filter((r) => !only || r.kind === only)
    if (!query.trim()) return kept
    return kept.filter((row) => !row.again).map((row) => ({ row, rank: score(row.path, query) })).filter(({ rank }) => rank > 0).sort((a, b) => b.rank - a.rank).map(({ row }) => row)
  }, [rows, query, only])

  const [active, setActive] = useState(() => Math.max(0, rows.findIndex((r) => r.current)))
  useEffect(() => { setActive(query ? 0 : Math.max(0, shown.findIndex((r) => r.current))) }, [query, only])
  const list = useRef<HTMLUListElement>(null)
  // The box is a combobox and the lit row its active descendant, as in the palette: a screen reader follows along.
  const listId = useId()
  const optionId = (index: number) => `${listId}-${index}`
  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }) }, [active])

  const browsing = !query && !only
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
    else if (ctrl && KINDS[event.key]) { event.preventDefault(); setOnly((was) => was === KINDS[event.key] ? undefined : KINDS[event.key]) }
    else if (ctrl && event.key === 'a') { event.preventDefault(); setOnly(undefined); setQuery('') }
    else if (browsing && event.key === 'ArrowLeft' && row) {
      event.preventDefault()
      for (let i = active - 1; i >= 0; i--) if (shown[i]!.depth < row.depth) return move(i)
    } else if (browsing && event.key === 'ArrowRight' && row) {
      event.preventDefault()
      if (shown[active + 1] && shown[active + 1]!.depth > row.depth) move(active + 1)
    } else if (event.key === 'Enter') { event.preventDefault(); row?.go() }
  }

  return (
    <Dialog onClose={onClose} size="medium" className="palette navigator" label="Go to">
      <input className="palette__input" autoFocus={autoFocusOnOpen()} value={query} onKeyDown={onKeyDown}
        role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={shown[active] ? optionId(active) : undefined}
        placeholder={only ? `Go to a ${only}` : 'Go to a project, thread or pane'}
        onChange={(e) => setQuery(e.target.value)} />
      <ul className="palette__list" role="listbox" id={listId} aria-label="Projects, threads and panes" ref={list}>
        {shown.map((row, index) => (
          <li key={row.key} id={optionId(index)} role="option" aria-selected={index === active}
            className={`navigator__row navigator__row--${row.kind} ${index === active ? 'is-active' : ''} ${row.current ? 'is-current' : ''}`}
            style={browsing ? { paddingLeft: `${12 + row.depth * 18}px` } : undefined}
            onMouseMove={() => setActive(index)} onClick={row.go}>
            <span className="palette__glyph">{row.status ? <StatusGlyph status={row.status} quiet={row.quiet} /> : '▫'}</span>
            <span className={`palette__title ${row.unread ? 'is-unread' : ''}`}>{row.title}</span>
            {row.pinned && <PushPinIcon className="navigator__pin" size={11} weight="fill" aria-label="Pinned" />}
            {!browsing && row.depth > 0 && <span className="navigator__crumb">{row.path.slice(0, row.path.length - row.title.length).trim()}</span>}
            {row.detail && <span className="palette__detail">{row.detail}</span>}
          </li>
        ))}
        {shown.length === 0 && <li className="palette__none" role="presentation">Nothing matches</li>}
      </ul>
      <div className="navigator__keys">↑↓ move · ←→ parent, child · ⌃P ⌃T ⌃G projects, threads, panes · ↩ go</div>
    </Dialog>
  )
}

/** A thread's own branch, as the worktrees extension says (`facts.worktrees`). */
const branchOf = (thread: ThreadInfo) => (thread.facts?.worktrees as { branch?: string } | undefined)?.branch
