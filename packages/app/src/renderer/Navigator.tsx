// The navigator (⌘L), after Fut's: every project, its threads, and their panes, as one tree to go anywhere from
// anywhere. Typing searches the whole path ("superego login diff"); without a query the tree is browsable: ← to the parent,
// → to the first child. ⌃P, ⌃T and ⌃G show only projects, threads or panes (again: everything). Enter goes there.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Dialog, StatusGlyph } from '@superego/ui'
import type { Status, ThreadInfo } from '@superego/protocol'
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
  /** Searched: the project, thread and pane titles it sits under. */
  path: string
  /** Where it is: the selected thread's row, or its pane in front. */
  current: boolean
  go(): void
}

const KINDS: Record<string, Kind> = { p: 'project', t: 'thread', g: 'pane' }

export function Navigator({ onClose }: { onClose(): void }) {
  const registry = useRegistry()
  const machines = useMachines()
  const { projects, lastThread } = useProjects()
  const { selection, select } = useSelection()
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState<Kind>()
  const dispatch = registry.router.dispatch

  const rows = useMemo<Row[]>(() => {
    const several = machines.filter((m) => m.state !== 'disabled').length > 1
    const go = (fn: () => void) => () => { onClose(); fn() }
    return projects.flatMap((project: Project): Row[] => {
      const here = project.machine.id === selection?.machine && project.threads.some((t) => t.id === selection.thread)
      return [
        {
          key: project.key, kind: 'project', depth: 0, title: project.name, status: project.status, path: project.name, current: false,
          ...(several || project.machine.id !== 'local' ? { detail: project.machine.label } : {}),
          go: go(() => showProject({ select, lastThread }, project)),
        },
        ...project.threads.flatMap((thread): Row[] => {
          const isOn = here && thread.id === selection?.thread
          const show = () => void dispatch('thread.select', { machine: project.machine.id, thread: thread.id }, { source: 'navigator' })
          return [
            {
              key: `${project.key}/${thread.id}`, kind: 'thread', depth: 1, title: thread.title, status: thread.status,
              // Its branch, when the worktrees extension gave it one of its own.
              ...(branchOf(thread) ? { detail: branchOf(thread) } : {}),
              path: `${project.name} ${thread.title}`, current: isOn && !thread.pane,
              go: go(() => {
                show()
                if (thread.pane) void dispatch('pane.focus', { thread: thread.id }, { machine: project.machine.id, source: 'navigator' })
              }),
            },
            ...shownPanes(registry, { machine: project.machine.id, thread }).map((pane): Row => ({
              key: `${project.key}/${thread.id}/${pane.id}`, kind: 'pane', depth: 2, title: paneTitle(registry, pane, { machine: project.machine.id, thread }),
              path: `${project.name} ${thread.title} ${paneTitle(registry, pane, { machine: project.machine.id, thread })}`, current: isOn && thread.pane === pane.id,
              go: go(() => {
                show()
                void dispatch('pane.focus', { thread: thread.id, pane: pane.id }, { machine: project.machine.id, source: 'navigator' })
                focusColumn(pane.id)
              }),
            })),
          ]
        }),
      ]
    })
  }, [projects, machines, selection?.machine, selection?.thread, lastThread])

  // Searching flattens to the matches, best first; browsing keeps the tree (or one kind of row in it).
  const shown = useMemo(() => {
    const kept = rows.filter((r) => !only || r.kind === only)
    if (!query.trim()) return kept
    return kept.map((row) => ({ row, rank: score(row.path, query) })).filter(({ rank }) => rank > 0).sort((a, b) => b.rank - a.rank).map(({ row }) => row)
  }, [rows, query, only])

  const [active, setActive] = useState(() => Math.max(0, rows.findIndex((r) => r.current)))
  useEffect(() => { setActive(query ? 0 : Math.max(0, shown.findIndex((r) => r.current))) }, [query, only])
  const list = useRef<HTMLUListElement>(null)
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
      <input className="palette__input" autoFocus value={query} onKeyDown={onKeyDown}
        placeholder={only ? `Go to a ${only}` : 'Go to a project, thread or pane'}
        onChange={(e) => setQuery(e.target.value)} />
      <ul className="palette__list" role="listbox" ref={list}>
        {shown.map((row, index) => (
          <li key={row.key} role="option" aria-selected={index === active}
            className={`navigator__row navigator__row--${row.kind} ${index === active ? 'is-active' : ''} ${row.current ? 'is-current' : ''}`}
            style={browsing ? { paddingLeft: `${12 + row.depth * 18}px` } : undefined}
            onMouseMove={() => setActive(index)} onClick={row.go}>
            <span className="palette__glyph">{row.status ? <StatusGlyph status={row.status} /> : '▫'}</span>
            <span className="palette__title">{row.title}</span>
            {!browsing && row.depth > 0 && <span className="navigator__crumb">{row.path.slice(0, row.path.length - row.title.length).trim()}</span>}
            {row.detail && <span className="palette__detail">{row.detail}</span>}
          </li>
        ))}
        {shown.length === 0 && <li className="palette__none">Nothing matches</li>}
      </ul>
      <div className="navigator__keys">↑↓ move · ←→ parent, child · ⌃P ⌃T ⌃G projects, threads, panes · ↩ go</div>
    </Dialog>
  )
}

/** A thread's own branch, as the worktrees extension says (`facts.worktrees`). */
const branchOf = (thread: ThreadInfo) => (thread.facts?.worktrees as { branch?: string } | undefined)?.branch
