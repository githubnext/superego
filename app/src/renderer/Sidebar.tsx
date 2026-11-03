import { useState } from 'react'
import { rollup, type SessionInfo } from '@mu/protocol'
import { IconButton, List, ListItem, Panel, StatusGlyph } from '@mu/ui'
import type { MachineEntry } from '../shared.ts'
import { machine as client } from './client.ts'
import type { Selection } from './App.tsx'

export function Sidebar({ machine, sessions, selection, onSelect }: {
  machine: MachineEntry; sessions: SessionInfo[] | undefined; selection: Selection; onSelect(selection: Selection): void
}) {
  const [cwd, setCwd] = useState<string>()
  const stale = machine.state !== 'connected'
  const create = async (dir: string) => {
    const created = await client(machine.id).call('session.create', { cwd: dir.trim() || undefined })
    localStorage.setItem('mu.lastCwd', dir.trim())
    setCwd(undefined)
    onSelect({ machine: machine.id, session: created.id })
  }
  return (
    <Panel
      className={`machine ${stale ? 'is-stale' : ''}`}
      title={<span className="machine__title"><StatusGlyph status={rollup((sessions ?? []).map((s) => s.status))} /> {machine.label}{stale && <em> · {machine.state}</em>}</span>}
      actions={<IconButton label="New session" disabled={stale} onClick={() => setCwd(localStorage.getItem('mu.lastCwd') ?? '')}>+</IconButton>}
    >
      {cwd !== undefined && (
        <form className="machine__new" onSubmit={(event) => { event.preventDefault(); void create(cwd) }}>
          <input autoFocus placeholder="Working directory (empty: home)" value={cwd} onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setCwd(undefined) }} />
        </form>
      )}
      <List>
        {(sessions ?? []).map((session) => (
          <ListItem key={session.id}
            selected={selection?.machine === machine.id && selection.session === session.id}
            leading={<StatusGlyph status={session.status} />}
            trailing={session.cwd.split('/').at(-1)}
            onClick={() => onSelect({ machine: machine.id, session: session.id })}>
            {session.title}
          </ListItem>
        ))}
      </List>
    </Panel>
  )
}
