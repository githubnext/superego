import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Json } from '@superego/protocol'
import type { SettingsStore } from './registry.ts'

/** Settings in a JSON file, read once at start and replaced atomically on every save. */
export class FileSettingsStore implements SettingsStore {
  readonly path: string
  #queue: Promise<unknown> = Promise.resolve()
  constructor(path: string) { this.path = path }

  load(): Record<string, Json> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { return {} }
  }

  save(values: Record<string, Json>): Promise<void> {
    const run = this.#queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 })
      await rename(temp, this.path)
    })
    this.#queue = run.catch(() => {})
    return run
  }
}
