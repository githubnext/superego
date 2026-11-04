// The sidebar's order, without React: how sessions group and sort, and how times read.
import type { MachineEntry } from '@mu/app/ui'
import type { SessionInfo, Status } from '@mu/protocol'

export type Sort = 'created' | 'recent' | 'status'

/** When a session last did something; a daemon from before last-activity was reported gives its creation. */
export const activity = (session: SessionInfo) => session.activeAt ?? session.createdAt

/** How long ago, briefly: now, 5m, 2h, then the weekday, then the date. */
export function ago(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return ''
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  const date = new Date(at)
  if (minutes < 6 * 24 * 60) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export type Row = { machine: MachineEntry; session: SessionInfo }
export type Group = { id: string; title: string; note?: string; machine?: MachineEntry; rows: Row[] }

const STATUS_GROUPS: { id: string; title: string; states: Status['state'][] }[] = [
  { id: 'needs', title: 'Needs you', states: ['blocked', 'error'] },
  { id: 'working', title: 'Working', states: ['working'] },
  { id: 'done', title: 'Done', states: ['done'] },
  { id: 'idle', title: 'Idle', states: ['idle'] },
]

/** The sidebar's groups for a sort: by machine (newest or most recently active first), or by status across machines. */
export function groupSessions(machines: MachineEntry[], sessions: Record<string, SessionInfo[] | undefined>, sort: Sort): Group[] {
  const rows = (m: MachineEntry) => (sessions[m.id] ?? []).map((session) => ({ machine: m, session }))
  if (sort === 'status') {
    const all = machines.flatMap(rows).sort((a, b) => activity(b.session) - activity(a.session))
    return STATUS_GROUPS.map((g) => ({ id: g.id, title: g.title, rows: all.filter((r) => g.states.includes(r.session.status.state)) })).filter((g) => g.rows.length)
  }
  return machines.map((m) => ({
    id: m.id, title: m.label, machine: m,
    ...(m.state !== 'connected' ? { note: m.state === 'connecting' ? 'connecting' : 'offline' } : {}),
    rows: rows(m).sort((a, b) => sort === 'recent' ? activity(b.session) - activity(a.session) : b.session.createdAt - a.session.createdAt),
  }))
}

