// Who may use Web access: browsers paired with this machine, each with a credential of its own. Settings makes a
// one-time code; the page trades it (POST /pair) for a credential it keeps in its own localStorage, which only pages of
// that exact origin (scheme, host and port) can read. Only a hash of each credential is kept here, in
// `web-devices.json`, so the file alone lets nobody in. Revoking a device forgets it. And tickets: short-lived,
// read-only addresses for one thread's artifacts, which an iframe can load without the credential.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WebDevice } from '@superego/protocol'

const sha256 = (text: string) => createHash('sha256').update(text).digest()
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

type Stored = WebDevice & { hash: string }

export class Devices {
  #path: string
  #devices = new Map<string, Stored>()
  #listeners = new Set<() => void>()
  #saving: ReturnType<typeof setTimeout> | undefined
  #written: Promise<void> = Promise.resolve()
  #dirty = false

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'web-devices.json')
    try {
      for (const device of JSON.parse(readFileSync(this.#path, 'utf8')) as Stored[]) this.#devices.set(device.id, device)
    } catch { /* none yet */ }
  }

  list(): WebDevice[] {
    return [...this.#devices.values()].map(({ hash: _hash, ...device }) => device).sort((a, b) => a.created - b.created)
  }

  get(id: string): WebDevice | undefined { return this.list().find((device) => device.id === id) }

  /** A new device and its credential (`<id>.<secret>`), which is shown to nobody but the browser it's for. */
  add(name: string): { device: WebDevice; credential: string } {
    const id = randomBytes(6).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    const now = Date.now()
    const device: Stored = { id, name: clean(name) || 'A browser', created: now, seen: now, hash: sha256(secret).toString('hex') }
    this.#devices.set(id, device)
    this.#changed()
    return { device: this.get(id)!, credential: `${id}.${secret}` }
  }

  /** The device a credential belongs to, if any; it counts as seen now. The secret is compared by hash, in constant time. */
  verify(credential: string | undefined): WebDevice | undefined {
    const [id, secret] = (credential ?? '').split('.')
    const device = id && secret ? this.#devices.get(id) : undefined
    if (!device || !same(sha256(secret!), Buffer.from(device.hash, 'hex'))) return undefined
    // Seen is for Settings, not security: kept to the minute, so a busy browser doesn't rewrite the file all the time.
    if (Date.now() - device.seen > 60_000) { device.seen = Date.now(); this.#changed() }
    return this.get(id!)
  }

  rename(id: string, name: string): boolean {
    const device = this.#devices.get(id)
    if (!device || !clean(name)) return false
    device.name = clean(name)
    this.#changed()
    return true
  }

  /** Forget a device; saved at once, not with the next batch (`flush` to wait for it). */
  revoke(id: string): boolean {
    const had = this.#devices.delete(id)
    if (had) { this.#changed(); void this.flush().catch(() => {}) }
    return had
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Written soon after a change, together with any others: to a temporary file renamed over the old, so a crash
   * mid-write leaves one or the other whole. One write at a time, each of the state when it starts; none when nothing
   * changed.
   */
  flush(): Promise<void> {
    clearTimeout(this.#saving)
    this.#saving = undefined
    if (!this.#dirty) return this.#written
    this.#dirty = false
    const write = async () => {
      const temporary = `${this.#path}.tmp`
      await writeFile(temporary, JSON.stringify([...this.#devices.values()], null, 2) + '\n', { mode: 0o600 })
      await rename(temporary, this.#path)
    }
    this.#written = this.#written.then(write, write)
    return this.#written
  }

  #changed() {
    this.#dirty = true
    for (const listener of this.#listeners) listener()
    if (this.#saving) return
    this.#saving = setTimeout(() => void this.flush().catch(() => {}), 100)
  }
}

/** A device name as people type it: one line, not too long. */
const clean = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, 60)

/** A name for a browser from its user agent, until someone renames it: "Safari on iPhone". */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser'
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : undefined
  return system ? `${browser} on ${system}` : browser
}

// Codes people read off one screen and type on another: no 0/O or 1/I/L to confuse.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
/** A typed code as issued: capitals, without the dash or spaces. */
const normalize = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '')

/**
 * One-time pairing codes, in memory only: each works once, for `ttl`. Eight characters of 31 is about 40 bits. Wrong
 * tries count against the caller who made them (its address): after `tries` within `ttl` it is turned away until its
 * oldest miss is that old, without touching anyone else's codes.
 */
export class PairingCodes {
  #codes = new Map<string, number>()
  #misses = new Map<string, number[]>()
  readonly ttl: number
  readonly tries: number

  constructor({ ttl = 5 * 60_000, tries = 10 }: { ttl?: number; tries?: number } = {}) { this.ttl = ttl; this.tries = tries }

  issue(): { code: string; expires: number } {
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const expires = Date.now() + this.ttl
    this.#codes.set(sha256(raw).toString('hex'), expires)
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires }
  }

  /** Whether `caller` has missed too often lately to be heard. */
  limited(caller = ''): boolean {
    return this.#recent(caller).length >= this.tries
  }

  /** Whether `code` is open; if so it is used up. A caller that is `limited` is not heard at all. */
  take(code: string, caller = ''): boolean {
    if (this.limited(caller)) return false
    const now = Date.now()
    const given = sha256(normalize(code))
    let found: string | undefined
    for (const [hash, expires] of this.#codes) {
      if (expires <= now) { this.#codes.delete(hash); continue }
      if (same(given, Buffer.from(hash, 'hex'))) found = hash
    }
    if (found) { this.#codes.delete(found); return true }
    this.#misses.set(caller, [...this.#recent(caller), now])
    return false
  }

  #recent(caller: string): number[] {
    const since = Date.now() - this.ttl
    const recent = (this.#misses.get(caller) ?? []).filter((at) => at > since)
    if (recent.length) this.#misses.set(caller, recent)
    else this.#misses.delete(caller)
    return recent
  }
}

/** Whose a ticket is: a paired device, or a Tailscale login. */
export type Holder = { device: string } | { login: string }

/** How long an artifact ticket works. A pane that outlives it asks for another when reloaded. */
export const TICKET_TTL = 60 * 60_000

/**
 * Artifact tickets: an address for one thread's artifacts (on this machine or one it reaches), read-only, for an hour.
 * The page asks for one over its authenticated socket and loads `/artifact/<ticket>/<path>`, so the artifact's
 * relative links keep working. Revoking the device (or a login losing its place) ends its tickets.
 */
export class Tickets {
  #tickets = new Map<string, { thread: string; machine?: string; holder: Holder; expires: number }>()
  readonly ttl: number

  constructor({ ttl = TICKET_TTL }: { ttl?: number } = {}) { this.ttl = ttl }

  issue(thread: string, machine: string | undefined, holder: Holder): { ticket: string; expires: number } {
    const now = Date.now()
    for (const [ticket, entry] of this.#tickets) if (entry.expires <= now) this.#tickets.delete(ticket)
    const ticket = randomBytes(24).toString('base64url')
    const expires = now + this.ttl
    this.#tickets.set(ticket, { thread, ...(machine ? { machine } : {}), holder, expires })
    return { ticket, expires }
  }

  get(ticket: string) {
    const entry = this.#tickets.get(ticket)
    if (entry && entry.expires > Date.now()) return entry
    this.#tickets.delete(ticket)
    return undefined
  }

  /** End every ticket of `holder`. */
  drop(holder: Holder) {
    for (const [ticket, entry] of this.#tickets) if (sameHolder(entry.holder, holder)) this.#tickets.delete(ticket)
  }

  holders(): Holder[] { return [...this.#tickets.values()].map((entry) => entry.holder) }
}

export const sameHolder = (a: Holder, b: Holder) => 'device' in a ? 'device' in b && a.device === b.device : 'login' in b && a.login === b.login
