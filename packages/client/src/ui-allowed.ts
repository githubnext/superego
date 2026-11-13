// The profile UIs from other machines this computer lets run in its window, kept in `ui-allowed.json` in Superego's data
// dir: one entry per machine and profile, for the hash of the sources allowed. The app and the CLI share the file; each
// notices the other's changes.
import { mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAllowed, type AllowedUi } from './profile-ui.ts'

export class UiAllowStore {
  #dir: string
  #path: string
  #list: AllowedUi[]
  #listeners = new Set<() => void>()
  #watcher: FSWatcher | undefined

  constructor(dataDir: string) {
    this.#dir = dataDir
    this.#path = join(dataDir, 'ui-allowed.json')
    this.#list = this.#read()
  }

  #read(): AllowedUi[] {
    try { return JSON.parse(readFileSync(this.#path, 'utf8')) } catch { return [] }
  }

  /** Reload when another process changes the file. Watches the directory, since saves replace the file. */
  watch() {
    if (this.#watcher) return
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    this.#watcher = watch(this.#dir, (_event, file) => {
      if (file !== 'ui-allowed.json') return
      const next = this.#read()
      if (JSON.stringify(next) === JSON.stringify(this.#list)) return
      this.#list = next
      for (const listener of this.#listeners) listener()
    })
  }

  close() { this.#watcher?.close() }
  list(): AllowedUi[] { return this.#list.map((a) => ({ ...a })) }
  onChange(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  allowed(machine: string, dir: string, hash: string) { return isAllowed(this.#list, machine, dir, hash) }

  /** Allow these sources of a profile from a machine, in place of any it allowed before. */
  async allow(entry: Omit<AllowedUi, 'at'> & { at?: number }) {
    const rest = this.#list.filter((a) => !(a.machine === entry.machine && a.profile.dir === entry.profile.dir))
    this.#list = [...rest, { ...entry, at: entry.at ?? Date.now() }]
    await this.#save()
  }

  /** No UI of that profile runs here any more; without `dir`, none of the machine's. */
  async revoke(machine: string, dir?: string) {
    const next = this.#list.filter((a) => !(a.machine === machine && (dir === undefined || a.profile.dir === dir)))
    if (next.length === this.#list.length) return
    this.#list = next
    await this.#save()
  }

  async #save() {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 })
    const temp = `${this.#path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.#list, null, 2) + '\n', { mode: 0o600 })
    await rename(temp, this.#path)
    for (const listener of this.#listeners) listener()
  }
}
