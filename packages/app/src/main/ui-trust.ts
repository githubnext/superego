// The allowed remote profile UIs (see ../ui-trust.ts), kept in `ui-trust.json` in the data dir, readable by this user only.
import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sameGrant, type UiGrant } from '../ui-trust.ts'

export class UiTrust {
  #path: string
  #grants: UiGrant[]

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'ui-trust.json')
    this.#grants = this.#read()
  }

  #read(): UiGrant[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter((g): g is UiGrant => [g?.machine, g?.dir, g?.hash].every((v) => typeof v === 'string')) : []
    } catch { return [] }
  }

  list(): UiGrant[] { return this.#grants.map((g) => ({ ...g })) }

  /** Allow one version of a profile's UI; an earlier version of the same profile from that machine is replaced. */
  async allow({ machine, dir, hash }: UiGrant) {
    this.#grants = [...this.#grants.filter((g) => !(g.machine === machine && g.dir === dir)), { machine, dir, hash }]
    await this.#save()
  }

  async forget(grant: UiGrant) {
    this.#grants = this.#grants.filter((g) => !sameGrant(g, grant))
    await this.#save()
  }

  async #save() {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
    const temp = `${this.#path}.tmp`
    await writeFile(temp, JSON.stringify(this.#grants, null, 2), { mode: 0o600 })
    await rename(temp, this.#path)
  }
}
