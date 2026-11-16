// What's unread, and in what order: threads with a result, a failure or a question you haven't seen.
import { unread, type Selection, type Project } from '@superego/app/ui'
import type { Status, ThreadInfo } from '@superego/protocol'

/** Whether ⌘. looks for the next unread thread in every project, or only in the one you're in. */
export type Scope = 'all' | 'project'

const PRIORITY: Record<Status['state'], number> = { blocked: 4, error: 3, done: 2, working: 1, idle: 0 }

const shown = (selection: Selection | undefined, machine: string, thread: ThreadInfo) => selection?.machine === machine && selection.thread === thread.id

/**
 * Every unread thread but the one shown (it's being seen), the most pressing first (a question, a failure, a result),
 * then the most recently active.
 */
export function waiting(projects: Project[], selection: Selection | undefined): { project: Project; thread: ThreadInfo }[] {
  return projects.flatMap((project) => project.threads
    .filter((thread) => unread(thread) && !shown(selection, project.machine.id, thread))
    .map((thread) => ({ project, thread })))
    .sort((a, b) => PRIORITY[b.thread.status.state] - PRIORITY[a.thread.status.state] || b.thread.activeAt - a.thread.activeAt)
}

/**
 * The next unread thread after the one shown, in the sidebar's order (in its project only, for `project`), around to
 * the start; never the one shown.
 */
export function nextUnread(projects: Project[], selection: Selection | undefined, scope: Scope): Selection | undefined {
  const project = projects.find((s) => s.machine.id === selection?.machine && s.threads.some((t) => t.id === selection?.thread))
  const order = (scope === 'project' && project ? [project] : projects).flatMap((s) => s.threads.map((thread) => ({ machine: s.machine.id, thread })))
  const at = order.findIndex((o) => shown(selection, o.machine, o.thread))
  for (let step = 1; step <= order.length; step++) {
    const next = order[(at + step + order.length) % order.length]!
    if (!shown(selection, next.machine, next.thread) && unread(next.thread)) return { machine: next.machine, thread: next.thread.id }
  }
  return undefined
}
