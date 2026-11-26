// What brings each terminal's program back (OSC 7577), kept across the daemon's restarts: by `<thread>/<pane>`, in a
// file only the user can read, written as each record comes and goes (a daemon that crashes has no chance to save).
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Resume } from './resume.ts'

/** A record as kept: with the user it was made as, the only one it's resumed as. */
type Saved = Resume & { uid: number }

const uid = () => process.getuid?.() ?? -1

export class ResumeStore {
  #file: string
  #saved: Record<string, Saved> = {}

  /** The store in `file`. One that can't be read is said, and starts empty. */
  constructor(file: string) {
    this.#file = file
    let text: string | undefined
    try { text = readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`terminal: reading ${file}:`, error)
    }
    if (text === undefined) return
    try { this.#saved = JSON.parse(text) as Record<string, Saved> } catch (error) { console.error(`terminal: reading ${file}:`, error) }
  }

  keys() { return Object.keys(this.#saved) }

  /** What brings a terminal's program back, if it was made as this user. */
  get(key: string): Resume | undefined {
    const saved = this.#saved[key]
    if (!saved || saved.uid !== uid()) return undefined
    const { uid: _, ...resume } = saved
    return resume
  }

  /** Keep what brings a terminal's program back, or (`undefined`) forget it. Throws when it can't be written. */
  set(key: string, resume: Resume | undefined) {
    const before = this.#saved[key]
    const saved = resume && { ...resume, uid: uid() }
    if (JSON.stringify(before) === JSON.stringify(saved)) return
    if (saved) this.#saved[key] = saved
    else delete this.#saved[key]
    this.#write()
  }

  /** Forget it, and say what it was: a resume is tried once. */
  take(key: string): Resume | undefined {
    const resume = this.get(key)
    this.set(key, undefined)
    return resume
  }

  #write() {
    const temp = `${this.#file}.${process.pid}.tmp`
    rmSync(temp, { force: true })
    writeFileSync(temp, `${JSON.stringify(this.#saved, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.#file)
  }
}
