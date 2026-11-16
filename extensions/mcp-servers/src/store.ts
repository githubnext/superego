// The secrets of MCP servers, in `<dataDir>/mcp-auth.json`: only the user can read it (0600), changes to a key are one
// at a time (locked per key, never the whole file), and each replaces the file atomically, as the provider credentials'
// `auth.json` (agent-settings.ts). A sibling of that file, not in it: pi-ai reads every entry there as a provider.
// Nothing here ever reaches a client.
//
//   server:<id>               the values of a server's secrets: `key` (API key), or each of `auth.names` (env)
//   oauth:<resource>          OAuth tokens, by the server's canonical URL
//   client:<issuer> <redirect>  a client registration and its discovery state
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { Json } from '@superego/protocol'

export type StoreEntries = Record<string, Json>

/** The fields of an entry that are secret, wherever they are in it; and every value of a `server:` entry. */
const SECRET_FIELDS = new Set(['access_token', 'refresh_token', 'client_secret'])

export class SecretStore {
  readonly path: string
  /** Each key's changes, one at a time: the tail of its queue. */
  #locks = new Map<string, Promise<unknown>>()
  /** Writing the file, one at a time (never with anything slow inside). */
  #writes: Promise<unknown> = Promise.resolve()
  /** Every secret value stored, for redacting logs: kept as the file was last read or written here. */
  #values = new Set<string>()
  constructor(path: string) { this.path = path }

  /**
   * An entry as the file has it now. Never waits on a change: the file is replaced whole, so a read sees it before or
   * after one, and a key whose change is slow (a token being refreshed) holds up nothing but that key's changes.
   */
  async read<T extends Json>(key: string): Promise<T | undefined> { return (await this.#load())[key] as T | undefined }
  async keys(): Promise<string[]> { return Object.keys(await this.#load()) }

  /**
   * Change one entry, under that key's lock: `edit` gets it as it is, and returns it as it should be (`undefined`
   * removes it). Two changes to a key never interleave, so a refresh token is never used twice; changes to other keys
   * go on meanwhile, and only the file's write itself is one at a time.
   */
  modify<T extends Json>(key: string, edit: (current: T | undefined) => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
    const run = (this.#locks.get(key) ?? Promise.resolve()).then(async () => {
      const next = await edit((await this.#load())[key] as T | undefined)
      await this.#write((all) => {
        if (next === undefined) delete all[key]
        else all[key] = next
      })
      return next
    })
    const tail = run.catch(() => {})
    this.#locks.set(key, tail)
    void tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key) })
    return run
  }

  delete(key: string) { return this.modify(key, () => undefined) }

  /** The secret values known, longest first, for `redact`. */
  secrets(): string[] { return [...this.#values].sort((a, b) => b.length - a.length) }

  /** The file read again and changed, as one write after any before it. */
  #write(change: (all: StoreEntries) => void): Promise<void> {
    const run = this.#writes.then(async () => {
      const all = await this.#load()
      change(all)
      await this.#save(all)
    })
    this.#writes = run.catch(() => {})
    return run
  }

  async #load(): Promise<StoreEntries> {
    try {
      const all = JSON.parse(await readFile(this.path, 'utf8')) as StoreEntries
      this.#remember(all)
      return all
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  async #save(all: StoreEntries) {
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(all, null, 2), { mode: 0o600 })
    await rename(temp, this.path)
    this.#remember(all)
  }

  /** The secrets in it: every value of a server's secrets (not its `@` fields), and tokens and client secrets wherever they are. */
  #remember(all: StoreEntries) {
    const add = (value: Json | undefined) => { if (typeof value === 'string' && value !== '') this.#values.add(value) }
    const walk = (value: Json | undefined): void => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') {
        for (const [field, inner] of Object.entries(value)) {
          if (SECRET_FIELDS.has(field)) add(inner)
          else walk(inner)
        }
      }
    }
    for (const [key, value] of Object.entries(all)) {
      // A server's secrets, by name; a field starting `@` is bookkeeping, not a secret (`@for`: where they were set for).
      if (key.startsWith('server:') && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, secret] of Object.entries(value)) if (!name.startsWith('@')) add(secret)
      }
      else walk(value)
    }
  }
}

/** A server's entry: the values of its secrets, by name. */
export type ServerSecrets = Record<string, string>
export const serverKey = (id: string) => `server:${id}`

/** `text` with every secret value in `secrets` replaced with `***`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join('***')
  return out
}
