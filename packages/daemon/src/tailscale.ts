// Web access over Tailscale: `tailscale serve` fronts the daemon's loopback port with HTTPS at this machine's
// `<machine>.<tailnet>.ts.net` name, and tells it who's asking (Tailscale-User-Login). The daemon sets serve up and takes
// it down itself, through the `tailscale` command, and only ever touches the handler it set up.
//
// Serve proxies to `http://127.0.0.1:<port>/<prefix>`: a random path the daemon makes up each time. A request that comes
// in under it came through serve (no one else knows it), so its identity headers are serve's; one that doesn't is a
// plain loopback client, whose headers could say anything, and they are ignored.
import { execFile } from 'node:child_process'

export type TailscaleState =
  | { state: 'starting' }
  | { state: 'missing' }
  | { state: 'logged-out' }
  | { state: 'no-https'; message?: string }
  | { state: 'busy'; message: string }
  | { state: 'error'; message: string }
  | { state: 'serving'; url: string; name: string; owner?: string }

type Status = {
  BackendState?: string
  CertDomains?: string[] | null
  Self?: { DNSName?: string; HostName?: string; UserID?: number; TailscaleIPs?: string[] }
  Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[] }>
  User?: Record<string, { LoginName?: string }>
}
type ServeStatus = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }

class Missing extends Error {}

function tailscale(args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tailscale', args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return reject(new Missing('tailscale is not installed'))
      if (error) return reject(new Error((stderr || stdout || error.message).trim()))
      resolve(stdout)
    })
  })
}

async function status(): Promise<Status> { return JSON.parse(await tailscale(['status', '--json'])) as Status }

/** This machine's name on the tailnet, without the trailing dot. */
const nameOf = (s: Status) => s.Self?.DNSName?.replace(/\.$/, '')

/** The handler serve has at https://<name>:443/, if any. */
async function served(name: string): Promise<string | undefined> {
  const serve = JSON.parse((await tailscale(['serve', 'status', '--json'])).trim() || '{}') as ServeStatus
  return serve.Web?.[`${name}:443`]?.Handlers?.['/']?.Proxy
}

const ours = (proxy: string | undefined, port: number) => Boolean(proxy?.startsWith(`http://127.0.0.1:${port}/`))

/** Serve the daemon's port at https://<name>/ through `prefix`; what came of it. */
export async function startServe(port: number, prefix: string): Promise<TailscaleState> {
  try {
    const s = await status()
    if (s.BackendState !== 'Running') return { state: 'logged-out' }
    const name = nameOf(s)
    if (!name || !s.CertDomains?.length) return { state: 'no-https' }
    const proxy = await served(name)
    if (proxy && !ours(proxy, port)) return { state: 'busy', message: `https://${name}/ already serves ${proxy}` }
    try {
      await tailscale(['serve', '--bg', '--yes', '--https=443', `http://127.0.0.1:${port}/${prefix}`], 30_000)
    } catch (error) {
      const message = (error as Error).message
      // Serve not enabled for the tailnet: the command says where to turn it on.
      if (/not enabled|enable.*https|https.*disabled|serve.*not allowed|permission/i.test(message)) return { state: 'no-https', message }
      return { state: 'error', message }
    }
    const owner = s.Self?.UserID !== undefined ? s.User?.[String(s.Self.UserID)]?.LoginName : undefined
    return { state: 'serving', url: `https://${name}`, name, ...(owner ? { owner } : {}) }
  } catch (error) {
    return error instanceof Missing ? { state: 'missing' } : { state: 'error', message: (error as Error).message }
  }
}

/** Take down the handler at https://<name>/ if it's the one serving `port`: someone else's stays. */
export async function stopServe(port: number): Promise<void> {
  try {
    const name = nameOf(await status())
    if (name && ours(await served(name), port)) await tailscale(['serve', '--https=443', 'off'])
  } catch { /* not installed or not running: nothing to take down */ }
}

/** The tailnet's devices by address: what a request through serve came from (X-Forwarded-For). */
export async function tailnetNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    const s = await status()
    for (const peer of [...Object.values(s.Peer ?? {}), ...(s.Self ? [s.Self] : [])]) {
      const name = peer.HostName || peer.DNSName?.split('.')[0]
      if (name) for (const ip of peer.TailscaleIPs ?? []) names.set(ip, name)
    }
  } catch { /* no names, then */ }
  return names
}
