import { useEffect, useState } from 'react'
import type { SessionInfo } from '@mu/protocol'
import { Sidebar } from './Sidebar.tsx'
import { SessionView } from './SessionView.tsx'
import { SettingsView } from './SettingsView.tsx'
import { Button } from '@mu/ui'
import { has, machine, useMachines, useSessions, useSettings } from './client.ts'
import type { MachineEntry } from '../shared.ts'

export type Selection = { machine: string; session: string } | undefined

export function App() {
  const machines = useMachines()
  const [selection, setSelection] = useState<Selection>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const appSettings = useSettings('app', true)

  const interfaceFont = appSettings?.values['app.font.interface']
  const monoFont = appSettings?.values['app.font.mono']
  useEffect(() => {
    const style = document.documentElement.style
    const set = (variable: string, family: unknown) => typeof family === 'string' ? style.setProperty(variable, `"${family.replace(/"/g, '')}", var(${variable}-fallback)`) : style.removeProperty(variable)
    set('--mu-font', interfaceFont)
    set('--mu-mono', monoFont)
  }, [interfaceFont, monoFont])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === ',') { event.preventDefault(); setSettingsOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    // A notification's click, or `mu` on the command line, selects a session.
    const show = (open: Selection | null) => { if (open) { setSettingsOpen(false); setSelection(open) } }
    const off = window.mu.onEvent((event) => {
      if (event.machine === 'app' && event.method === 'app.select') show(event.params as Selection)
    })
    void (window.mu.call('app', 'app.ready', {}) as Promise<Selection | null>).then(show)
    return () => { window.removeEventListener('keydown', onKey); off() }
  }, [])
  const [sessionsByMachine, setSessionsByMachine] = useState<Record<string, SessionInfo[] | undefined>>({})
  const current = selection && sessionsByMachine[selection.machine]?.find((s) => s.id === selection.session)
  const currentMachine = machines.find((m) => m.id === selection?.machine)

  // Looking at a finished or failed session marks it seen.
  useEffect(() => {
    if (!selection || !current || (current.status.state !== 'done' && current.status.state !== 'error')) return
    if (!document.hasFocus()) return
    void machine(selection.machine).call('session.seen', { id: selection.session }).catch(() => {})
  }, [selection?.machine, selection?.session, current?.status.state])

  return (
    <div className="app">
      <aside className="app__sidebar">
        <div className="app__drag" />
        {machines.filter((m) => m.state !== 'disabled').map((m) => (
          <MachineSessions key={m.id} entry={m} onSessions={(list) => setSessionsByMachine((all) => ({ ...all, [m.id]: list }))}>
            {(sessions) => <Sidebar machine={m} sessions={sessions} selection={selection} onSelect={setSelection} />}
          </MachineSessions>
        ))}
        <div className="app__footer"><Button variant="ghost" onClick={() => setSettingsOpen(true)}>Settings</Button></div>
      </aside>
      <main className="app__main">
        <div className="app__drag" />
        {selection && current && currentMachine
          ? <SessionView key={`${selection.machine}/${selection.session}`} machine={currentMachine} session={current} onOpenSettings={() => setSettingsOpen(true)} />
          : <div className="app__empty">Select or start a session.</div>}
      </main>
      {settingsOpen && <SettingsView machines={machines} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function MachineSessions({ entry, onSessions, children }: {
  entry: MachineEntry; onSessions(list: SessionInfo[] | undefined): void; children(list: SessionInfo[] | undefined): React.ReactNode
}) {
  const sessions = useSessions(entry.id, entry.state === 'connected' && has(entry, 'sessions'))
  useEffect(() => { onSessions(sessions) }, [sessions])
  return <>{children(sessions)}</>
}
