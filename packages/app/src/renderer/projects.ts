// Projects: what holds threads. A project is a repository (its main checkout) or a folder on a machine, and
// holds the threads started there, worktrees and all. The machine is a fact about the project, not a level above it.
// One order for every place that walks them (the sidebar, its rail, the navigator, ⌘⇧[ and ⌘⇧]): the rows the sidebar
// shows, top to bottom, whether it's open or not; pinned threads first (see pins.ts), then each project's (its pinned
// at its top, again). The sidebar's sections (Pinned, each project) and the threads with others under them fold,
// as the window was left (`folded`); ⌘⇧[ and ⌘⇧] go down the rows still shown, the selected one always among them. The sort (the window's own setting, `app.sort`, which the sidebar's
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
 * What the sidebar lists, top to bottom: the pinned threads, in the order they were pinned, then every project, its
 * pinned threads at its top (in that order too) and the rest as they sort. A pinned thread is listed twice. `folded`:
 * the sections and threads folded (see `fold`), what's in them out of sight.
 */
export type Sidebar = { pinned: PinnedThread[]; projects: Project[]; folded: readonly string[] }

/** The sidebar of `projects`, with `pins` taken to the top. Pins of threads not among them (archived, on a machine off) aren't listed. */
export function pinnedFirst(projects: Project[], pins: readonly Pin[], folded: readonly string[] = []): Sidebar {
  if (!pins.length) return { pinned: [], projects, folded }
  const pinned: PinnedThread[] = []
  for (const pin of pins) {
    const project = projects.find((p) => p.machine.id === pin.machine && p.threads.some((t) => t.id === pin.thread))
    if (project) pinned.push({ project, thread: project.threads.find((t) => t.id === pin.thread)! })
  }
  return {
    pinned,
    folded,
    projects: projects.map((project) => {
      const top = pinned.filter((p) => p.project === project).map((p) => p.thread)
      // Each with the threads it started right under it, as everywhere.
      return top.length ? { ...project, ...nest([...top, ...project.threads.filter((t) => !top.includes(t))]) } : project
    }),
  }
}

/**
 * What folds in the sidebar, by key: the Pinned section, a project (by machine and folder), a thread with others under
 * it (by machine and id). Kept in the window, as it was left.
 */
export const fold = {
  pinned: 'pinned',
  project: (project: Pick<Project, 'key'>) => `project:${project.key}`,
  thread: (machine: string, thread: string) => `thread:${machine}/${thread}`,
}

/**
 * A row the sidebar shows: a thread, how far in, and, when others sit under it, its fold (`fold`) and whether it's
 * folded; `tucked`, those under it out of sight.
 */
export type ShownRow = { project: Project; thread: ThreadInfo; depth: number; fold?: string; folded: boolean; tucked: ThreadInfo[] }
/** A section as the sidebar shows it: its fold, its rows, and (folded) the threads out of sight in it. */
export type ShownSection = { fold: string; folded: boolean; rows: ShownRow[]; tucked: ThreadInfo[] }

type At = { machine: string; thread: string } | undefined
const isAt = (at: At, machine: string, thread: string) => at?.machine === machine && at.thread === thread

/**
 * The rows the sidebar shows, section by section, given what's folded: a folded section shows none of its threads, a
 * folded thread none of those under it (and theirs). The selected thread (`selection`) shows wherever it is, folded
 * or not: in a folded section on its own, under a folded thread right under it.
 */
export function shownRows(sidebar: Sidebar, selection?: At): { pinned: ShownSection; projects: (ShownSection & { project: Project })[] } {
  const folded = new Set(sidebar.folded)
  const section = (key: string, rows: ShownRow[]): ShownSection => {
    if (!folded.has(key)) return { fold: key, folded: false, rows, tucked: [] }
    const shown = rows.filter((row) => isAt(selection, row.project.machine.id, row.thread.id))
    return {
      fold: key, folded: true,
      rows: shown.map((row) => ({ ...row, depth: 0, fold: undefined, folded: false, tucked: [] })),
      tucked: rows.flatMap((row) => shown.includes(row) ? row.tucked : [row.thread, ...row.tucked]),
    }
  }
  const projectRows = (project: Project) => {
    const rows: ShownRow[] = []
    // The folded thread the rows go under, while they're deeper than it.
    let under: ShownRow | undefined
    project.threads.forEach((thread, i) => {
      const depth = project.depth[thread.id] ?? 0
      if (under && depth > under.depth) {
        if (isAt(selection, project.machine.id, thread.id)) rows.push({ project, thread, depth: under.depth + 1, folded: false, tucked: [] })
        else under.tucked.push(thread)
        return
      }
      const next = project.threads[i + 1]
      const key = next && (project.depth[next.id] ?? 0) > depth ? fold.thread(project.machine.id, thread.id) : undefined
      const row: ShownRow = { project, thread, depth, ...(key ? { fold: key } : {}), folded: Boolean(key && folded.has(key)), tucked: [] }
      rows.push(row)
      under = row.folded ? row : undefined
    })
    return rows
  }
  return {
    pinned: section(fold.pinned, sidebar.pinned.map(({ project, thread }) => ({ project, thread, depth: 0, folded: false, tucked: [] }))),
    projects: sidebar.projects.map((project) => ({ project, ...section(fold.project(project), projectRows(project)) })),
  }
}

/** The sidebar's threads, top to bottom, each once: the pinned, then each project's others; of those, the rows shown (see `shownRows`). */
export function sidebarOrder(sidebar: Sidebar, selection?: At) {
  const { pinned, projects } = shownRows(sidebar, selection)
  const seen = new Set<string>()
  return [pinned, ...projects].flatMap((s) => s.rows).map(({ project, thread }) => ({ machine: project.machine.id, thread: thread.id }))
    .filter(({ machine, thread }) => {
      const key = `${machine}/${thread}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/**
 * What to unfold to show `selection` in the sidebar: nothing when a row shows it already; for a pinned thread, Pinned;
 * else its project, and every thread above it there.
 */
export function wayTo(sidebar: Sidebar, selection: { machine: string; thread: string }): string[] {
  if (sidebarOrder(sidebar).some((at) => isAt(at, selection.machine, selection.thread))) return []
  const folded = new Set(sidebar.folded)
  if (sidebar.pinned.some(({ project, thread }) => isAt(selection, project.machine.id, thread.id))) return [fold.pinned]
  const project = sidebar.projects.find((p) => p.machine.id === selection.machine && p.threads.some((t) => t.id === selection.thread))
  if (!project) return []
  const way = [fold.project(project)]
  // Up from it: each row before it less deep than the last is a thread it's under.
  const at = project.threads.findIndex((t) => t.id === selection.thread)
  let depth = project.depth[selection.thread] ?? 0
  for (let i = at - 1; i >= 0 && depth > 0; i--) {
    const above = project.threads[i]!
    const d = project.depth[above.id] ?? 0
    if (d < depth) { way.push(fold.thread(project.machine.id, above.id)); depth = d }
  }
  return way.filter((key) => folded.has(key))
}

/**
 * The folds still worth keeping: of a section or thread still listed, or on a machine whose threads aren't known now
 * (not connected, or not heard yet), which keeps its own.
 */
export function stillFolded(folded: readonly string[], projects: readonly Project[], machines: readonly MachineEntry[], threads: Record<string, ThreadInfo[] | undefined>): string[] {
  const listed = new Set([fold.pinned, ...projects.flatMap((p) => [fold.project(p), ...p.threads.map((t) => fold.thread(p.machine.id, t.id))])])
  const known = machines.filter((m) => m.state === 'connected' && threads[m.id])
  return folded.filter((key) => listed.has(key) || !known.some((m) => key.startsWith(`project:${projectKey(m.id, '')}`) || key.startsWith(`thread:${m.id}/`)))
}

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
 * The thread `by` from `from`: down (or up) the rows the sidebar shows, pinned ones first (and not again in their project),
 * across projects, and around at the ends, past what's folded; from nothing (or a thread not listed: archived, Ego's),
 * the first or the last.
 */
export function threadBeside(sidebar: Sidebar, from: { machine: string; thread: string } | undefined, by: number) {
  const order = sidebarOrder(sidebar, from)
  if (!order.length) return undefined
  const at = order.findIndex((o) => o.machine === from?.machine && o.thread === from.thread)
  return order[at < 0 ? (by > 0 ? 0 : order.length - 1) : (at + by + order.length) % order.length]
}

/** The projects as the sidebar orders them. */
export function useProjectList(machines: MachineEntry[], threads: Record<string, ThreadInfo[] | undefined>): Project[] {
  const [sort] = useAppSetting<Sort>(SORT)
  return useMemo(() => groupProjects(machines.filter((m) => m.state !== 'disabled'), threads, sort ?? 'recent'), [machines, threads, sort])
}
