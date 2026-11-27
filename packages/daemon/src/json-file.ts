// An extension's JSON state file (`superego.jsonFile`): one file in its folder, read once, saved whole, atomically and
// one save at a time (saves made while one is writing collapse into the newest). A file that doesn't read as JSON, or
// that `check` refuses, is kept aside (`<name>.bad-<time>`), never written over: when it can't even be moved, nothing
// is saved until it's fixed or removed. What's wrong (that, or a failed save) is said through `trouble`, and cleared
// once a save lands. Teardown waits for the last save, and refuses saves after.
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { Json } from '@superego/protocol'
import { writeAtomic } from './write-atomic.ts'

/** What `superego.jsonFile` is given: what an empty one holds, how to tell a good one, and where to say what's wrong. */
export type JsonFileOptions<T extends Json> = {
  /** What it holds when there's no file yet, or the one there didn't read. */
  empty: T
  /** Why what was read isn't one (a list that's missing, say), or nothing when it is. A throw counts as a why. */
  check?(data: unknown): string | undefined
  /**
   * What's wrong with it now, said where the user sees it (a live value Settings shows, say), or undefined once it's
   * right again. Also logged.
   */
  trouble(message: string | undefined): void
}

/**
 * A file that didn't read: why, its text (none when it couldn't be read at all), and where it was kept (none: it couldn't
 * be moved, or read, and nothing is saved to it).
 */
export type BadJsonFile = { why: string; text?: string; keptAs?: string }

/** An extension's JSON state file (`superego.jsonFile`): read once, saved whole. */
export type JsonFile<T extends Json> = {
  /** Where it is: `<dir>/<name>`. */
  readonly path: string
  /** Read it (once: later calls answer the same): its data, `empty` when there's none, or when it didn't read. */
  read(): Promise<T>
  /** After `read`: a file that didn't read, if it didn't. */
  readonly bad: BadJsonFile | undefined
  /**
   * Save it whole: after the save writing now, if one is; saves made meanwhile collapse into the newest (a function is
   * asked as it's written). Rejects when it fails (said through `trouble` too), when the file there didn't read and
   * couldn't be kept aside, and after teardown. Waits for `read`.
   */
  save(data: T | (() => T)): Promise<void>
  /** Once every save asked for so far has landed or failed. */
  settled(): Promise<void>
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** `name` in `dir`, as `owner` (for what's logged). `close` refuses saves after it, once the last has landed. */
export function openJsonFile<T extends Json>(dir: () => string, name: string, owner: string, options: JsonFileOptions<T>): JsonFile<T> & { close(): Promise<void> } {
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error(`Extension ${owner}: a JSON file's name is a file name in its folder ("state.json"), not "${name}"`)
  let path: string | undefined
  const where = () => path ??= join(dir(), name)
  let reading: Promise<T> | undefined
  let bad: BadJsonFile | undefined
  /** Saves are refused: the file there didn't read and couldn't be kept aside. */
  let stuck: string | undefined
  let closed = false
  // What's said: what was wrong as it was read, and the last save's failure.
  let readProblem: string | undefined
  let saveProblem: string | undefined
  let said: string | undefined
  const say = () => {
    const now = [readProblem, saveProblem].filter(Boolean).join(' ') || undefined
    if (now === said) return
    said = now
    if (now) console.error(`Extension ${owner}: ${now}`)
    options.trouble(now)
  }

  async function load(): Promise<T> {
    const file = where()
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return options.empty
      // Not there to read (permissions, say): not known to be bad, so not moved, and not written over either.
      bad = { why: messageOf(error) }
      stuck = `${name} couldn't be read (${bad.why}), so nothing is saved to it until that's fixed.`
      readProblem = stuck
      say()
      return options.empty
    }
    let why: string | undefined
    let data: unknown
    try {
      data = JSON.parse(text)
      why = options.check?.(data)
    } catch (error) {
      why = messageOf(error)
    }
    if (why === undefined) return data as T
    const keptAs = `${file}.bad-${Date.now()}`
    try {
      await rename(file, keptAs)
      bad = { text, why, keptAs }
      readProblem = `${name} didn't read (${why}), so what it held is gone for now: it's kept as ${keptAs}.`
    } catch (error) {
      bad = { text, why }
      stuck = `${name} didn't read (${why}), nor could it be kept aside (${messageOf(error)}), so nothing is saved until it's fixed or removed.`
      readProblem = stuck
    }
    say()
    return options.empty
  }

  // One save at a time; the newest asked for meanwhile is the next written.
  type Waiting = { resolve(): void; reject(error: unknown): void }
  let next: { data: T | (() => T); waiting: Waiting[] } | undefined
  let pumping: Promise<void> | undefined
  async function write({ data, waiting }: NonNullable<typeof next>) {
    try {
      await (reading ??= load())
      if (stuck) throw new Error(stuck)
      await writeAtomic(where(), `${JSON.stringify(typeof data === 'function' ? data() : data)}\n`)
      if (saveProblem) { saveProblem = undefined; say() }
      for (const w of waiting) w.resolve()
    } catch (error) {
      if (!stuck) { saveProblem = `Saving ${name} failed: ${messageOf(error)}.`; say() }
      for (const w of waiting) w.reject(error)
    }
  }
  const pump = () => pumping ??= (async () => {
    while (next) {
      const batch = next
      next = undefined
      await write(batch)
    }
  })().finally(() => {
    pumping = undefined
    // One asked for as the last finished: written now.
    if (next) void pump()
  })

  async function settled() {
    while (pumping) await pumping
  }

  return {
    get path() { return where() },
    read: () => reading ??= load(),
    get bad() { return bad },
    save(data) {
      if (closed) return Promise.reject(new Error(`Extension ${owner} is torn down: ${name} isn't saved now`))
      return new Promise<void>((resolve, reject) => {
        next = { data, waiting: [...next?.waiting ?? [], { resolve, reject }] }
        void pump()
      })
    },
    settled,
    async close() {
      closed = true
      await settled()
    },
  }
}
