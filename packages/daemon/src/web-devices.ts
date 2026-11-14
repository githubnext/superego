// Who may use this machine from a browser: devices paired with a one-time ticket (a link, or a short code typed in),
// each holding a random secret in an HttpOnly cookie. The data dir keeps only the secrets' hashes (`web.json`), with each
// device's name, when it was paired and last seen, and from where. A device unused for 90 days stops working.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEVICE_COOKIE = 'superego-device'
/** How long a pairing ticket (its link and its code) lasts. */
export const TICKET_TTL = 5 * 60_000
/** How long a device lasts unused. */
export const DEVICE_TTL = 90 * 24 * 60 * 60_000
/** Failed pairings and wrong cookies an address may try in WINDOW before it's refused for the rest of it. */
export const FAILURES = 10
export const WINDOW = 10 * 60_000
/** Letters and digits nobody misreads, for codes typed on a phone. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

type Stored = { id: string; name: string; hash: string; created: number; lastSeen: number; address: string }
/** The owner's own Tailscale login, seen from one of their tailnet devices: admitted without pairing (see web.ts). */
type Seen = { node: string; lastSeen: number; address: string }
type State = { devices: Stored[]; tailscale: Seen[]; notice?: string }

/** A device as Settings and the CLI show it: never its secret. */
export type DeviceInfo = { id: string; name: string; created?: number; lastSeen: number; address: string; tailscale?: true }
export type Ticket = { ticket: string; code: string; expires: number }

const hash = (secret: string) => createHash('sha256').update(secret).digest()
const sameHash = (secret: string, stored: string) => { const a = hash(secret), b = Buffer.from(stored, 'hex'); return a.length === b.length && timingSafeEqual(a, b) }
/** A code as typed: `abcd efgh`, `ABCD-EFGH`. */
export const normalCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** A name for a device from its browser's User-Agent: "Safari on iPhone". */
export function deviceName(agent = ''): string {
  const device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android'
    : /CrOS/.test(agent) ? 'Chromebook' : /Macintosh|Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : undefined
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\/|FxiOS/.test(agent) ? 'Firefox' : /Electron\//.test(agent) ? 'Electron'
    : /Chrome\/|CriOS/.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : undefined
  return [browser, device].filter(Boolean).join(' on ') || 'A browser'
}

export class WebDevices {
  readonly #path: string
  readonly #now: () => number
  #state: State
  readonly #tickets = new Map<string, { code: string; expires: number }>()
  readonly #failures = new Map<string, { count: number; until: number }>()
  readonly #revoked = new Set<(id: string) => void>()
  readonly #changed = new Set<() => void>()
  #saved = 0
  #saving: Promise<void> = Promise.resolve()

  constructor(dataDir: string, { now = Date.now }: { now?: () => number } = {}) {
    this.#path = join(dataDir, 'web.json')
    this.#now = now
    this.#state = (() => {
      try {
        const read = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<State>
        return { devices: read.devices ?? [], tailscale: read.tailscale ?? [], ...(read.notice ? { notice: read.notice } : {}) }
      } catch { return { devices: [], tailscale: [] } }
    })()
  }

  /** Open the devices of `dataDir`, retiring the single token web access had before (`web-token`): it's no longer accepted. */
  static async open(dataDir: string, options?: { now?: () => number }): Promise<WebDevices> {
    await rm(join(dataDir, 'web-token'), { force: true })
    return new WebDevices(dataDir, options)
  }

  // ── Pairing ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A ticket to pair one device with: a link's (long) and a code to type (short), either one, once, for 5 minutes. */
  pair(): Ticket {
    this.#sweep()
    const ticket = randomBytes(24).toString('base64url')
    const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const expires = this.#now() + TICKET_TTL
    this.#tickets.set(ticket, { code, expires })
    return { ticket, code: `${code.slice(0, 4)}-${code.slice(4)}`, expires }
  }

  /**
   * Pair a device with a ticket or its code: a new device, and the cookie value that is it; undefined if neither is
   * (still) good. Either way the ticket is spent only by success.
   */
  async redeem(given: { ticket?: string; code?: string }, from: { agent?: string; address: string }): Promise<{ cookie: string; device: DeviceInfo } | undefined> {
    this.#sweep()
    const code = given.code ? normalCode(given.code) : undefined
    const found = given.ticket ? (this.#tickets.has(given.ticket) ? given.ticket : undefined)
      : code ? [...this.#tickets].find(([, t]) => t.code === code)?.[0] : undefined
    if (!found) return undefined
    this.#tickets.delete(found)
    const secret = randomBytes(32).toString('base64url')
    const now = this.#now()
    const device: Stored = { id: randomBytes(9).toString('base64url'), name: deviceName(from.agent), hash: hash(secret).toString('hex'), created: now, lastSeen: now, address: from.address }
    this.#state.devices.push(device)
    await this.#save()
    return { cookie: `${device.id}.${secret}`, device: info(device) }
  }

  // ── Devices ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The device a cookie value is, if it's one still paired; seen now, from `address`. */
  check(cookie: string | undefined, address: string): DeviceInfo | undefined {
    if (!cookie) return undefined
    const [id, secret] = cookie.split('.')
    const device = this.#live().find((d) => d.id === id)
    if (!device || !secret || !sameHash(secret, device.hash)) return undefined
    this.#seen(device, address)
    return info(device)
  }

  /** Whether a device is still paired. */
  has(id: string): boolean { return this.#live().some((d) => d.id === id) }

  /** The owner's Tailscale login, from one of their tailnet devices: seen now. */
  seenOnTailscale(node: string, address: string): void {
    const entry = this.#state.tailscale.find((s) => s.node === node)
    if (entry) this.#seen(entry, address)
    else { this.#state.tailscale.push({ node, lastSeen: this.#now(), address }); void this.#save() }
  }

  /** Paired devices, most recently seen first; then the owner's Tailscale devices. */
  list(): DeviceInfo[] {
    const cutoff = this.#now() - DEVICE_TTL
    return [
      ...this.#live().map(info),
      ...this.#state.tailscale.filter((s) => s.lastSeen > cutoff).map((s): DeviceInfo => ({ id: `tailscale:${s.node}`, name: s.node, lastSeen: s.lastSeen, address: s.address, tailscale: true })),
    ].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** Unpair a device: its cookie stops working, and its open connections close (see onRevoke). */
  async revoke(id: string): Promise<boolean> {
    const before = this.#state.devices.length
    this.#state.devices = this.#state.devices.filter((d) => d.id !== id)
    if (this.#state.devices.length === before) return false
    await this.#save()
    for (const listener of this.#revoked) listener(id)
    return true
  }

  async rename(id: string, name: string): Promise<DeviceInfo | undefined> {
    const device = this.#live().find((d) => d.id === id)
    if (!device) return undefined
    device.name = name.trim().slice(0, 80) || device.name
    await this.#save()
    return info(device)
  }

  onRevoke(listener: (id: string) => void): () => void { this.#revoked.add(listener); return () => { this.#revoked.delete(listener) } }
  /** Devices changed: one paired, renamed, revoked, or first seen again after a while. */
  onChange(listener: () => void): () => void { this.#changed.add(listener); return () => { this.#changed.delete(listener) } }
  /** Once what's changed is written: seeing a device saves it in the background. */
  saved(): Promise<void> { return this.#saving }

  // ── Notice: why web access is off, after an update turned it off ─────────────────────────────────────────────────

  get notice(): string | undefined { return this.#state.notice }
  async setNotice(notice: string | undefined): Promise<void> {
    if (this.#state.notice === notice) return
    if (notice) this.#state.notice = notice
    else delete this.#state.notice
    await this.#save()
  }

  // ── Failed attempts, per address ─────────────────────────────────────────────────────────────────────────────────

  /** Whether `address` has failed too often lately to be heard. */
  limited(address: string): boolean {
    const entry = this.#failures.get(address)
    return Boolean(entry && entry.until > this.#now() && entry.count >= FAILURES)
  }

  /** A failed pairing or a wrong cookie from `address`. */
  failed(address: string): void {
    const now = this.#now()
    const entry = this.#failures.get(address)
    if (!entry || entry.until <= now) this.#failures.set(address, { count: 1, until: now + WINDOW })
    else entry.count++
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Devices not yet expired; expired ones are forgotten. */
  #live(): Stored[] {
    const cutoff = this.#now() - DEVICE_TTL
    const live = this.#state.devices.filter((d) => d.lastSeen > cutoff)
    if (live.length !== this.#state.devices.length) {
      const gone = this.#state.devices.filter((d) => d.lastSeen <= cutoff)
      this.#state.devices = live
      void this.#save()
      for (const device of gone) for (const listener of this.#revoked) listener(device.id)
    }
    const tailscale = this.#state.tailscale.filter((s) => s.lastSeen > cutoff)
    if (tailscale.length !== this.#state.tailscale.length) { this.#state.tailscale = tailscale; void this.#save() }
    return live
  }

  /** Seen now: kept at most once a minute (and at once when it's from somewhere new). */
  #seen(entry: { lastSeen: number; address: string }, address: string) {
    const now = this.#now()
    const moved = entry.address !== address
    entry.lastSeen = now
    entry.address = address
    if (moved || now - this.#saved > 60_000) void this.#save()
  }

  #sweep() {
    const now = this.#now()
    for (const [ticket, { expires }] of this.#tickets) if (expires <= now) this.#tickets.delete(ticket)
    for (const [address, { until }] of this.#failures) if (until <= now) this.#failures.delete(address)
  }

  #save(): Promise<void> {
    this.#saved = this.#now()
    const content = JSON.stringify(this.#state, null, 2) + '\n'
    this.#saving = this.#saving.then(() => writeFile(this.#path, content, { mode: 0o600 })).catch(() => {})
    for (const listener of this.#changed) listener()
    return this.#saving
  }
}

const info = (device: Stored): DeviceInfo => ({ id: device.id, name: device.name, created: device.created, lastSeen: device.lastSeen, address: device.address })
