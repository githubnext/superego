/// <reference path="./env.d.ts" />
// threads: the sidebar of sessions, by machine. Each machine shows its sessions with their status, a rollup of them
// in its heading, and a way to start one in a chosen directory. UI only: it uses the core's session methods.
import { useState } from 'react'
import { defineUiExtension, machine as client, useAllSessions, useMachines, useSelection, useSessions, type MachineEntry } from '@mu/app/ui'
import { IconButton, List, ListItem, Panel, StatusGlyph } from '@mu/ui'
import './styles.css'

/** How long ago, briefly: now, 5m, 2h, then the weekday, then the date. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  const date = new Date(at)
  if (minutes < 6 * 24 * 60) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default defineUiExtension({
  name: 'threads',
  setup(mu) {
    mu.slot('sidebar', Threads)
    mu.command({ id: 'threads.next', title: 'Next session', keys: 'mod+alt+arrowdown', run: () => step(1) })
    mu.command({ id: 'threads.previous', title: 'Previous session', keys: 'mod+alt+arrowup', run: () => step(-1) })
  },
})

/** Moving between sessions from a command: set by the mounted sidebar, which knows the order shown. */
let step: (by: number) => void = () => {}

function Threads() {
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const { selection, select } = useSelection()
  const sessions = useAllSessions()
  const all = machines.flatMap((m) => (sessions[m.id] ?? []).map((s) => ({ machine: m.id, session: s.id })))
  step = (by) => {
    const index = all.findIndex((s) => s.machine === selection?.machine && s.session === selection?.session)
    const next = all[(index + by + all.length) % all.length]
    if (next) select(next)
  }
  return <>{machines.map((m) => <Machine key={m.id} machine={m} />)}</>
}

function Machine({ machine }: { machine: MachineEntry }) {
  const sessions = useSessions(machine.id)
  const { selection, select } = useSelection()
  const [cwd, setCwd] = useState<string>()
  const stale = machine.state !== 'connected'
  const create = async (dir: string) => {
    const created = await client(machine.id).call('session.create', { ...(dir.trim() ? { cwd: dir.trim() } : {}) })
    localStorage.setItem('threads.lastCwd', dir.trim())
    setCwd(undefined)
    select({ machine: machine.id, session: created.id })
  }
  return (
    <Panel
      className={`threads-machine ${stale ? 'is-stale' : ''}`}
      title={<span className="threads-machine__title">{machine.label}{stale && <em>{machine.state === 'connecting' ? 'connecting' : 'offline'}</em>}</span>}
      actions={<IconButton label="New session" disabled={stale} onClick={() => setCwd(localStorage.getItem('threads.lastCwd') ?? '')}>+</IconButton>}
    >
      {cwd !== undefined && (
        <form className="threads-machine__new" onSubmit={(event) => { event.preventDefault(); void create(cwd) }}>
          <input autoFocus placeholder="Working directory (empty: home)" value={cwd} onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setCwd(undefined) } }} />
        </form>
      )}
      <List>
        {(sessions ?? []).map((session) => (
          <ListItem key={session.id}
            selected={selection?.machine === machine.id && selection.session === session.id}
            leading={<StatusGlyph status={session.status} />}
            trailing={ago(session.createdAt)}
            onClick={() => select({ machine: machine.id, session: session.id })}>
            {session.title}
          </ListItem>
        ))}
      </List>
    </Panel>
  )
}
