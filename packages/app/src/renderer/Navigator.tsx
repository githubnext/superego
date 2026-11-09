// The navigator (⌘L), after Fut's: every session, its threads, and their panes, as one tree to go anywhere from
// anywhere. Typing searches the whole path ("mu login diff"); without a query the tree is browsable: ← to the parent,
// → to the first child. ⌃S, ⌃T and ⌃P show only sessions, threads or panes (again: everything). Enter goes there.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Dialog, StatusGlyph } from '@mu/ui'
import type { Pane, Status, ThreadInfo } from '@mu/protocol'
import { score } from './score.ts'
import { paneKind, useRegistry } from './extension.tsx'
import { useMachines, useSelection, useSessions } from './state.tsx'
import { showSession } from './actions.tsx'
import type { Session } from './sessions.ts'
import { focusColumn } from './focus.ts'

type Kind = 'session' | 'thread' | 'pane'
type Row = {
  key: string
  kind: Kind
  depth: number
  title: string
  /** What else to show: the machine, a branch, a pane's thread. */
  detail?: string
  status?: Status
  /** Searched: the session, thread and pane titles it sits under. */
  path: string
  /** Where it is: the selected thread's row, or its pane in front. */
  current: boolean
  go(): void
}

const KINDS: Record<string, Kind> = { s: 'session', t: 'thread', p: 'pane' }

export function Navigator({ onClose }: { onClose(): void }) {
  const registry = useRegistry()
  const machines = useMachines()
  const { sessions, lastThread } = useSessions()
  const { selection, select } = useSelection()
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState<Kind>()
  const dispatch = registry.router.dispatch

  const rows = useMemo<Row[]>(() => {
    const several = machines.filter((m) => m.state !== 'disabled').length > 1
    const paneTitle = (thread: ThreadInfo, pane: Pane) => {
      const named = paneKind(registry, pane.kind, thread)?.title
      return pane.title ?? (typeof named === 'function' ? named(pane) : named) ?? pane.kind
    }
    const go = (fn: () => void) => () => { onClose(); fn() }
    return sessions.flatMap((session: Session): Row[] => {
      const here = session.machine.id === selection?.machine && session.threads.some((t) => t.id === selection.thread)
      return [
        {
          key: session.key, kind: 'session', depth: 0, title: session.name, status: session.status, path: session.name, current: false,
          ...(several || session.machine.id !== 'local' ? { detail: session.machine.label } : {}),
          go: go(() => showSession({ select, lastThread }, session)),
        },
        ...session.threads.flatMap((thread): Row[] => {
          const isOn = here && thread.id === selection?.thread
          const show = () => void dispatch('thread.select', { machine: session.machine.id, thread: thread.id }, { source: 'navigator' })
          return [
            {
              key: `${session.key}/${thread.id}`, kind: 'thread', depth: 1, title: thread.title, status: thread.status,
              ...(thread.worktree ? { detail: thread.worktree.branch } : {}),
              path: `${session.name} ${thread.title}`, current: isOn && !thread.pane,
              go: go(() => {
                show()
                if (thread.pane) void dispatch('pane.focus', { id: thread.id }, { machine: session.machine.id, source: 'navigator' })
              }),
            },
            ...(thread.panes ?? []).map((pane): Row => ({
              key: `${session.key}/${thread.id}/${pane.id}`, kind: 'pane', depth: 2, title: paneTitle(thread, pane),
              path: `${session.name} ${thread.title} ${paneTitle(thread, pane)}`, current: isOn && thread.pane === pane.id,
              go: go(() => {
                show()
                void dispatch('pane.focus', { id: thread.id, pane: pane.id }, { machine: session.machine.id, source: 'navigator' })
                focusColumn(pane.id)
              }),
            })),
          ]
        }),
      ]
    })
  }, [sessions, machines, selection?.machine, selection?.thread, lastThread])

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
        placeholder={only ? `Go to a ${only}` : 'Go to a session, thread or pane'}
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
      <div className="navigator__keys">↑↓ move · ←→ parent, child · ⌃S ⌃T ⌃P sessions, threads, panes · ↩ go</div>
    </Dialog>
  )
}
