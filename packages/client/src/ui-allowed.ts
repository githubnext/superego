// The profile UIs from other machines this computer lets run in its window, kept in `ui-allowed.json` in Superego's data
// dir: one entry per machine and profile, for the hash of the sources allowed. Beside it, `ui-declined.json`: the ones
// put off ("Not now"), for the hash declined, so the window doesn't ask again until that code changes. A file of its own
// so that nothing reading the allowed list (an older app or CLI) can take a declined entry for an allowed one. A profile
// is in one of them at most. The app and the CLI share the files; each notices the other's changes.
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { watchFiles } from '@superego/daemon/client'
import { isAllowed, type AllowedUi } from './profile-ui.ts'

const ALLOWED = 'ui-allowed.json'
const DECLINED = 'ui-declined.json'
type Entry = Omit<AllowedUi, 'at'> & { at?: number }

export class UiAllowStore {
  #dir: string
  #allowed: AllowedUi[]
  #declined: AllowedUi[]
  #listeners = new Set<() => void>()
  #watcher: { close(): void } | undefined

  constructor(dataDir: string) {
    this.#dir = dataDir
    this.#allowed = this.#read(ALLOWED)
    this.#declined = this.#read(DECLINED)
  }

  #read(file: string): AllowedUi[] {
    try { return JSON.parse(readFileSync(join(this.#dir, file), 'utf8')) } catch { return [] }
  }

  /** Reload when another process changes a file. Watches the directory, since saves replace the file. */
  watch() {
    if (this.#watcher) return
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    this.#watcher = watchFiles(this.#dir, [ALLOWED, DECLINED], (file) => {
      const next = this.#read(file)
      const list = file === ALLOWED ? this.#allowed : this.#declined
      if (JSON.stringify(next) === JSON.stringify(list)) return
      if (file === ALLOWED) this.#allowed = next
      else this.#declined = next
      for (const listener of this.#listeners) listener()
    })
  }

  close() { this.#watcher?.close() }
  list(): AllowedUi[] { return this.#allowed.map((a) => ({ ...a })) }
  /** The ones put off ("Not now"), each for the sources it was then. */
  declinedList(): AllowedUi[] { return this.#declined.map((a) => ({ ...a })) }
  onChange(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  allowed(machine: string, dir: string, hash: string) { return isAllowed(this.#allowed, machine, dir, hash) }
  declined(machine: string, dir: string, hash: string) { return isAllowed(this.#declined, machine, dir, hash) }

  /** Allow these sources of a profile from a machine, in place of any it allowed (or declined) before. */
  async allow(entry: Entry) { await this.#set(entry, 'allowed') }

  /** Not now: don't ask again about these sources of a profile; in place of any it allowed (or declined) before. */
  async decline(entry: Entry) { await this.#set(entry, 'declined') }

  async #set(entry: Entry, as: 'allowed' | 'declined') {
    const other = (a: AllowedUi) => !(a.machine === entry.machine && a.profile.dir === entry.profile.dir)
    const added = { ...entry, at: entry.at ?? Date.now() }
    const allowed = [...this.#allowed.filter(other), ...as === 'allowed' ? [added] : []]
    const declined = [...this.#declined.filter(other), ...as === 'declined' ? [added] : []]
    await this.#save(allowed, declined)
  }

  /** No UI of that profile runs here any more, and the window asks again; without `dir`, none of the machine's. */
  async revoke(machine: string, dir?: string) {
    const keep = (a: AllowedUi) => !(a.machine === machine && (dir === undefined || a.profile.dir === dir))
    await this.#save(this.#allowed.filter(keep), this.#declined.filter(keep))
  }

  async #save(allowed: AllowedUi[], declined: AllowedUi[]) {
    const changed = [[ALLOWED, this.#allowed, allowed], [DECLINED, this.#declined, declined]] as const
    const writes = changed.filter(([, was, next]) => JSON.stringify(was) !== JSON.stringify(next))
    if (!writes.length) return
    this.#allowed = allowed
    this.#declined = declined
    await mkdir(this.#dir, { recursive: true, mode: 0o700 })
    for (const [file, , list] of writes) {
      const path = join(this.#dir, file)
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 })
      await rename(temp, path)
    }
    for (const listener of this.#listeners) listener()
  }
}
