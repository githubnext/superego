// Who may use Web access: browsers paired with this machine, each with a credential of its own. Settings makes a
// one-time code; the page trades it (POST /pair) for a credential the browser keeps as an HttpOnly cookie. Only a hash
// of each credential is kept here, in `web-devices.json`, so the file alone lets nobody in. Revoking a device forgets it.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
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

  revoke(id: string): boolean {
    const had = this.#devices.delete(id)
    if (had) this.#changed()
    return had
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Written soon after a change, together with any others. */
  async flush() {
    clearTimeout(this.#saving)
    this.#saving = undefined
    await writeFile(this.#path, JSON.stringify([...this.#devices.values()], null, 2) + '\n', { mode: 0o600 })
  }

  #changed() {
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
 * One-time pairing codes, in memory only: each works once, for `ttl`. Eight characters of 31 is about 40 bits; after
 * a few wrong tries every open code is dropped, so guessing gets a handful of attempts per code Settings shows.
 */
export class PairingCodes {
  #codes = new Map<string, number>()
  #misses = 0
  readonly ttl: number
  readonly tries: number

  constructor({ ttl = 5 * 60_000, tries = 10 }: { ttl?: number; tries?: number } = {}) { this.ttl = ttl; this.tries = tries }

  issue(): { code: string; expires: number } {
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const expires = Date.now() + this.ttl
    this.#codes.set(sha256(raw).toString('hex'), expires)
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires }
  }

  /** Whether `code` is open; if so it is used up. */
  take(code: string): boolean {
    const now = Date.now()
    const given = sha256(normalize(code))
    let found: string | undefined
    for (const [hash, expires] of this.#codes) {
      if (expires <= now) { this.#codes.delete(hash); continue }
      if (same(given, Buffer.from(hash, 'hex'))) found = hash
    }
    if (found) { this.#codes.delete(found); this.#misses = 0; return true }
    if (++this.#misses >= this.tries) { this.#codes.clear(); this.#misses = 0 }
    return false
  }
}
