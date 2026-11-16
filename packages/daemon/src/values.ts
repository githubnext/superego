// Live values: what extensions publish (`superego.value`, `superego.scopedValue`) and the core's own (AUTH_REJECTED,
// DATA_VIEWS), by name, and who watches each (`value.watch`). A name is watched, not a value: a watch on one no
// extension has set up yet (a profile's, before the profile loads) waits on null, and takes the value when it comes.
import type { Json, Lifetime } from '@superego/protocol'
import type { LiveValue, ScopedValue } from './extension.ts'

/**
 * A live value by name, as the daemon keeps it: a plain one's `value`, or a scoped one's value in each scope (`scopes`);
 * who watches it whole (`listeners`), and who watches one scope of it (`watchers`, by scope). `owned` while someone
 * publishes it.
 */
type ValueEntry = {
  value: Json
  owned: boolean
  listeners: Set<(value: Json) => void>
  watchers: Map<string, Set<(value: Json) => void>>
  scopes?: { values: Map<string, Json>; initial: Json }
  /** A scoped value kept elsewhere (a thread's state): a scope is read in when first watched, and let go when no longer. */
  backing?: { watched(scope: string): void; unwatched(scope: string): void }
}
/** A value whole: a scoped one's, every scope's by scope. */
const wholeOf = (entry: ValueEntry): Json => entry.scopes ? Object.fromEntries(entry.scopes.values) : entry.value
/** A value's part in `scope`: a scoped one's value there (or what an unset scope reads); a plain one's entry of that key. */
const partOf = (entry: ValueEntry, scope: string): Json => {
  if (entry.scopes) return entry.scopes.values.get(scope) ?? entry.scopes.initial
  const value = entry.value
  return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, scope) ? value[scope]! : null
}
/** Tell everyone watching it: whole, and in each scope watched (each watcher hears only a change to its part). */
function tellAll(entry: ValueEntry) {
  if (entry.listeners.size) { const whole = wholeOf(entry); for (const listener of entry.listeners) listener(whole) }
  for (const [scope, watchers] of entry.watchers) { const part = partOf(entry, scope); for (const listener of watchers) listener(part) }
}
/** Tell those watching one scope of it, and those watching it whole. */
function tellScope(entry: ValueEntry, scope: string) {
  const watchers = entry.watchers.get(scope)
  if (watchers) { const part = partOf(entry, scope); for (const listener of watchers) listener(part) }
  if (entry.listeners.size) { const whole = wholeOf(entry); for (const listener of entry.listeners) listener(whole) }
}

export class Values {
  #entries = new Map<string, ValueEntry>()

  #entry(name: string) {
    let entry = this.#entries.get(name)
    if (!entry) this.#entries.set(name, entry = { value: null, owned: false, listeners: new Set(), watchers: new Map() })
    return entry
  }

  /** Forget a value nobody publishes or watches. */
  #prune(name: string) {
    const entry = this.#entries.get(name)
    if (entry && !entry.owned && !entry.listeners.size && !entry.watchers.size) this.#entries.delete(name)
  }

  #own(name: string) {
    const entry = this.#entry(name)
    if (entry.owned) throw new Error(`Value ${name} is already published`)
    entry.owned = true
    return entry
  }

  /** One of the core's own, for the daemon's life: what `set` gives it, every watcher told. */
  core(name: string, initial: Json): (value: Json) => void {
    const entry = this.#own(name)
    entry.value = initial
    return (value) => { entry.value = value; tellAll(entry) }
  }

  /**
   * A plain value, published for `life`: gone with it (watchers see null again, as before it was set up, and a later
   * watch waits on null). Its own: what it last published, which a later set-up of the same name (the next generation)
   * never sees, nor overwrites from here. After teardown, `set` and `update` do nothing.
   */
  publish<T extends Json>(name: string, initial: T, life: Lifetime): LiveValue<T> {
    const entry = this.#own(name)
    life.add(() => {
      entry.owned = false
      entry.value = null
      tellAll(entry)
      this.#prune(name)
    }, 'a value')
    let mine = initial
    const set = life.guard(`a change to ${name}`, (next: T) => {
      mine = next
      entry.value = next
      tellAll(entry)
    })
    set(initial)
    return { get: () => mine, set, update: life.guard(`a change to ${name}`, (edit: (current: T) => T) => set(edit(mine))) }
  }

  /** A value in scopes, published for `life`, as a plain one is: a later set-up of the same name starts from nothing. */
  publishScoped<T extends Json>(name: string, initial: T, life: Lifetime): ScopedValue<T> {
    const entry = this.#own(name)
    const mine = new Map<string, T>()
    entry.scopes = { values: mine as Map<string, Json>, initial }
    tellAll(entry)
    life.add(() => {
      entry.owned = false
      delete entry.scopes
      entry.value = null
      tellAll(entry)
      this.#prune(name)
    }, 'a value')
    const scopeOf = (scope: string) => {
      if (typeof scope !== 'string' || !scope) throw new Error(`Value ${name}: a scope is a non-empty string (a thread's id, say)`)
      return scope
    }
    const set = life.guard(`a change to ${name}`, (scope: string, next: T) => { mine.set(scopeOf(scope), next); tellScope(entry, scope) })
    return {
      get: (scope) => mine.get(scope) ?? initial,
      set,
      update: life.guard(`a change to ${name}`, (scope: string, edit: (current: T) => T) => set(scope, edit(mine.get(scope) ?? initial))),
      delete: life.guard(`a change to ${name}`, (scope: string) => { if (mine.delete(scope)) tellScope(entry, scope) }),
      scopes: () => [...mine.keys()],
    }
  }

  /**
   * A scoped value backed by something kept elsewhere (an extension's state with each thread), published for `life`:
   * a scope reads null until it's watched, then what `load` reads for it (null for nothing); `changed` tells its
   * watchers what it is now, and a scope nobody watches is let go of, so only watched ones are held. Watched whole, it's
   * the scopes held now.
   */
  publishBacked(name: string, load: (scope: string) => Promise<Json | undefined>, life: Lifetime): { changed(scope: string, value: Json | undefined): void } {
    const entry = this.#own(name)
    const held = new Map<string, Json>()
    entry.scopes = { values: held, initial: null }
    const watched = (scope: string) => {
      if (held.has(scope)) return
      void load(scope).then((value) => {
        // Changed while it was read (that's newer), or no longer watched, or gone: left be.
        if (held.has(scope) || !entry.watchers.has(scope) || entry.backing !== backing) return
        held.set(scope, value ?? null)
        tellScope(entry, scope)
      }, (error: unknown) => console.error(`Value ${name}: reading ${scope} failed:`, error))
    }
    const backing = { watched, unwatched: (scope: string) => { held.delete(scope) } }
    entry.backing = backing
    for (const scope of entry.watchers.keys()) watched(scope)
    tellAll(entry)
    life.add(() => {
      entry.owned = false
      delete entry.scopes
      delete entry.backing
      entry.value = null
      tellAll(entry)
      this.#prune(name)
    }, 'a value')
    return {
      changed: life.guard(`a change to ${name}`, (scope: string, value: Json | undefined) => {
        if (!entry.watchers.has(scope) && !held.has(scope)) return
        held.set(scope, value ?? null)
        tellScope(entry, scope)
      }),
    }
  }

  /**
   * A value (or its part in `scope`) now, then `tell` with each new one until `stop`. Watching one scope, it's told
   * only when its part changes.
   */
  watch(name: string, scope: string | undefined, tell: (value: Json) => void): { value: Json; stop(): void } {
    const entry = this.#entry(name)
    if (typeof scope !== 'string') {
      const listener = (value: Json) => tell(value)
      entry.listeners.add(listener)
      return { value: wholeOf(entry), stop: () => { entry.listeners.delete(listener); this.#prune(name) } }
    }
    const value = partOf(entry, scope)
    let last = JSON.stringify(value)
    const listener = (next: Json) => {
      const json = JSON.stringify(next)
      if (json === last) return
      last = json
      tell(next)
    }
    const watchers = entry.watchers.get(scope) ?? new Set()
    entry.watchers.set(scope, watchers.add(listener))
    entry.backing?.watched(scope)
    return {
      value,
      stop: () => {
        watchers.delete(listener)
        if (!watchers.size && entry.watchers.get(scope) === watchers) {
          entry.watchers.delete(scope)
          entry.backing?.unwatched(scope)
        }
        this.#prune(name)
      },
    }
  }

  /** A value whole, as it is now: null when nobody publishes it. */
  current(name: string): Json {
    const entry = this.#entries.get(name)
    return entry ? wholeOf(entry) : null
  }

  /** The values named `<prefix>.<…>` watched now: by how many whole, and in how many scopes (the inspector's). */
  watchedUnder(prefix: string) {
    return [...this.#entries].filter(([key, entry]) => key.startsWith(`${prefix}.`) && (entry.listeners.size || entry.watchers.size))
      .map(([key, entry]) => ({ value: key, whole: entry.listeners.size, scopes: entry.watchers.size }))
  }
}
