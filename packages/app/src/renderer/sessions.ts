// Sessions: what holds threads. A session is a project on a machine (a repository's main checkout, or a folder), and
// holds the threads started there, worktrees and all. The machine is a fact about the session, not a level above it.
// One order for every place that walks them (the sidebar, the navigator, ⌘⇧[ and ⌘⇧]), set by the sidebar's sort.
import { useMemo } from 'react'
import { rollup, type Status, type ThreadInfo } from '@mu/protocol'
import type { MachineEntry } from '../shared.ts'
import { useAppSetting } from './client.ts'

export type Sort = 'recent' | 'created' | 'status'
export const SORT = 'threads.sort'

export type Session = {
  /** Unique across machines: the machine and the project's folder. */
  key: string
  machine: MachineEntry
  root: string
  name: string
  /** In the session's order (see Sort). */
  threads: ThreadInfo[]
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
      const session = sessions.get(key) ?? { key, machine, root, name: thread.session?.name ?? root.split('/').at(-1) ?? root, threads: [], activeAt: 0, status: { state: 'idle' } }
      session.threads.push(thread)
      sessions.set(key, session)
    }
  }
  const list = [...sessions.values()]
  for (const session of list) {
    session.threads.sort(byThread)
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
export const unread = (thread: ThreadInfo) => ['done', 'error', 'blocked'].includes(thread.status.state)

/** The sessions as the sidebar orders them. */
export function useSessionList(machines: MachineEntry[], threads: Record<string, ThreadInfo[] | undefined>): Session[] {
  const [sort] = useAppSetting<Sort>(SORT)
  return useMemo(() => groupSessions(machines.filter((m) => m.state !== 'disabled'), threads, sort ?? 'recent'), [machines, threads, sort])
}
