// Web access over Tailscale: `tailscale serve` fronts the daemon with HTTPS at this machine's `<machine>.<tailnet>.ts.net`
// name, and tells it where a request came from (X-Forwarded-For): `tailscale whois` says which device of the tailnet
// that is, and whose. The daemon sets serve up and takes it down itself, through the `tailscale` command, and only ever
// touches the handler it set up.
//
// Serve proxies to a Unix socket of the daemon's (`unix:<path>`), in a folder only its user opens: tailscaled runs as
// root, so it gets in, and no one else on the computer does. That's what makes its identity headers believable there.
// The serve config itself is no secret (any local user may read it, `tailscale serve status`), and the daemon's TCP port
// on loopback is anyone's on the computer, so headers that come in there are ignored (see web.ts).
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
  /** The tailscaled's version: `1.104.5-t788384763-gd9218e278`. */
  Version?: string
  BackendState?: string
  CertDomains?: string[] | null
  Self?: { DNSName?: string; UserID?: number; Tags?: string[] | null }
  CurrentTailnet?: { Name?: string } | null
  User?: Record<string, { LoginName?: string }>
  Peer?: Record<string, { HostName?: string; DNSName?: string }> | null
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
 * Whether a handler is the daemon's to replace or take down: one to its socket, or one to its port on loopback (set up
 * by an earlier version, or by hand), which reaches nothing but the daemon either way, as a plain loopback client.
 */
const ours = (proxy: string | undefined, { port, target }: Ours) =>
  Boolean(proxy && (proxy === `unix:${target}` || /^http:\/\/(127\.0\.0\.1|localhost):(\d+)(\/|$)/.exec(proxy)?.[2] === String(port)))

/** The daemon's ends of serve: its Unix socket serve proxies to, and its port on loopback. */
type Ours = { target: string; port: number }

/** The first tailscaled that serves to a Unix socket (`unix:` targets, identity headers and all). */
const SERVES_SOCKETS = [1, 94] as const

/** Whether a tailscaled of `version` serves to a Unix socket; one that doesn't say is let try (and says so if not). */
const servesSockets = (version: string | undefined) => {
  const [major, minor] = (version ?? '').split(/[.-]/).map(Number)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return true
  return major! > SERVES_SOCKETS[0] || (major === SERVES_SOCKETS[0] && minor! >= SERVES_SOCKETS[1])
}

/** Serve the daemon's socket `target` at https://<name>/, through the tailscaled at `socket`; what came of it. */
export async function startServe(daemon: Ours, socket?: string): Promise<TailscaleState> {
  try {
    const s = await status(socket)
    if (s.BackendState !== 'Running') return { state: 'logged-out' }
    const name = nameOf(s)
    if (!name || !s.CertDomains?.length) return { state: 'no-https' }
    if (!servesSockets(s.Version)) return { state: 'error', message: `Tailscale ${s.Version?.split('-')[0]} can't serve Web access: update it to ${SERVES_SOCKETS.join('.')} or later.` }
    const proxy = await served(name, socket)
    if (proxy && !ours(proxy, daemon)) return { state: 'busy', message: `https://${name}/ already serves ${proxy}` }
    // Already serving the daemon's socket (set up earlier, maybe by the user with sudo): nothing to do, and asking again
    // could be refused (below).
    if (proxy !== `unix:${daemon.target}`) {
      try {
        await tailscale(['serve', '--bg', '--yes', '--https=443', `unix:${daemon.target}`], socket, 30_000)
      } catch (error) {
        const message = (error as Error).message
        // tailscaled lets only root, or an operator who may run `sudo tailscale` without a password, serve to a socket:
        // the user does it once, as root, and it stays.
        if (/must be root|be an operator/i.test(message)) {
          const command = ['sudo tailscale', ...(socket ? [`--socket=${socket}`] : []), 'serve --bg --https=443', `unix:${daemon.target}`].join(' ')
          return { state: 'error', message: `Tailscale lets only an administrator serve to the daemon's socket. Run this once in a terminal, then switch Web access off and on: ${command}` }
        }
        // Serve not enabled for the tailnet: the command says where to turn it on.
        if (/not enabled|enable.*https|https.*disabled|serve.*not allowed|permission/i.test(message)) return { state: 'no-https', message }
        return { state: 'error', message }
      }
    }
    // A tagged machine has no owner: its "user" is the tag's, which nobody logs in as.
    const owner = s.Self?.UserID !== undefined && !s.Self.Tags?.length ? s.User?.[String(s.Self.UserID)]?.LoginName : undefined
    return { state: 'serving', url: `https://${name}`, name, ...(owner ? { owner } : {}) }
  } catch (error) {
    return error instanceof Missing ? { state: 'missing' } : { state: 'error', message: (error as Error).message }
  }
}

/** Take down the handler at https://<name>/ if it's the daemon's: someone else's stays. */
export async function stopServe(daemon: Ours, socket?: string): Promise<void> {
  try {
    const name = nameOf(await status(socket))
    if (name && ours(await served(name, socket), daemon)) await tailscale(['serve', '--https=443', 'off'], socket)
  } catch { /* not installed or not running: nothing to take down */ }
}

/**
 * A device of the tailnet, as tailscaled knows it: its stable node ID (which outlives its addresses and keys), its
 * MagicDNS name (unique in the tailnet), and whose it is; a tagged one is no one's.
 */
export type TailnetNode = { id: string; name: string; os?: string; login?: string }

type WhoIs = {
  Node?: { StableID?: string; Name?: string; Tags?: string[] | null; Hostinfo?: { OS?: string; Hostname?: string } }
  UserProfile?: { LoginName?: string }
}

/** The tailnet device at `address` (what a request through serve came from, X-Forwarded-For); undefined if none is. */
export async function whois(address: string, socket?: string): Promise<TailnetNode | undefined> {
  let found: WhoIs
  try { found = JSON.parse(await tailscale(['whois', '--json', address], socket)) as WhoIs } catch (error) {
    if (/peer not found|no match/i.test((error as Error).message)) return undefined
    throw error
  }
  const node = found.Node
  if (!node?.StableID) return undefined
  const name = node.Name?.split('.')[0] || node.Hostinfo?.Hostname || node.StableID
  const login = node.Tags?.length ? undefined : found.UserProfile?.LoginName
  return { id: node.StableID, name, ...(node.Hostinfo?.OS ? { os: node.Hostinfo.OS } : {}), ...(login ? { login } : {}) }
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

/**
 * A tailnet this machine is on, for telling an agent its real names (see where.ts): the tailnet's name, the machine's
 * MagicDNS name on it, and the other devices on it by their computers' hostnames and MagicDNS names (lowercase), to
 * tell which tailnet a window's computer is on.
 */
export type Tailnet = { tailnet?: string; name: string; peers: Set<string> }

/** The tailnets this machine's running tailscaleds are on: none without Tailscale. `failed`: one that couldn't be read. */
export async function tailnetsHere(failed: (socket: string | undefined, error: Error) => void): Promise<Tailnet[]> {
  const found = await Promise.all([undefined, ...otherInstances()].map(async (socket) => {
    try {
      const s = await status(socket)
      const name = nameOf(s)
      if (s.BackendState !== 'Running' || !name) return undefined
      const peers = new Set<string>()
      for (const peer of Object.values(s.Peer ?? {})) {
        if (peer.HostName) peers.add(peer.HostName.toLowerCase())
        const dns = peer.DNSName?.split('.')[0]
        if (dns) peers.add(dns.toLowerCase())
      }
      return { ...(s.CurrentTailnet?.Name ? { tailnet: s.CurrentTailnet.Name } : {}), name, peers }
    } catch (error) {
      // Not installed: no tailnet, nothing wrong.
      if (!(error instanceof Missing)) failed(socket, error as Error)
      return undefined
    }
  }))
  return found.filter((t): t is Tailnet => Boolean(t))
}

/**
 * The tailnets this machine is on, as last read: asked of tailscaled in the background as it's made, then again at most
 * once in `every` ms as it's asked, so reading it is free and never waits (the agent's prompt asks on every request).
 * Read from the start, so the first prompt has them as every later one does (a prompt that changes loses its cache).
 */
export function watchTailnets(every = 60_000, read = tailnetsHere): () => Tailnet[] {
  let known: Tailnet[] = []
  let at = -Infinity
  let reading = false
  /** What failed last, by socket: said once, not every minute. */
  const said = new Map<string, string>()
  const failed = (socket: string | undefined, error: Error) => {
    const key = socket ?? 'default'
    if (said.get(key) === error.message) return
    said.set(key, error.message)
    console.warn(`Couldn't read the tailscaled at ${socket ?? 'the default socket'}: ${error.message}`)
  }
  const refresh = () => {
    if (reading || Date.now() - at < every) return
    reading = true
    at = Date.now()
    read(failed).then((next) => { known = next }, (error: Error) => failed(undefined, error)).finally(() => { reading = false })
  }
  refresh()
  return () => { refresh(); return known }
}
