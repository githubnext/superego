// The machines a client connects to besides this computer, kept in `machines.json` in Superego's data dir, and this
// computer's own colour, in `this-computer.json` beside it. The app, its daemon and the CLI share the files; each notices
// the others' changes. Every machine has a colour (shared.ts's withColours): one without is given the next when it's
// read, and the app and the daemon, which follow the files, save it.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { watchFiles } from '@superego/daemon/client'
import { RpcError } from '@superego/protocol'
import { isColour, nextColour, withColours, type MachineConfig } from './shared.ts'

/** This computer, as the store keeps it. */
type Here = { colour: number }

export class MachineStore {
  #path: string
  #herePath: string
  #machines: MachineConfig[]
  #here: Here
  #listeners = new Set<() => void>()

  #watcher: { close(): void } | undefined
  /** The saves under way, one at a time, each writing the list as it was when it was asked for. */
  #saving: Promise<void> = Promise.resolve()
  #unsaved = 0

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'machines.json')
    this.#herePath = join(dataDir, 'this-computer.json')
    ;({ machines: this.#machines, here: this.#here } = this.#read())
  }

  /** The files as they are, every machine given a colour; `uncoloured`, when one had none there. */
  #read(): { machines: MachineConfig[]; here: Here; uncoloured: boolean } {
    const json = (path: string, fallback: unknown) => {
      try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
    }
    const machines: MachineConfig[] = json(this.#path, [])
    const here: Partial<Here> = json(this.#herePath, {}) ?? {}
    const coloured = withColours(here.colour, machines)
    const uncoloured = !isColour(here.colour) || machines.some((m) => !isColour(m.colour))
    return { machines: coloured.machines, here: { ...here, colour: coloured.here }, uncoloured }
  }

  /** Save the colours just given, so they stay as they are: by the processes that follow the files. */
  #keepColours() {
    this.#save().catch((error) => console.error(`Saving the machines' colours: ${error instanceof Error ? error.message : String(error)}`))
  }

  /** Reload when another process changes the file. Watches the directory, since saves replace the file. */
  watch() {
    if (this.#watcher) return
    const name = this.#path.split('/').at(-1)!
    const dir = this.#path.slice(0, -name.length - 1)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (this.#read().uncoloured) this.#keepColours()
    this.#watcher = watchFiles(dir, [name, this.#herePath.split('/').at(-1)!], () => {
      // Read while a save is under way, the file is as it was before it: that would undo the change being saved. The
      // save's own rename is heard once it's done.
      if (this.#unsaved) return
      const next = this.#read()
      const changed = JSON.stringify([next.machines, next.here]) !== JSON.stringify([this.#machines, this.#here])
      this.#machines = next.machines
      this.#here = next.here
      if (next.uncoloured) this.#keepColours()
      else if (changed) for (const listener of this.#listeners) listener()
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
  /** This computer's colour. */
  hereColour(): number { return this.#here.colour }
  async setHereColour(colour: number) {
    if (!isColour(colour)) throw new RpcError('invalid', `No colour ${colour}`)
    this.#here = { ...this.#here, colour }
    await this.#save()
  }
  onChange(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }

  async add(input: { label?: string; target?: string; command?: string; via?: string }): Promise<MachineConfig> {
    const target = input.target?.trim() ?? ''
    const via = input.via?.trim()
    if (!via && !target) throw new RpcError('invalid', 'An ssh target is needed, like user@host or a Host from ~/.ssh/config')
    if (target.startsWith('-')) throw new RpcError('invalid', 'An ssh target cannot start with "-"')
    const machine: MachineConfig = {
      id: randomUUID(), label: input.label?.trim() || target || via!, target, enabled: true,
      ...(via ? { via } : input.command?.trim() ? { command: input.command.trim() } : {}),
      colour: nextColour([this.#here.colour, ...this.#machines.map((m) => m.colour)]),
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

  async update(id: string, patch: Partial<Pick<MachineConfig, 'label' | 'target' | 'command' | 'enabled' | 'daemonId' | 'colour'>>) {
    const current = this.#machines.find((m) => m.id === id)
    if (!current) throw new RpcError('not_found', `No machine ${id}`)
    if (patch.colour !== undefined && !isColour(patch.colour)) throw new RpcError('invalid', `No colour ${patch.colour}`)
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
    const files = [[this.#path, this.#machines], [this.#herePath, this.#here]] as const
    const texts = files.map(([path, value]) => [path, JSON.stringify(value, null, 2) + '\n'] as const)
    this.#unsaved++
    const saved = this.#saving.then(async () => {
      await mkdir(this.#path.slice(0, this.#path.lastIndexOf('/')), { recursive: true, mode: 0o700 })
      for (const [path, text] of texts) {
        const temp = `${path}.${process.pid}.tmp`
        await writeFile(temp, text, { mode: 0o600 })
        await rename(temp, path)
      }
    }).finally(() => { this.#unsaved-- })
    this.#saving = saved.catch(() => {})
    await saved
    for (const listener of this.#listeners) listener()
  }
}
