// The secrets of MCP servers, in `<dataDir>/mcp-auth.json`: only the user can read it (0600), changes are one at a
// time, and each replaces the file atomically, as the provider credentials' `auth.json` (agent-settings.ts). A sibling
// of that file, not in it: pi-ai reads every entry there as a provider. Nothing here ever reaches a client.
//
//   server:<id>               the values of a server's secrets: `key` (API key), or each of `auth.names` (env)
//   oauth:<resource>          OAuth tokens, by the server's canonical URL (lane 3)
//   client:<issuer> <redirect>  a client registration and its discovery state (lane 3)
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { Json } from '@superego/protocol'

export type StoreEntries = Record<string, Json>

export class SecretStore {
  readonly path: string
  #queue: Promise<unknown> = Promise.resolve()
  /** Every value stored, for redacting logs: kept as the file was last read or written here. */
  #values = new Set<string>()
  constructor(path: string) { this.path = path }

  read<T extends Json>(key: string): Promise<T | undefined> { return this.#serial(async () => (await this.#load())[key] as T | undefined) }
  keys(): Promise<string[]> { return this.#serial(async () => Object.keys(await this.#load())) }

  /**
   * Change one entry, under the store's lock: `edit` gets it as it is, and returns it as it should be (`undefined`
   * removes it). Two changes never interleave, so a refresh token is never used twice.
   */
  modify<T extends Json>(key: string, edit: (current: T | undefined) => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
    return this.#serial(async () => {
      const all = await this.#load()
      const next = await edit(all[key] as T | undefined)
      if (next === undefined) delete all[key]
      else all[key] = next
      await this.#save(all)
      return next
    })
  }

  delete(key: string) { return this.modify(key, () => undefined) }

  /** The secret values known, longest first, for `redact`. */
  secrets(): string[] { return [...this.#values].sort((a, b) => b.length - a.length) }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task)
    this.#queue = run.catch(() => {})
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

  /** Every string in it of a length worth hiding: keys, tokens, secret values. */
  #remember(all: StoreEntries) {
    const walk = (value: Json | undefined): void => {
      if (typeof value === 'string') { if (value.length >= 6) this.#values.add(value) } else if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') Object.values(value).forEach(walk)
    }
    walk(all)
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
