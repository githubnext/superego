// Settings → a machine → Web access, below its settings: where it's served (and how Tailscale is doing), pairing a
// device (a link, its QR code, and a code to type), and the devices paired.
import { useEffect, useState } from 'react'
import type { SectionInfo } from '@superego/protocol'
import { Button, TextField } from '@superego/ui'
import { renderSVG } from 'uqr'
import { useRegistry } from './extension.tsx'

type Device = { id: string; name: string; created?: number; lastSeen: number; address: string; tailscale?: true }
type Tailscale =
  | { state: 'starting' | 'missing' | 'logged-out' }
  | { state: 'no-https' | 'busy' | 'error'; message?: string }
  | { state: 'serving'; url: string; name: string; owner?: string }
type Data = { url?: string | null; tailscale?: Tailscale | null; devices?: Device[]; notice?: string | null; error?: string | null }
type Ticket = { link: string; code: string; expires: number }

/** "just now", "5 min ago", "3 h ago", "12 days ago". */
export function ago(time: number, now = Date.now()): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 60 / 24)} days ago`
}

function TailscaleState({ tailscale }: { tailscale: Tailscale }) {
  switch (tailscale.state) {
    case 'starting': return <p className="settings__note">Setting up Tailscale serve…</p>
    case 'missing': return <p className="setting__error">Tailscale isn’t installed here. <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Get it</a>, then choose Tailscale again.</p>
    case 'logged-out': return <p className="setting__error">Tailscale isn’t logged in on this machine.</p>
    case 'no-https': return <p className="setting__error">Tailscale won’t serve here: turn on HTTPS certificates for the tailnet (admin console → DNS).{tailscale.message ? ` ${tailscale.message}` : ''}</p>
    case 'busy': case 'error': return <p className="setting__error">{tailscale.message}</p>
    case 'serving': return null
  }
}

export function WebAccess({ target, section }: { target: string; section: SectionInfo }) {
  const { url, tailscale, devices = [], notice, error } = (section.data ?? {}) as Data
  const dispatch = useRegistry().router.dispatch
  const run = (id: string, params: Record<string, unknown> = {}) => dispatch(id, params, { machine: target, source: 'settings' })
  const [ticket, setTicket] = useState<Ticket>()
  const [problem, setProblem] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [paired, setPaired] = useState(devices.length)
  // The ticket counts down, and goes once it's spent (a device more) or expired.
  useEffect(() => {
    if (!ticket) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [ticket])
  useEffect(() => {
    if (ticket && (devices.length > paired || now >= ticket.expires)) setTicket(undefined)
    setPaired(devices.length)
  }, [devices.length, now])
  const pair = async () => {
    setProblem(undefined)
    try { setTicket(await run('web.pair') as Ticket); setNow(Date.now()) } catch (e) { setProblem((e as Error).message) }
  }
  const left = ticket ? Math.max(0, Math.ceil((ticket.expires - now) / 1000)) : 0

  return (
    <div className="web-access">
      {notice && <p className="settings__note web-access__notice">{notice}</p>}
      {error && <p className="setting__error">{error}</p>}
      {tailscale && <TailscaleState tailscale={tailscale} />}
      {url && (
        <div className="web-access__row">
          <code className="web-access__url">{url}</code>
          <Button onClick={() => { void navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? 'Copied' : 'Copy address'}</Button>
          {!ticket && <Button variant="primary" onClick={() => void pair()}>Pair a device</Button>}
        </div>
      )}
      {problem && <p className="setting__error">{problem}</p>}
      {ticket && (
        <div className="web-pair">
          <div className="web-pair__qr" aria-label="QR code of the pairing link" dangerouslySetInnerHTML={{ __html: renderSVG(ticket.link, { border: 2 }) }} />
          <div className="web-pair__how">
            <p>Scan it, or open the link on the device:</p>
            <code className="web-pair__link" title={ticket.link}>{ticket.link}</code>
            <p>On a page added to the home screen, enter <code className="web-pair__code">{ticket.code}</code></p>
            <p className="settings__note">Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</p>
            <div className="web-pair__actions">
              <Button onClick={() => void navigator.clipboard.writeText(ticket.link)}>Copy link</Button>
              <Button onClick={() => setTicket(undefined)}>Done</Button>
            </div>
          </div>
        </div>
      )}
      {devices.length > 0 && (
        <div className="web-devices">
          {devices.map((device) => <DeviceRow key={device.id} device={device} run={run} />)}
        </div>
      )}
    </div>
  )
}

function DeviceRow({ device, run }: { device: Device; run(id: string, params?: Record<string, unknown>): Promise<unknown> }) {
  const [editing, setEditing] = useState(false)
  const rename = (name: string) => { setEditing(false); if (name.trim() && name.trim() !== device.name) void run('web.rename', { id: device.id, name: name.trim() }) }
  return (
    <div className="web-device">
      <div className="setting__label">
        {editing
          ? <TextField aria-label="Device name" defaultValue={device.name} autoFocus onBlur={(e) => rename(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') rename(e.currentTarget.value); if (e.key === 'Escape') setEditing(false) }} />
          : <div>{device.tailscale ? `You via Tailscale (${device.name})` : device.name}</div>}
        <div className="settings__note">{ago(device.lastSeen)} · {device.address}</div>
      </div>
      {!device.tailscale && !editing && (
        <div className="web-device__actions">
          <Button onClick={() => setEditing(true)}>Rename</Button>
          <Button onClick={() => void run('web.revoke', { id: device.id })}>Revoke</Button>
        </div>
      )}
    </div>
  )
}
