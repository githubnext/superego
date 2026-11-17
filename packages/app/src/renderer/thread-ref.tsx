// A thread named somewhere else: in a message ([title](thread:<id>)), a tool call, the title bar. It reads as the
// thread's title, kept current (archived or hidden too: Ego's, as its threads' parent), and opens it: a click shows it, ⌘-click opens it in a pane beside the thread shown;
// or as `open` says, given one (a link handler's, to open it beside the thread the link is in).
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { StatusGlyph } from '@superego/ui'
import { useRegistry } from './registry.tsx'
import { useHidden, useSelection, useThreads } from './state.tsx'

/**
 * A machine's archived threads, asked once for each set of threads it has in use (archiving or unarchiving one changes
 * that set; a status or title changing doesn't): every reference to a thread not in use shares the answer.
 */
const archivedBy = new Map<string, { ids: string; asked: Promise<ThreadInfo[]> }>()
function useArchived(machine: string, id: string, inUse: ThreadInfo[] | undefined, listed: boolean) {
  const [thread, setThread] = useState<ThreadInfo>()
  const ids = inUse?.map((t) => t.id).sort().join(' ')
  useEffect(() => {
    if (listed || ids === undefined) return setThread(undefined)
    let known = archivedBy.get(machine)
    if (known?.ids !== ids) {
      archivedBy.set(machine, known = { ids, asked: (window.superego.call(machine, 'thread.list', { archived: true }) as Promise<ThreadInfo[]>).catch(() => []) })
    }
    let alive = true
    void known.asked.then((all) => { if (alive) setThread(all.find((t) => t.id === id)) })
    return () => { alive = false }
  }, [machine, id, ids, listed])
  return thread
}

/**
 * A link to a thread on `machine`, by id: its title (or `children`) and status, opening it when followed (`open`:
 * instead, `beside` with ⌘).
 */
export function ThreadRef({ machine, id, children, className = '', open: follow }: { machine: string; id: string; children?: ReactNode; className?: string; open?: (beside: boolean) => void }) {
  const dispatch = useRegistry().router.dispatch
  const { selection } = useSelection()
  const inUse = useThreads(machine)
  const hidden = useHidden(machine)
  const listed = inUse?.find((t) => t.id === id) ?? hidden?.find((t) => t.id === id)
  // One archived since it was named still reads as itself.
  const archived = useArchived(machine, id, inUse, Boolean(listed))
  const thread = listed ?? archived
  const open = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (follow) return follow(event.metaKey || event.ctrlKey)
    const beside = (event.metaKey || event.ctrlKey) && selection && selection.machine === machine && selection.thread !== id
    const done = beside
      ? dispatch('pane.open', { thread: selection.thread, kind: 'thread', params: { thread: id } }, { machine, source: 'thread link' })
      : dispatch('thread.select', { machine, thread: id }, { source: 'thread link' })
    void done.catch((error) => console.error(error))
  }
  return (
    <a href={`thread:${id}`} className={`thread-ref ${className}`} title={thread ? `${thread.title} (⌘-click: beside)` : `Thread ${id}`} onClick={open}>
      {thread && <StatusGlyph status={thread.status} />}
      <span className="thread-ref__title">{thread?.title ?? children ?? `Thread ${id}`}</span>
    </a>
  )
}
