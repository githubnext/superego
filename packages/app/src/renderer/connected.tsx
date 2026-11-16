// Settings → a machine → Connected: who is using the machine right now (its daemon's client list, `clients.watch`).
import { useEffect, useState } from 'react'
import type { SectionInfo } from '@superego/protocol'
import { useClients } from './client.ts'
import { useMachines } from './state.tsx'
import { ago } from './web-access.tsx'

const KINDS: Record<string, string> = { 'superego-app': 'the app', web: 'a browser', 'superego-cli': 'the command line', 'superego-daemon': 'another machine', 'superego-outside': 'an outside agent' }

export function ConnectedClients({ target }: { target: string; section: SectionInfo }) {
  const connected = useMachines().find((m) => m.id === target)?.state === 'connected'
  const list = useClients(target, connected)
  // What "active 2 minutes ago" says, kept current.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [])
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
