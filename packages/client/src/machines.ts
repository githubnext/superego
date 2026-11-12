// The machines a client connects to besides this computer, kept in `machines.json` in Superego's data dir. The app and the
// CLI share the file; each notices the other's changes.
import { randomUUID } from 'node:crypto'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RpcError } from '@superego/protocol'
import type { MachineConfig } from './shared.ts'

export class MachineStore {
  #path: string
  #machines: MachineConfig[]
  #listeners = new Set<() => void>()

  #watcher: FSWatcher | undefined

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'machines.json')
    this.#machines = this.#read()
  }

  #read(): MachineConfig[] {
    try { return JSON.parse(readFileSync(this.#path, 'utf8')) } catch { return [] }
  }

  /** Reload when another process changes the file. Watches the directory, since saves replace the file. */
  watch() {
    if (this.#watcher) return
    const name = this.#path.split('/').at(-1)!
    mkdirSync(this.#path.slice(0, -name.length - 1), { recursive: true, mode: 0o700 })
    this.#watcher = watch(this.#path.slice(0, -name.length - 1), (_event, file) => {
      if (file !== name) return
      const next = this.#read()
      if (JSON.stringify(next) === JSON.stringify(this.#machines)) return
      this.#machines = next
      for (const listener of this.#listeners) listener()
    })
  }

  close() { this.#watcher?.close() }

  /** A machine by id, or by its name when that is unambiguous. */
  find(nameOrId: string): MachineConfig | undefined {
    const byId = this.#machines.find((m) => m.id === nameOrId || m.id.startsWith(nameOrId) && nameOrId.length >= 6)
    if (byId) return { ...byId }
    const byLabel = this.#machines.filter((m) => m.label.toLowerCase() === nameOrId.toLowerCase())
    if (byLabel.length > 1) throw new RpcError('ambiguous', `More than one machine is called ${nameOrId}; use its id`)
    return byLabel[0] && { ...byLabel[0] }
  }

  list(): MachineConfig[] { return this.#machines.map((m) => ({ ...m })) }
  onChange(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }

  async add(input: { label?: string; target?: string; command?: string; via?: string }): Promise<MachineConfig> {
    const target = input.target?.trim() ?? ''
    const via = input.via?.trim()
    if (!via && !target) throw new RpcError('invalid', 'An ssh target is needed, like user@host or a Host from ~/.ssh/config')
    if (target.startsWith('-')) throw new RpcError('invalid', 'An ssh target cannot start with "-"')
    const machine: MachineConfig = {
      id: randomUUID(), label: input.label?.trim() || target || via!, target, enabled: true,
      ...(via ? { via } : input.command?.trim() ? { command: input.command.trim() } : {}),
    }
    this.#machines = [...this.#machines, machine]
    await this.#save()
    return machine
  }

  get(id: string): MachineConfig | undefined {
    const machine = this.#machines.find((m) => m.id === id)
    return machine && { ...machine }
  }

  /** Accept whichever machine answers at its target next, as when it was reinstalled or replaced. */
  async forgetIdentity(id: string) {
    this.#machines = this.#machines.map((m) => { if (m.id !== id) return m; const { daemonId: _, ...rest } = m; return rest })
    await this.#save()
  }

  async update(id: string, patch: Partial<Pick<MachineConfig, 'label' | 'target' | 'command' | 'enabled' | 'daemonId'>>) {
    const current = this.#machines.find((m) => m.id === id)
    if (!current) throw new RpcError('not_found', `No machine ${id}`)
    const next = { ...current, ...patch }
    if (patch.target !== undefined && !next.via && (!next.target.trim() || next.target.startsWith('-'))) throw new RpcError('invalid', 'Invalid ssh target')
    if (!next.command?.trim()) delete next.command
    this.#machines = this.#machines.map((m) => m.id === id ? next : m)
    await this.#save()
  }

  async remove(id: string) {
    this.#machines = this.#machines.filter((m) => m.id !== id)
    await this.#save()
  }

  async #save() {
    await mkdir(this.#path.slice(0, this.#path.lastIndexOf('/')), { recursive: true, mode: 0o700 })
    const temp = `${this.#path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.#machines, null, 2) + '\n', { mode: 0o600 })
    await rename(temp, this.#path)
    for (const listener of this.#listeners) listener()
  }
}
