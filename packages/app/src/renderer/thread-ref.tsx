// A thread named somewhere else: in a message ([title](thread:<id>)), a tool call, the title bar. It reads as the
// thread's title, kept current (archived too), and opens it: a click shows it, ⌘-click opens it in a pane beside the thread shown;
// or as `open` says, given one (a link handler's, to open it beside the thread the link is in).
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { StatusGlyph } from '@superego/ui'
import { useRegistry } from './extension.tsx'
import { useSelection, useThreads } from './state.tsx'

/**
 * A machine's archived threads, asked once for each list of the threads in use it has (archiving or unarchiving one
 * changes that list): every reference to a thread not in use shares the answer.
 */
const archivedBy = new WeakMap<ThreadInfo[], Promise<ThreadInfo[]>>()
function useArchived(machine: string, id: string, inUse: ThreadInfo[] | undefined, listed: boolean) {
  const [thread, setThread] = useState<ThreadInfo>()
  useEffect(() => {
    if (listed || !inUse) return setThread(undefined)
    let asked = archivedBy.get(inUse)
    if (!asked) archivedBy.set(inUse, asked = (window.superego.call(machine, 'thread.list', { archived: true }) as Promise<ThreadInfo[]>).catch(() => []))
    let alive = true
    void asked.then((all) => { if (alive) setThread(all.find((t) => t.id === id)) })
    return () => { alive = false }
  }, [machine, id, inUse, listed])
  return thread
}

export function ThreadRef({ machine, id, children, className = '', open: follow }: { machine: string; id: string; children?: ReactNode; className?: string; open?: (beside: boolean) => void }) {
  const dispatch = useRegistry().router.dispatch
  const { selection } = useSelection()
  const inUse = useThreads(machine)
  const listed = inUse?.find((t) => t.id === id)
  // One archived since it was named still reads as itself.
  const archived = useArchived(machine, id, inUse, Boolean(listed))
  const thread = listed ?? archived
  const open = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (follow) return follow(event.metaKey || event.ctrlKey)
    const beside = (event.metaKey || event.ctrlKey) && selection && selection.machine === machine && selection.thread !== id
    const done = beside
      ? dispatch('pane.open', { id: selection.thread, kind: 'thread', params: { thread: id } }, { machine, source: 'thread link' })
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
