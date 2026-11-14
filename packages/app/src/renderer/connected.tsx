// Settings → a machine → Connected: who is using the machine right now (its daemon's client list, `clients.watch`).
import { useEffect, useState } from 'react'
import type { ClientInfo, Notifications, SectionInfo } from '@superego/protocol'
import { machine as client } from './client.ts'
import { ago } from './web-access.tsx'

const KINDS: Record<string, string> = { 'superego-app': 'the app', web: 'a browser', 'superego-cli': 'the command line', 'superego-daemon': 'another machine' }

export function ConnectedClients({ target }: { target: string; section: SectionInfo }) {
  const [list, setList] = useState<ClientInfo[]>()
  const [, tick] = useState(0)
  useEffect(() => {
    const machine = client(target)
    let sub: string | undefined
    let live = true
    const off = machine.on('clients.changed', ({ sub: from, value }: Notifications['clients.changed']) => { if (from === sub) setList(value) })
    void machine.call('clients.watch', {}).then((watched) => {
      if (!live) return void machine.call('unwatch', { sub: watched.sub }).catch(() => {})
      sub = watched.sub
      setList(watched.value)
    }, () => setList([]))
    const timer = setInterval(() => tick((n) => n + 1), 30_000)
    return () => { live = false; off(); clearInterval(timer); if (sub) void machine.call('unwatch', { sub }).catch(() => {}) }
  }, [target])
  if (!list) return null
  if (!list.length) return <p className="settings__note">Nobody.</p>
  return (
    <div className="clients">
      {list.map((c) => (
        <div key={c.id} className="profile-row">
          <div className="setting__label">
            <div>{c.label}</div>
            <div className="settings__note">{KINDS[c.kind] ?? c.kind}{c.via === 'socket' ? '' : ` · ${c.via === 'web' ? 'paired browser' : 'Tailscale'}`} · connected {ago(c.connectedAt)} · active {ago(c.activeAt)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
