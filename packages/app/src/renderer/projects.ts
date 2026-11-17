// Projects: what holds threads. A project is a repository (its main checkout) or a folder on a machine, and
// holds the threads started there, worktrees and all. The machine is a fact about the project, not a level above it.
// One order for every place that walks them (the sidebar, its rail, the navigator, ⌘⇧[ and ⌘⇧]): the rows the sidebar
// shows, top to bottom, whether it's open or not; pinned threads first (see pins.ts), then each project's. The sort (the window's own setting, `app.sort`, which the sidebar's
// menu changes) sets it; a thread another started sits right under it.
import { useMemo } from 'react'
import { rollup, statusRank, unreadThreads, type Status, type ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import { useAppSetting } from './client.ts'
import type { Pin } from './pins.ts'

export type Sort = 'recent' | 'created' | 'status'
/** App setting: the order of projects, and of the threads in each. */
export const SORT = 'app.sort'

/** A project on a machine, as the sidebar groups threads: its folder, and its threads in order. */
export type Project = {
  /** Unique across machines: the machine and the project's folder. */
  key: string
  machine: MachineEntry
  root: string
  name: string
  /** As the sidebar shows them, top to bottom: in the project's order (see Sort), each with those it started under it. */
  threads: ThreadInfo[]
  /** How far in each thread sits, by id: 0, or a level under the thread that started it. */
  depth: Record<string, number>
  /** The newest activity in it, and its most pressing status. */
  activeAt: number
  status: Status
}

export const projectKey = (machine: string, root: string) => `${machine}:${root}`

/** A pinned thread, with the project it's in. */
export type PinnedThread = { project: Project; thread: ThreadInfo }

/**
 * What the sidebar lists, top to bottom: the pinned threads, in the order they were pinned, then the projects with the
 * rest (a project whose threads are all pinned isn't listed). Each thread once.
 */
export type Sidebar = { pinned: PinnedThread[]; projects: Project[] }

/** The sidebar of `projects`, with `pins` taken to the top. Pins of threads not among them (archived, on a machine off) aren't listed. */
export function pinnedFirst(projects: Project[], pins: readonly Pin[]): Sidebar {
  if (!pins.length) return { pinned: [], projects }
  const pinned: PinnedThread[] = []
  for (const pin of pins) {
    const project = projects.find((p) => p.machine.id === pin.machine && p.threads.some((t) => t.id === pin.thread))
    if (project) pinned.push({ project, thread: project.threads.find((t) => t.id === pin.thread)! })
  }
  const out = new Set(pinned.map(({ project, thread }) => `${project.machine.id}/${thread.id}`))
  const rest = projects.flatMap((project) => {
    if (!project.threads.some((t) => out.has(`${project.machine.id}/${t.id}`))) return [project]
    const threads = project.threads.filter((t) => !out.has(`${project.machine.id}/${t.id}`))
    return threads.length ? [{ ...project, ...nest(threads) }] : []
  })
  return { pinned, projects: rest }
}

/** The sidebar's threads, top to bottom: the pinned, then each project's. */
export const sidebarOrder = ({ pinned, projects }: Sidebar) => [
  ...pinned.map(({ project, thread }) => ({ machine: project.machine.id, thread: thread.id })),
  ...projects.flatMap((s) => s.threads.map((thread) => ({ machine: s.machine.id, thread: thread.id }))),
]

/**
 * Every unread thread in `projects` but the one shown (`selection`: it's being seen), the most pressing first, with
 * its project: what the unread bell lists, ⌘. goes through and the threads rail marks, by the one rule the app
 * icon's count and `<id> unread` use too (the protocol's `unreadThreads`).
 */
export function unreadList(projects: Project[], selection?: { machine: string; thread: string }) {
  return unreadThreads(projects.flatMap((project) => project.threads.map((thread) => ({ machine: project.machine.id, project, thread }))), selection)
}

/** Every machine's threads, as projects, in `sort`'s order: projects and the threads in each. */
export function groupProjects(machines: MachineEntry[], threads: Record<string, ThreadInfo[] | undefined>, sort: Sort = 'recent'): Project[] {
  const byThread = (a: ThreadInfo, b: ThreadInfo) =>
    sort === 'created' ? b.createdAt - a.createdAt
      : sort === 'status' ? statusRank(b.status) - statusRank(a.status) || b.activeAt - a.activeAt
        : b.activeAt - a.activeAt
  const projects = new Map<string, Project>()
  for (const machine of machines) {
    for (const thread of threads[machine.id] ?? []) {
      const root = thread.project.root
      const key = projectKey(machine.id, root)
      const project = projects.get(key) ?? { key, machine, root, name: thread.project.name, threads: [], depth: {}, activeAt: 0, status: { state: 'idle' } }
      project.threads.push(thread)
      projects.set(key, project)
    }
  }
  const list = [...projects.values()]
  for (const project of list) {
    Object.assign(project, nest(project.threads.sort(byThread)))
    project.activeAt = Math.max(...project.threads.map((t) => t.activeAt))
    project.status = rollup(project.threads.map((t) => t.status))
  }
  const newest = (s: Project) => Math.max(...s.threads.map((t) => t.createdAt))
  return list.sort((a, b) =>
    sort === 'created' ? newest(b) - newest(a)
      : sort === 'status' ? statusRank(b.status) - statusRank(a.status) || b.activeAt - a.activeAt
        : b.activeAt - a.activeAt)
}

/**
 * A project's threads with each one a thread started right under it, a level deeper (and its own under it), in the
 * order given otherwise. A thread whose parent isn't among them (archived, hidden like Ego's, or in another project)
 * stands on its own.
 * Given threads already nested, it keeps their order.
 */
export function nest(threads: ThreadInfo[]): Pick<Project, 'threads' | 'depth'> {
  const here = new Set(threads.map((t) => t.id))
  const children = new Map<string, ThreadInfo[]>()
  for (const thread of threads) if (thread.parent && here.has(thread.parent)) children.set(thread.parent, [...children.get(thread.parent) ?? [], thread])
  const out: Pick<Project, 'threads' | 'depth'> = { threads: [], depth: {} }
  const place = (thread: ThreadInfo, depth: number) => {
    if (thread.id in out.depth) return
    out.threads.push(thread)
    out.depth[thread.id] = depth
    for (const child of children.get(thread.id) ?? []) place(child, depth + 1)
  }
  for (const thread of threads) if (!thread.parent || !here.has(thread.parent)) place(thread, 0)
  for (const thread of threads) place(thread, 0) // parents in a loop, none of them first: on their own
  return out
}

/**
 * The projects in the order they had (`frozen`), with what each holds now: a thread changing state doesn't move while
 * the order is held. Threads and projects that appeared since go at the end (a thread started by another, under it);
 * ones that went, go.
 */
export function freeze(frozen: Project[], live: Project[]): Project[] {
  const now = new Map(live.map((s) => [s.key, s]))
  const kept = frozen.flatMap((old) => {
    const project = now.get(old.key)
    if (!project) return []
    now.delete(old.key)
    const threads = new Map(project.threads.map((t) => [t.id, t]))
    const ordered = old.threads.flatMap((t) => threads.has(t.id) ? [threads.get(t.id)!] : [])
    return [{ ...project, ...nest([...ordered, ...project.threads.filter((t) => !old.threads.some((o) => o.id === t.id))]) }]
  })
  return [...kept, ...now.values()]
}

/**
 * The thread `by` from `from`: down (or up) the rows the sidebar shows, pinned ones first, across projects, and around at the ends; from
 * nothing (or a thread not listed: archived, Ego's), the first or the last. No project's threads are closed in the sidebar, so
 * every listed thread is a row; archived ones aren't listed.
 */
export function threadBeside(sidebar: Sidebar, from: { machine: string; thread: string } | undefined, by: number) {
  const order = sidebarOrder(sidebar)
  if (!order.length) return undefined
  const at = order.findIndex((o) => o.machine === from?.machine && o.thread === from.thread)
  return order[at < 0 ? (by > 0 ? 0 : order.length - 1) : (at + by + order.length) % order.length]
}

/** The projects as the sidebar orders them. */
export function useProjectList(machines: MachineEntry[], threads: Record<string, ThreadInfo[] | undefined>): Project[] {
  const [sort] = useAppSetting<Sort>(SORT)
  return useMemo(() => groupProjects(machines.filter((m) => m.state !== 'disabled'), threads, sort ?? 'recent'), [machines, threads, sort])
}
