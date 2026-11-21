// How many Claude Agent turns run at once on a machine: a turn takes a place before it starts `claude`, and gives it
// back as it ends. Over the limit (Settings), turns wait their turn, oldest first, and their threads say so while they
// wait. It keeps background use of one plan nearer the "ordinary, individual usage" it's sold for.

/** One plan's turns: those running, and those waiting for a place, oldest first. */
export class Parallel {
  #limit: () => number
  #changed: () => void
  #running = new Map<symbol, string>()
  #waiting: { place: symbol; thread: string; start(): void }[] = []

  /** `limit`: how many may run at once, read as places free up; `changed`: who waits changed (for threads' status). */
  constructor(limit: () => number, changed: () => void) {
    this.#limit = limit
    this.#changed = changed
  }

  /**
   * A place for one of `thread`'s turns, once there's one: what gives it back (again does nothing). Rejects once
   * `signal` aborts while it waits (the turn was stopped).
   */
  async take(thread: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    const place = Symbol(thread)
    const release = () => { if (this.#running.delete(place)) this.pump() }
    if (!this.#waiting.length && this.#running.size < this.#limited()) {
      this.#running.set(place, thread)
      return release
    }
    await new Promise<void>((resolve, reject) => {
      const waiting = { place, thread, start: resolve }
      this.#waiting.push(waiting)
      signal.addEventListener('abort', () => {
        const at = this.#waiting.indexOf(waiting)
        if (at < 0) return
        this.#waiting.splice(at, 1)
        this.#changed()
        reject(signal.reason instanceof Error ? signal.reason : new Error('Stopped while waiting for its turn'))
      }, { once: true })
      this.#changed()
    })
    return release
  }

  /** Start what waits, as places free up (one given back, or the limit raised). */
  pump() {
    let started = false
    while (this.#waiting.length && this.#running.size < this.#limited()) {
      const next = this.#waiting.shift()!
      this.#running.set(next.place, next.thread)
      next.start()
      started = true
    }
    if (started) this.#changed()
  }

  /** What `thread` waits on, when one of its turns waits for a place: "Waiting: 3 Claude Agent threads are running". */
  waitingFor(thread: string): string | undefined {
    if (!this.#waiting.some((w) => w.thread === thread)) return undefined
    const n = this.#running.size
    return `Waiting: ${n} Claude Agent ${n === 1 ? 'thread is' : 'threads are'} running`
  }

  #limited() { return Math.max(1, Math.floor(this.#limit()) || 1) }
}
