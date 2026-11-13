// Sessions: what holds threads. A session is a project on a machine (a repository's main checkout, or a folder), and
// holds the threads started there, worktrees and all. The machine is a fact about the session, not a level above it.
// One order for every place that walks them (the sidebar, its rail, the navigator, ⌘⇧[ and ⌘⇧]): the rows the sidebar
// shows, top to bottom, whether it's open or not. The sort (the window's own setting, `app.sort`, which the sidebar's
// menu changes) sets it; a thread another started sits right under it.
import { useMemo } from 'react'
import { rollup, waitingForSignIn, type Status, type ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import { useAppSetting } from './client.ts'

export type Sort = 'recent' | 'created' | 'status'
/** App setting: the order of sessions, and of the threads in each. */
export const SORT = 'app.sort'

export type Session = {
  /** Unique across machines: the machine and the project's folder. */
  key: string
  machine: MachineEntry
  root: string
  name: string
  /** As the sidebar shows them, top to bottom: in the session's order (see Sort), each with those it started under it. */
  threads: ThreadInfo[]
  /** How far in each thread sits, by id: 0, or a level under the thread that started it. */
  depth: Record<string, number>
  /** The newest activity in it, and its most pressing status. */
  activeAt: number
  status: Status
}

export const sessionKey = (machine: string, root: string) => `${machine}:${root}`

const activity = (thread: ThreadInfo) => thread.activeAt ?? thread.createdAt
const PRIORITY: Record<Status['state'], number> = { blocked: 4, error: 3, done: 2, working: 1, idle: 0 }

/** Every machine's threads, as sessions, in `sort`'s order: sessions and the threads in each. */
export function groupSessions(machines: MachineEntry[], threads: Record<string, ThreadInfo[] | undefined>, sort: Sort = 'recent'): Session[] {
  const byThread = (a: ThreadInfo, b: ThreadInfo) =>
    sort === 'created' ? b.createdAt - a.createdAt
      : sort === 'status' ? PRIORITY[b.status.state] - PRIORITY[a.status.state] || activity(b) - activity(a)
        : activity(b) - activity(a)
  const sessions = new Map<string, Session>()
  for (const machine of machines) {
    for (const thread of threads[machine.id] ?? []) {
      const root = thread.session?.root ?? thread.cwd
      const key = sessionKey(machine.id, root)
      const session = sessions.get(key) ?? { key, machine, root, name: thread.session?.name ?? root.split('/').at(-1) ?? root, threads: [], depth: {}, activeAt: 0, status: { state: 'idle' } }
      session.threads.push(thread)
      sessions.set(key, session)
    }
  }
  const list = [...sessions.values()]
  for (const session of list) {
    Object.assign(session, nest(session.threads.sort(byThread)))
    session.activeAt = Math.max(...session.threads.map(activity))
    session.status = rollup(session.threads.map((t) => t.status))
  }
  const newest = (s: Session) => Math.max(...s.threads.map((t) => t.createdAt))
  return list.sort((a, b) =>
    sort === 'created' ? newest(b) - newest(a)
      : sort === 'status' ? PRIORITY[b.status.state] - PRIORITY[a.status.state] || b.activeAt - a.activeAt
        : b.activeAt - a.activeAt)
}

/** Whether a thread has something the user hasn't seen: a result, a failure, or a question. */
export const unread = (thread: ThreadInfo) => ['done', 'error', 'blocked'].includes(thread.status.state) && !waitingForSignIn(thread.status)

/**
 * A session's threads with each one a thread started right under it, a level deeper (and its own under it), in the
 * order given otherwise. A thread whose parent isn't among them (archived, or in another project) stands on its own.
 * Given threads already nested, it keeps their order.
 */
export function nest(threads: ThreadInfo[]): Pick<Session, 'threads' | 'depth'> {
  const here = new Set(threads.map((t) => t.id))
  const children = new Map<string, ThreadInfo[]>()
  for (const thread of threads) if (thread.parent && here.has(thread.parent)) children.set(thread.parent, [...children.get(thread.parent) ?? [], thread])
  const out: Pick<Session, 'threads' | 'depth'> = { threads: [], depth: {} }
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
 * The sessions in the order they had (`frozen`), with what each holds now: a thread changing state doesn't move while
 * the order is held. Threads and sessions that appeared since go at the end (a thread started by another, under it);
 * ones that went, go.
 */
export function freeze(frozen: Session[], live: Session[]): Session[] {
  const now = new Map(live.map((s) => [s.key, s]))
  const kept = frozen.flatMap((old) => {
    const session = now.get(old.key)
    if (!session) return []
    now.delete(old.key)
    const threads = new Map(session.threads.map((t) => [t.id, t]))
    const ordered = old.threads.flatMap((t) => threads.has(t.id) ? [threads.get(t.id)!] : [])
    return [{ ...session, ...nest([...ordered, ...session.threads.filter((t) => !old.threads.some((o) => o.id === t.id))]) }]
  })
  return [...kept, ...now.values()]
}

/**
 * The thread `by` from `from`: down (or up) the rows the sidebar shows, across sessions, and around at the ends; from
 * nothing (or a thread not listed: archived, Ego's), the first or the last. There's nothing to fold in the sidebar, so
 * every listed thread is a row; archived ones aren't listed.
 */
export function threadBeside(sessions: Session[], from: { machine: string; thread: string } | undefined, by: number) {
  const order = sessions.flatMap((s) => s.threads.map((thread) => ({ machine: s.machine.id, thread: thread.id })))
  if (!order.length) return undefined
  const at = order.findIndex((o) => o.machine === from?.machine && o.thread === from.thread)
  return order[at < 0 ? (by > 0 ? 0 : order.length - 1) : (at + by + order.length) % order.length]
}

/** The sessions as the sidebar orders them. */
export function useSessionList(machines: MachineEntry[], threads: Record<string, ThreadInfo[] | undefined>): Session[] {
  const [sort] = useAppSetting<Sort>(SORT)
  return useMemo(() => groupSessions(machines.filter((m) => m.state !== 'disabled'), threads, sort ?? 'recent'), [machines, threads, sort])
}
