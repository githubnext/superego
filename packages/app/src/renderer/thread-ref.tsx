// A thread named somewhere else: in a message ([title](thread:<id>)), a tool call, the title bar. It reads as the
// thread's title, kept current, and opens it: a click shows it, ⌘-click opens it in a pane beside the thread shown.
import type { MouseEvent, ReactNode } from 'react'
import { StatusGlyph } from '@superego/ui'
import { useRegistry } from './extension.tsx'
import { useSelection, useThreads } from './state.tsx'

export function ThreadRef({ machine, id, children, className = '' }: { machine: string; id: string; children?: ReactNode; className?: string }) {
  const dispatch = useRegistry().router.dispatch
  const { selection } = useSelection()
  const thread = useThreads(machine)?.find((t) => t.id === id)
  const open = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
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
