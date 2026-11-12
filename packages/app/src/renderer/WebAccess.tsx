// Settings → a machine → Web access and Connected: how browsers reach it (a pairing code, or the `tailscale serve`
// command to run), the browsers paired with it, and who is connected right now.
import { useEffect, useState } from 'react'
import type { ClientInfo, Notifications, SectionInfo, WebDevice } from '@superego/protocol'
import { Button, TextField } from '@superego/ui'
import { machine as client } from './client.ts'
import { useRegistry } from './extension.tsx'

type WebData = {
  access: 'off' | 'local' | 'tailscale' | 'network-unencrypted'; url: string | null; error: string | null; devices: WebDevice[]
  tailscale: { command: string; address: string | null; owner: string | null; running: boolean } | null
}

/** How long ago, for people: "just now", "5 min ago", "3 h ago", or the date. */
export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(at).toLocaleDateString()
}

function Copy({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return <Button onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? 'Copied' : label}</Button>
}

/** Settings → a machine → Web access. */
export function WebAccess({ target, section }: { target: string; section: SectionInfo }) {
  const data = section.data as WebData | undefined
  const dispatch = useRegistry().router.dispatch
  const [code, setCode] = useState<{ code: string; expires: number; url: string | null }>()
  const [failed, setFailed] = useState<string>()
  const [renaming, setRenaming] = useState<string>()
  const [, tick] = useState(0)
  useEffect(() => { if (!code) return; const timer = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(timer) }, [code])
  if (!data) return null
  if (data.error) return <p className="setting__error">{data.error}</p>
  const run = (id: string, params: Record<string, unknown> = {}) => dispatch(id, params, { machine: target, source: 'settings' }).catch((error: Error) => { setFailed(error.message); return undefined })
  const open = code && code.expires > Date.now() ? code : undefined
  const left = open ? Math.ceil((open.expires - Date.now()) / 1000) : 0

  return (
    <div className="web-access">
      {data.tailscale && (
        <>
          <p className="settings__note">
            Run this on this machine once, then open the address on any device signed in to your tailnet as
            {' '}{data.tailscale.owner ?? 'this machine’s owner'}{data.tailscale.running ? '' : ' (Tailscale isn’t running here)'}:
          </p>
          <div className="web-access__row"><code className="web-access__url">{data.tailscale.command}</code><Copy text={data.tailscale.command} label="Copy command" /></div>
          {data.tailscale.address && <div className="web-access__row"><code className="web-access__url">{data.tailscale.address}</code><Copy text={data.tailscale.address} label="Copy address" /></div>}
        </>
      )}
      {data.url && (
        <div className="web-access__row">
          <code className="web-access__url">{data.url}</code>
          <Button onClick={() => { setFailed(undefined); void run('web.pair').then((made) => made && setCode(made as typeof code)) }}>Pair a browser…</Button>
        </div>
      )}
      {open && (
        <div className="web-access__pair">
          <code className="web-access__code">{open.code}</code>
          <span className="settings__note">Type it on the other device, or open the address there. Works once, for {left >= 60 ? `${Math.ceil(left / 60)} min` : `${left} s`}.</span>
          {open.url && <Copy text={open.url} label="Copy address" />}
        </div>
      )}
      {failed && <p className="setting__error">{failed}</p>}
      {data.devices.length > 0 && (
        <div className="web-access__devices">
          {data.devices.map((device) => (
            <div key={device.id} className="profile-row">
              <div className="setting__label">
                {renaming === device.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); const name = new FormData(e.currentTarget).get('name') as string; setRenaming(undefined); if (name.trim()) void run('web.device.rename', { id: device.id, name }) }}>
                    <TextField name="name" defaultValue={device.name} autoFocus aria-label="Name" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setRenaming(undefined) } }} />
                  </form>
                ) : <div>{device.name}</div>}
                <div className="settings__note">Paired {new Date(device.created).toLocaleDateString()} · seen {ago(device.seen)}</div>
              </div>
              <div className="provider__actions">
                <Button onClick={() => setRenaming(device.id)}>Rename</Button>
                <Button onClick={() => void run('web.device.revoke', { id: device.id })}>Revoke</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Settings → a machine → Connected: every client on it now, live. */
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

const KINDS: Record<string, string> = { 'superego-app': 'the app', web: 'a browser', 'superego-cli': 'the command line' }
