// Who may use this machine from a browser: devices paired with a one-time ticket (a link, or a short code typed in),
// each holding a random secret in an HttpOnly cookie; and, through Tailscale serve, the owner's own tailnet devices the
// user approved, each by its stable node ID. The data dir (`web.json`) keeps only the secrets' hashes, with each
// device's name, when it was paired (or approved) and last seen, and from where. A device unused for 90 days stops
// working.
//
// The owner's Tailscale login alone admits nothing: the machines the user runs agents on are usually logged in as them
// too, and an agent there mustn't reach back. A device of theirs that asks is kept as waiting (`knock`) until the user
// approves it from somewhere already in (Settings → Web access), or it pairs with a code like any other.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TailnetNode } from './tailscale.ts'
import { writeQueue } from './write-atomic.ts'

export const DEVICE_COOKIE = 'superego-device'
/** How long a pairing ticket (its link and its code) lasts. */
export const TICKET_TTL = 5 * 60_000
/** How long a device lasts unused. */
export const DEVICE_TTL = 90 * 24 * 60 * 60_000
/** How long an owner's tailnet device waits for approval after it last asked. */
export const WAITING_TTL = 24 * 60 * 60_000
/** The id of an owner's tailnet device, by its node ID. */
export const nodeDevice = (node: string) => `tailscale:${node}`
/** Failed pairings and wrong cookies an address may try in WINDOW before it's refused for the rest of it. */
export const FAILURES = 10
export const WINDOW = 10 * 60_000
/** Letters and digits nobody misreads, for codes typed on a phone. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

type Stored = { id: string; name: string; hash: string; created: number; lastSeen: number; address: string }
/** One of the owner's tailnet devices, by its stable node ID: waiting until `approved` (when the user approved it). */
type Node = { node: string; name: string; os?: string; created: number; lastSeen: number; address: string; approved?: number }
type State = { devices: Stored[]; nodes: Node[] }

/**
 * A device as Settings and the CLI show it: never its secret. An owner's tailnet device is `tailscale`, with its OS, and
 * `waiting` until approved.
 */
export type DeviceInfo = { id: string; name: string; created?: number; lastSeen: number; address: string; tailscale?: true; os?: string; waiting?: true }
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
  readonly #write: (text: string) => Promise<void>
  readonly #now: () => number
  #state: State
  readonly #tickets = new Map<string, { code: string; expires: number }>()
  readonly #failures = new Map<string, { count: number; until: number }>()
  readonly #revoked = new Set<(id: string) => void>()
  readonly #changed = new Set<() => void>()
  #saved = 0
  #saving: Promise<void> = Promise.resolve()

  constructor(dataDir: string, { now = Date.now }: { now?: () => number } = {}) {
    const path = join(dataDir, 'web.json')
    this.#write = writeQueue(path)
    this.#now = now
    this.#state = (() => {
      try {
        // What an earlier version kept of the owner's login (`tailscale`: every device it came from) is let go: those
        // devices got in by the login alone, so none of them was ever approved.
        const read = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>
        return { devices: read.devices ?? [], nodes: read.nodes ?? [] }
      } catch { return { devices: [], nodes: [] } }
    })()
  }

  /** Open the devices of `dataDir`. */
  static async open(dataDir: string, options?: { now?: () => number }): Promise<WebDevices> {
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

  /** Whether a device is still in: paired, or an owner's tailnet device approved. */
  has(id: string): boolean {
    this.#live()
    return this.#state.devices.some((d) => d.id === id) || this.#state.nodes.some((n) => n.approved && nodeDevice(n.node) === id)
  }

  /**
   * One of the owner's tailnet devices asks to come in, from `address`: whether it's approved. One not yet is kept as
   * waiting (and listed so), for the user to approve. Either way it's seen now, under the name Tailscale has for it.
   */
  knock(node: TailnetNode, address: string): boolean {
    this.#live()
    const entry = this.#state.nodes.find((n) => n.node === node.id)
    if (!entry) {
      const now = this.#now()
      this.#state.nodes.push({ node: node.id, name: node.name, ...(node.os ? { os: node.os } : {}), created: now, lastSeen: now, address })
      void this.#save()
      return false
    }
    if (entry.name !== node.name || entry.os !== node.os) {
      entry.name = node.name
      if (node.os) entry.os = node.os
      else delete entry.os
      entry.address = address
      entry.lastSeen = this.#now()
      void this.#save()
    } else this.#seen(entry, address)
    return Boolean(entry.approved)
  }

  /** Let a waiting tailnet device in: it is, from its next request on. */
  async approve(id: string): Promise<DeviceInfo | undefined> {
    this.#live()
    const entry = this.#state.nodes.find((n) => nodeDevice(n.node) === id)
    if (!entry) return undefined
    entry.approved ??= this.#now()
    await this.#save()
    return nodeInfo(entry)
  }

  /** Devices waiting first, then the rest, most recently seen first. */
  list(): DeviceInfo[] {
    return [...this.#live().map(info), ...this.#state.nodes.map(nodeInfo)]
      .sort((a, b) => Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || b.lastSeen - a.lastSeen)
  }

  /**
   * Unpair a device, or let go of an owner's tailnet device (approved or waiting): its cookie or its approval stops
   * working, and its open connections close (see onRevoke).
   */
  async revoke(id: string): Promise<boolean> {
    const before = this.#state.devices.length + this.#state.nodes.length
    this.#state.devices = this.#state.devices.filter((d) => d.id !== id)
    this.#state.nodes = this.#state.nodes.filter((n) => nodeDevice(n.node) !== id)
    if (this.#state.devices.length + this.#state.nodes.length === before) return false
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
  /** Devices changed: one paired, approved, waiting, renamed, revoked, or first seen again after a while. */
  onChange(listener: () => void): () => void { this.#changed.add(listener); return () => { this.#changed.delete(listener) } }
  /** Once what's changed is written: seeing a device saves it in the background. */
  saved(): Promise<void> { return this.#saving }

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

  /** Paired devices not yet expired; expired ones, and tailnet devices unused (or waiting) too long, are forgotten. */
  #live(): Stored[] {
    const now = this.#now()
    const expired = (d: { lastSeen: number }) => d.lastSeen <= now - DEVICE_TTL
    const gone = [
      ...this.#state.devices.filter(expired).map((d) => d.id),
      ...this.#state.nodes.filter((n) => n.approved ? expired(n) : n.lastSeen <= now - WAITING_TTL).map((n) => nodeDevice(n.node)),
    ]
    if (gone.length) {
      this.#state.devices = this.#state.devices.filter((d) => !gone.includes(d.id))
      this.#state.nodes = this.#state.nodes.filter((n) => !gone.includes(nodeDevice(n.node)))
      void this.#save()
      for (const id of gone) for (const listener of this.#revoked) listener(id)
    }
    return this.#state.devices
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
    this.#saving = this.#write(JSON.stringify(this.#state, null, 2) + '\n')
      .catch((error: Error) => console.error(`Keeping paired devices: ${error.message}`))
    for (const listener of this.#changed) listener()
    return this.#saving
  }
}

const info = (device: Stored): DeviceInfo => ({ id: device.id, name: device.name, created: device.created, lastSeen: device.lastSeen, address: device.address })
const nodeInfo = (node: Node): DeviceInfo => ({
  id: nodeDevice(node.node), name: node.name, created: node.approved ?? node.created, lastSeen: node.lastSeen, address: node.address, tailscale: true,
  ...(node.os ? { os: node.os } : {}), ...(node.approved ? {} : { waiting: true as const }),
})
