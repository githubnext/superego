// The tool rules the user said to always allow in a folder ("Always allow Bash(npm test:*)"), kept by Superego in its
// data folder, not in the folder's own Claude Code settings where Claude Code would put them: those load only once the
// user allowed them as they are (project.ts), so a rule written there would go unread until then, and change what was
// allowed once it is. Each turn passes a folder's rules to Claude Code as allowed tools.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { real } from './project.ts'

export class AlwaysAllowed {
  #path: string
  #rules: Record<string, string[]> = {}
  constructor(path: string) { this.#path = path }
  async load() {
    let text: string
    try { text = await readFile(this.#path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    this.#rules = JSON.parse(text) as Record<string, string[]>
  }
  /** The rules allowed in `cwd`. */
  rules(cwd: string) { return this.#rules[real(cwd)] ?? [] }
  /** Allow `rules` in `cwd` from now on. */
  async remember(cwd: string, rules: string[]) {
    const at = real(cwd)
    const had = this.#rules[at] ?? []
    const added = rules.filter((rule) => !had.includes(rule))
    if (!added.length) return
    this.#rules[at] = [...had, ...added]
    await mkdir(dirname(this.#path), { recursive: true })
    const temp = `${this.#path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.#rules, null, 2) + '\n', { mode: 0o600 })
    await rename(temp, this.#path)
  }
}
