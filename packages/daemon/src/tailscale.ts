// Web access over Tailscale: `tailscale serve` fronts the daemon's loopback port with HTTPS at this machine's
// `<machine>.<tailnet>.ts.net` name, and tells it who's asking (Tailscale-User-Login). The daemon sets serve up and takes
// it down itself, through the `tailscale` command, and only ever touches the handler it set up.
//
// Serve proxies to `http://127.0.0.1:<port>/<prefix>`: a random path the daemon makes up each time. A request that comes
// in under it came through serve (no one else knows it), so its identity headers are serve's; one that doesn't is a
// plain loopback client, whose headers could say anything, and they are ignored.
//
// A machine can run more than one tailscaled, each on a tailnet of its own with a socket of its own (Linux:
// /run/tailscale-<name>/tailscaled.sock): every command here takes the socket of the one to use, none for the default.
import { execFile } from 'node:child_process'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
  Self?: { DNSName?: string; HostName?: string; UserID?: number; TailscaleIPs?: string[]; Tags?: string[] | null }
  CurrentTailnet?: { Name?: string } | null
  Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[] }>
  User?: Record<string, { LoginName?: string }>
}
type ServeStatus = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }

class Missing extends Error {}

function tailscale(args: string[], socket: string | undefined, timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tailscale', socket ? [`--socket=${socket}`, ...args] : args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return reject(new Missing('tailscale is not installed'))
      if (error) return reject(new Error((stderr || stdout || error.message).trim()))
      resolve(stdout)
    })
  })
}

async function status(socket?: string): Promise<Status> { return JSON.parse(await tailscale(['status', '--json'], socket)) as Status }

/** This machine's name on the tailnet, without the trailing dot. */
const nameOf = (s: Status) => s.Self?.DNSName?.replace(/\.$/, '')

/** The handler serve has at https://<name>:443/, if any. */
async function served(name: string, socket?: string): Promise<string | undefined> {
  const serve = JSON.parse((await tailscale(['serve', 'status', '--json'], socket)).trim() || '{}') as ServeStatus
  return serve.Web?.[`${name}:443`]?.Handlers?.['/']?.Proxy
}

/**
 * Whether a handler proxies to the daemon's own port: one it set up, or one set up by hand before, which reaches nothing
 * but the daemon either way (and without the prefix, only as a plain loopback client: see web.ts).
 */
const ours = (proxy: string | undefined, port: number) => Boolean(proxy && /^http:\/\/(127\.0\.0\.1|localhost):(\d+)(\/|$)/.exec(proxy)?.[2] === String(port))

/** Serve the daemon's port at https://<name>/ through `prefix`; what came of it. */
export async function startServe(port: number, prefix: string, socket?: string): Promise<TailscaleState> {
  try {
    const s = await status(socket)
    if (s.BackendState !== 'Running') return { state: 'logged-out' }
    const name = nameOf(s)
    if (!name || !s.CertDomains?.length) return { state: 'no-https' }
    const proxy = await served(name, socket)
    if (proxy && !ours(proxy, port)) return { state: 'busy', message: `https://${name}/ already serves ${proxy}` }
    try {
      await tailscale(['serve', '--bg', '--yes', '--https=443', `http://127.0.0.1:${port}/${prefix}`], socket, 30_000)
    } catch (error) {
      const message = (error as Error).message
      // Serve not enabled for the tailnet: the command says where to turn it on.
      if (/not enabled|enable.*https|https.*disabled|serve.*not allowed|permission/i.test(message)) return { state: 'no-https', message }
      return { state: 'error', message }
    }
    // A tagged machine has no owner: its "user" is the tag's, which nobody logs in as.
    const owner = s.Self?.UserID !== undefined && !s.Self.Tags?.length ? s.User?.[String(s.Self.UserID)]?.LoginName : undefined
    return { state: 'serving', url: `https://${name}`, name, ...(owner ? { owner } : {}) }
  } catch (error) {
    return error instanceof Missing ? { state: 'missing' } : { state: 'error', message: (error as Error).message }
  }
}

/** Take down the handler at https://<name>/ if it's the one serving `port`: someone else's stays. */
export async function stopServe(port: number, socket?: string): Promise<void> {
  try {
    const name = nameOf(await status(socket))
    if (name && ours(await served(name, socket), port)) await tailscale(['serve', '--https=443', 'off'], socket)
  } catch { /* not installed or not running: nothing to take down */ }
}

/** The tailnet's devices by address: what a request through serve came from (X-Forwarded-For). */
export async function tailnetNames(socket?: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    const s = await status(socket)
    for (const peer of [...Object.values(s.Peer ?? {}), ...(s.Self ? [s.Self] : [])]) {
      const name = peer.HostName || peer.DNSName?.split('.')[0]
      if (name) for (const ip of peer.TailscaleIPs ?? []) names.set(ip, name)
    }
  } catch { /* no names, then */ }
  return names
}

/** The sockets of the tailscaleds besides the default one this machine runs (Linux: /run/tailscale-<name>/tailscaled.sock). */
export function otherInstances(dirs = ['/run', '/var/run']): string[] {
  const found = new Set<string>()
  for (const dir of dirs) {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue } // no such directory here (macOS has no /run)
    for (const entry of entries) {
      // /run/tailscale is the default one's.
      if (!entry.startsWith('tailscale') || entry === 'tailscale') continue
      const socket = join(dir, entry, 'tailscaled.sock')
      try {
        if (!statSync(socket).isSocket()) continue
        found.add(realpathSync(socket))
      } catch { /* not a tailscaled's directory */ }
    }
  }
  return [...found].sort()
}

/** Which tailnet a tailscaled is on, and as what: "example.com (box.tail1234.ts.net)", for choosing one. */
export async function describeInstance(socket?: string): Promise<string | undefined> {
  try {
    const s = await status(socket)
    const name = nameOf(s)
    const tailnet = s.CurrentTailnet?.Name
    return tailnet && name ? `${tailnet} (${name})` : name || tailnet
  } catch { return undefined } // not running or not reachable: shown by its socket alone
}
