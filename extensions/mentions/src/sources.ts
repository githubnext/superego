// Asking extensions' mention sources (`MentionSource`) for the `@` word being typed, so that none can slow or flood the
// menu: a `list` once per word (where it starts, in which thread or folder), matched as the word grows with no call
// again; a `search` at once for a bare `@`, then once typing pauses (80ms), the last one aborted as the word changes;
// each given 800ms, after which it's aborted, logged, and offers nothing for that word; and what each answers cut to
// `MAX_CANDIDATES`, its items checked. Leaving the word aborts what's still being asked.
import { mentionable } from '@superego/protocol'
import type { ComposerWhere, MentionItem, MentionSource } from '@superego/app/ui'
import type { SourceItems } from './complete.ts'

/** How long typing pauses before a source's `search` is asked. */
export const SEARCH_DEBOUNCE = 80
/** How long a source may take to answer before it's aborted and offers nothing for the word. */
export const SOURCE_TIMEOUT = 800
/** The most of a source's answer that's matched against the word: what's past it is left out (logged). */
export const MAX_CANDIDATES = 500

/** What a source was asked for the word: its answer now, or one to come (undefined: none, aborted or failed). */
export type Asked = { source: MentionSource; now?: SourceItems; later?: Promise<SourceItems | undefined> }

/** What's asked of sources for one `@` word, where it starts in which thread or folder: their lists, kept while it's typed. */
type Session = {
  key: string
  /** Aborted as the word is left: what its lists are asked with. */
  controller: AbortController
  lists: Map<MentionSource, { items?: SourceItems; pending?: Promise<SourceItems | undefined> }>
  /** The asks of it going on now: none left (and none following at once), the word was left. */
  asks: number
}

/** The word's key: which thread (or folder, before there's one) on which machine, and where the word starts. */
const keyOf = ({ machine, thread, cwd }: ComposerWhere, start: number) => `${machine.id}\u0000${thread?.id ?? cwd}\u0000${start}`

/** A promise, to tell an answer that comes later from one at once. */
const isPromise = <T,>(value: unknown): value is Promise<T> => typeof (value as Promise<T> | undefined)?.then === 'function'

/**
 * A lookup of extensions' mention sources, holding the lists asked for the word being typed. `timeout` and `debounce`:
 * other than the defaults, for a test.
 */
export function createLookup({ timeout = SOURCE_TIMEOUT, debounce = SEARCH_DEBOUNCE } = {}) {
  let session: Session | undefined

  /** What a source answered, as offered: a list of items it can mention, cut to `MAX_CANDIDATES`. */
  function accept(source: MentionSource, answer: unknown, searched: boolean): SourceItems {
    if (!Array.isArray(answer)) {
      console.error(`Mention source ${source.kind} answered ${answer === null ? 'null' : typeof answer}, not a list of items`)
      return { kind: source.kind, items: [], searched }
    }
    if (answer.length > MAX_CANDIDATES) console.warn(`Mention source ${source.kind} answered ${answer.length} items; only the first ${MAX_CANDIDATES} are matched`)
    const all = answer.slice(0, MAX_CANDIDATES) as MentionItem[]
    const items = all.filter((item) => item && typeof item.label === 'string' && mentionable(item.id))
    if (items.length < all.length) console.warn(`Mention source ${source.kind}: ${all.length - items.length} items left out, without a label or with an id no mention can hold (empty, or with a quote or line break)`)
    return { kind: source.kind, items, searched }
  }

  /**
   * Ask `source` (`what`: its list or search) with a signal aborted when `parent` is, or after `timeout`: its answer
   * now, if it gave one at once, else one to come. A throw, a rejection or a late answer is logged and offers nothing.
   */
  function asking(source: MentionSource, what: 'list' | 'search', parent: AbortSignal, run: (signal: AbortSignal) => unknown): { now?: SourceItems; later?: Promise<SourceItems | undefined> } {
    const searched = what === 'search'
    const failed = (error: unknown) => { console.error(`Mention source ${source.kind}: its ${what} failed`, error); return { kind: source.kind, items: [], searched } }
    const controller = new AbortController()
    if (parent.aborted) return {}
    const stop = () => controller.abort()
    parent.addEventListener('abort', stop, { once: true })
    let answer: unknown
    try { answer = run(controller.signal) } catch (error) { parent.removeEventListener('abort', stop); return { now: failed(error) } }
    if (!isPromise(answer)) { parent.removeEventListener('abort', stop); return { now: accept(source, answer, searched) } }
    const later = new Promise<SourceItems | undefined>((resolve) => {
      const done = (items: SourceItems | undefined) => { clearTimeout(timer); parent.removeEventListener('abort', gone); resolve(items) }
      // Left (the word changed or ended): nothing, said by no one.
      const gone = () => done(undefined)
      parent.addEventListener('abort', gone, { once: true })
      const timer = setTimeout(() => {
        console.warn(`Mention source ${source.kind}: its ${what} took over ${timeout}ms, so it's aborted and offers nothing for this word`)
        controller.abort()
        done({ kind: source.kind, items: [], searched })
      }, timeout)
      answer.then(
        (items) => { if (!controller.signal.aborted) done(accept(source, items, searched)) },
        (error: unknown) => { if (!controller.signal.aborted) done(failed(error)) },
      )
    })
    void later.finally(() => parent.removeEventListener('abort', stop))
    return { later }
  }

  /** The session of the word at `start` where the composer is: the one going on, or a new one (the old one aborted). */
  function sessionFor(where: ComposerWhere, start: number): Session {
    const key = keyOf(where, start)
    if (session?.key === key) return session
    session?.controller.abort()
    return session = { key, controller: new AbortController(), lists: new Map(), asks: 0 }
  }

  /** The word `session` was for is left, unless another ask of it follows at once (the next keystroke's). */
  function release(of: Session) {
    of.asks--
    setTimeout(() => {
      if (of.asks > 0 || session !== of) return
      of.controller.abort()
      session = undefined
    }, 0)
  }

  /** `source`'s list for the session's word: asked once, then what it answered (or is answering). */
  function listOf(of: Session, source: MentionSource, where: ComposerWhere): Asked {
    const held = of.lists.get(source)
    if (held?.items) return { source, now: held.items }
    if (held?.pending) return { source, later: held.pending }
    const { now, later } = asking(source, 'list', of.controller.signal, (signal) => source.list!(where, { signal }))
    if (now) { of.lists.set(source, { items: now }); return { source, now } }
    const pending = later!.then((items) => {
      // Left before it answered: asked again if the word comes back.
      if (items) of.lists.set(source, { items })
      else of.lists.delete(source)
      return items
    })
    of.lists.set(source, { pending })
    return { source, later: pending }
  }

  /** `source`'s search for `query`: at once for none, else once typing pauses; `signal` aborts it as the word changes. */
  function searchOf(source: MentionSource, query: string, where: ComposerWhere, signal: AbortSignal): Asked {
    const run = () => asking(source, 'search', signal, (aborted) => source.search!(query, where, { signal: aborted }))
    if (!query) {
      const { now, later } = run()
      return { source, ...(now ? { now } : {}), ...(later ? { later } : {}) }
    }
    const later = new Promise<SourceItems | undefined>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', gone)
        const { now, later } = run()
        resolve(now ?? later)
      }, debounce)
      const gone = () => { clearTimeout(timer); resolve(undefined) }
      signal.addEventListener('abort', gone, { once: true })
    })
    return { source, later }
  }

  return {
    /**
     * Ask `sources` what they have for `query` (what follows `@`, or `@<kind>:`), for the word at `start` where the
     * composer is; `signal` aborts as this ask's answer isn't wanted (the next keystroke). Each source's answer now, or
     * one to come.
     */
    ask(sources: readonly MentionSource[], query: string, where: ComposerWhere, start: number, signal: AbortSignal): Asked[] {
      const of = sessionFor(where, start)
      of.asks++
      if (signal.aborted) release(of)
      else signal.addEventListener('abort', () => release(of), { once: true })
      return sources.map((source) => source.list ? listOf(of, source, where) : searchOf(source, query, where, signal))
    },
  }
}
