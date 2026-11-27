// What a set-up owns, and how it ends: an extension's registrations (either half), a profile's hold on what it loaded.
// Everything registered goes through one `Lifetime`, which undoes it all at teardown, and refuses what comes after.
//
//   const life = new Lifetime('Extension notes')
//   life.add(() => watcher.close())             // undone at teardown, last added first
//   fetch(url, { signal: life.signal })          // aborted at teardown
//   const set = life.guard('set notes.x', set)   // a no-op once torn down, with a warning
//   await life.dispose()                         // every step tried, the failures logged; resolves once all have finished

/** One owned lifetime: its disposers, a signal aborted when it ends, and a guard for work that outlives it. */
export class Lifetime {
  readonly #controller = new AbortController()
  readonly #signal = contained(this.#controller.signal, () => this.name)
  #steps: (() => unknown)[] = []
  #ended: Promise<void> | undefined
  readonly #warned = new Set<string>()
  /** Who it is, in what it says: `Extension notes`. */
  readonly name: string
  constructor(name: string) { this.name = name }

  /** Aborted when it ends, before its disposers run: for timers, watchers and fetches of the owner's own. */
  get signal(): AbortSignal { return this.#signal }
  get disposed(): boolean { return this.#controller.signal.aborted }

  /** Own `dispose`, run when it ends (last added first). Refused once it has ended: `what` says what came late. */
  add(dispose: () => unknown, what = 'anything'): void {
    this.live(what)
    this.#steps.push(dispose)
  }

  /** Throw if it has ended: a registration after teardown is refused, never left behind. */
  live(what: string): void {
    if (this.disposed) throw new Error(`${this.name} is torn down: it can't register ${what} now`)
  }

  /**
   * `run` while it lives; after, a no-op that warns once (per `what`): work that outlived it (a reply that came late)
   * changes nothing of the next one's.
   */
  guard<A extends unknown[]>(what: string, run: (...args: A) => void): (...args: A) => void {
    return (...args) => {
      if (!this.disposed) return run(...args)
      if (this.#warned.has(what)) return
      this.#warned.add(what)
      console.warn(`${this.name} is torn down: ignored ${what} (stop work that outlives it with superego.signal)`)
    }
  }

  /**
   * End it: abort the signal, then run every disposer, last added first. Each is tried whatever the others did, and the
   * failures are logged. Resolves once every one has finished, those that return a promise included: what it owned is
   * done with then (a write it made has landed). Ending it again gives the same promise. `reason` is the signal's
   * (`signal.reason`): why it ends, for listeners that act on it (a `Teardown`).
   */
  dispose(reason?: unknown): Promise<void> {
    if (this.#ended) return this.#ended
    const failed = (error: unknown) => console.error(`${this.name}: a cleanup failed`, error)
    try { this.#controller.abort(reason) } catch (error) { failed(error) }
    const running: Promise<unknown>[] = []
    for (const step of this.#steps.splice(0).reverse()) {
      try {
        const done = step()
        if (done && typeof (done as PromiseLike<unknown>).then === 'function') running.push(Promise.resolve(done).catch(failed))
      } catch (error) {
        failed(error)
      }
    }
    return this.#ended = Promise.all(running).then(() => {})
  }
}

/**
 * Why an extension is torn down, as its signal's `reason` says: `stopping`, the daemon is stopping (or restarting:
 * what it started to outlive the daemon is taken back by the next); `reload`, its profile changed, went or was let go
 * of; `failed`, its setup failed or took too long.
 */
export type TeardownReason = 'stopping' | 'reload' | 'failed'

/** An extension's signal's `reason` at teardown: an `AbortError`, as a signal's own is, saying why (`why`). */
export class Teardown extends Error {
  override readonly name = 'AbortError'
  readonly why: TeardownReason
  constructor(why: TeardownReason) {
    super(why === 'stopping' ? 'The daemon is stopping' : why === 'reload' ? 'Its profile was reloaded' : 'Its setup failed')
    this.why = why
  }
}

/**
 * `signal`, its listeners each kept apart: one that throws is logged with whose it is, and the others still hear it. A
 * listener's throw would otherwise escape `abort()`: in the daemon, an uncaught error that takes the process down.
 */
type Listener = ((event: Event) => unknown) | { handleEvent(event: Event): unknown }
function contained(signal: AbortSignal, whose: () => string): AbortSignal {
  const wrapped = new WeakMap<object, (event: Event) => void>()
  const wrap = (listener: Listener) => {
    let safe = wrapped.get(listener)
    if (!safe) {
      safe = (event: Event) => {
        try {
          if (typeof listener === 'function') listener.call(signal, event)
          else listener.handleEvent(event)
        } catch (error) {
          console.error(`${whose()}: a listener on its signal failed`, error)
        }
      }
      wrapped.set(listener, safe)
    }
    return safe
  }
  const add = signal.addEventListener.bind(signal) as (type: string, listener: (event: Event) => void, options?: unknown) => void
  const remove = signal.removeEventListener.bind(signal) as (type: string, listener: Listener, options?: unknown) => void
  Object.defineProperties(signal, {
    addEventListener: { value: (type: string, listener: Listener | null, options?: unknown) => { if (listener) add(type, wrap(listener), options) } },
    removeEventListener: { value: (type: string, listener: Listener | null, options?: unknown) => { if (listener) remove(type, wrapped.get(listener) ?? listener, options) } },
  })
  let onabort: ((this: AbortSignal, event: Event) => unknown) | null = null
  Object.defineProperty(signal, 'onabort', {
    get: () => onabort,
    set(listener: typeof onabort) {
      if (onabort) remove('abort', wrap(onabort))
      onabort = listener
      if (listener) add('abort', wrap(listener))
    },
  })
  return signal
}
