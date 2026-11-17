// Where ⌘. goes: the next thread in the unread list (the window's `unreadList`, the one rule), in the sidebar's order;
// and what ⌘U's list of them shows and matches.
import { score, unreadList, type Selection, type Project } from '@superego/app/ui'
import type { Scope } from './shared.ts'

/**
 * The next unread thread after the one shown, in the sidebar's order (in its project only, for `project`), around to
 * the start; never the one shown.
 */
export function nextUnread(projects: Project[], selection: Selection | undefined, scope: Scope): Selection | undefined {
  const project = projects.find((s) => s.machine.id === selection?.machine && s.threads.some((t) => t.id === selection?.thread))
  const key = (machine: string, thread: string) => `${machine}/${thread}`
  const unread = new Set(unreadList(projects, selection).map(({ machine, thread }) => key(machine, thread.id)))
  const order: Selection[] = (scope === 'project' && project ? [project] : projects).flatMap((s) => s.threads.map((thread) => ({ machine: s.machine.id, thread: thread.id })))
  const at = order.findIndex((o) => o.machine === selection?.machine && o.thread === selection.thread)
  for (let step = 1; step <= order.length; step++) {
    const next = order[(at + step + order.length) % order.length]!
    if (unread.has(key(next.machine, next.thread))) return next
  }
  return undefined
}

/** One row of the unread list: a thread, its machine and its project. */
export type Unread = ReturnType<typeof unreadList>[number]

/** The unread threads that match what's typed (in the title, project, machine or status message), in the list's order. */
export function filterUnread(list: readonly Unread[], query: string): readonly Unread[] {
  if (!query.trim()) return list
  return list.filter(({ project, thread }) => score(`${thread.title} ${project.name} ${project.machine.label} ${thread.status.msg ?? ''}`, query) > 0)
}

/** A status message (Markdown, a line or a few) as one short line: its marks and line breaks gone, cut at `max`. */
export function shorten(message: string, max = 120): string {
  const line = message.replace(/[`*_#>|[\]]/g, '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}
