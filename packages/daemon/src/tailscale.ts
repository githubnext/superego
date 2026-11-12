// Web access through Tailscale: `tailscale serve` gives the machine an HTTPS address on the tailnet and proxies to
// the daemon, adding who is calling (Tailscale-User-Login, Tailscale-User-Name). Those callers need no pairing; the
// daemon admits the logins this machine allows: the owner of this tailnet node, and any a setting adds.
//
// The limit: the headers are only as trustworthy as the path they came by. Anyone who can connect to the daemon's
// listener directly can write them. So in this mode the daemon doesn't listen on TCP at all, but on a unix socket in
// its data dir (mode 0600), which `tailscale serve` proxies to: only this user and tailscaled (root) can connect, and
// a process running as this user can already do anything the daemon can. The headers are read in this mode only;
// on the TCP listeners they are ignored. Not verified here: whether the Mac App Store build of Tailscale (sandboxed)
// may proxy to a unix socket. If it can't, use "To this computer" with `tailscale serve <port>`: HTTPS still, with pairing.
import { execFile } from 'node:child_process'
import type { IncomingHttpHeaders } from 'node:http'

/** Where the CLI may be: on PATH, or inside the Mac app (the standalone and App Store builds both ship it there). */
const CLIS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

export type TailscaleNode = {
  /** The login of the user who owns this node; none for a tagged node, which no person owns. */
  owner?: string
  /** This node's name on the tailnet, like `box.tailnet.ts.net`. */
  dnsName?: string
}

/** This node, as `tailscale status --json` reports it; undefined when Tailscale isn't installed or running. */
export async function tailscaleNode(): Promise<TailscaleNode | undefined> {
  for (const cli of CLIS) {
    const out = await new Promise<string | undefined>((resolve) => {
      execFile(cli, ['status', '--json'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout))
    })
    if (!out) continue
    try {
      const status = JSON.parse(out) as { BackendState?: string; Self?: { UserID?: number; DNSName?: string; Tags?: string[] }; User?: Record<string, { LoginName?: string }> }
      if (status.BackendState !== 'Running' || !status.Self) return undefined
      const self = status.Self
      const owner = self.Tags?.length ? undefined : status.User?.[String(self.UserID)]?.LoginName
      return { ...(owner ? { owner } : {}), ...(self.DNSName ? { dnsName: self.DNSName.replace(/\.$/, '') } : {}) }
    } catch { return undefined }
  }
  return undefined
}

/** The command that puts the daemon's socket behind HTTPS on the tailnet, at `port`. Shown in Settings, never run. */
export const serveCommand = (socket: string, port: number) => `tailscale serve --bg --https=${port} unix:${socket}`

/**
 * Who `tailscale serve` says is calling. Names that aren't ASCII arrive as RFC 2047 words (`=?utf-8?q?…?=`); tagged
 * devices and Funnel (the public internet) send no login.
 */
export function tailscaleCaller(headers: IncomingHttpHeaders): { login: string; name: string } | undefined {
  const login = one(headers['tailscale-user-login'])
  if (!login) return undefined
  return { login: decodeWord(login), name: decodeWord(one(headers['tailscale-user-name']) ?? login) }
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || undefined

function decodeWord(value: string): string {
  const match = /^=\?utf-8\?([qb])\?(.*)\?=$/i.exec(value)
  if (!match) return value
  const [, encoding, text] = match
  if (encoding!.toLowerCase() === 'b') return Buffer.from(text!, 'base64').toString('utf8')
  return Buffer.from(text!.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8')
}

/** The logins this machine admits: its owner's, and those in `extra` (commas or spaces between). Case doesn't matter. */
export function allowedLogins(owner: string | undefined, extra: string): Set<string> {
  return new Set([owner, ...extra.split(/[\s,]+/)].filter((login): login is string => Boolean(login)).map((login) => login.toLowerCase()))
}
