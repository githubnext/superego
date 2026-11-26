// Mentioning as you type: the `@word` at the caret, and what it could name, best first: other threads (on every machine
// the window reaches, the machine named where it isn't the composer's) and things extensions name (`MentionSource`s),
// then the files in the thread's folder. What the menu holds is capped here, whatever the sources answer: so many of
// each, so many in all.
import { mentionRef, score, type MachineEntry, type MentionItem, type ThreadInfo } from '@superego/app/ui'
import { fileRef, threadRef } from './shared.ts'

/** The `@word` being typed at the caret, if one is: at the start of a word (not an address's `x@y`). */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  if (/^[^\s"'`()[\]{}<>,;]/.test(text.slice(caret))) return undefined
  const match = /(?:^|[\s([{"'`])@([^\s"'`()[\]{}<>,;]*)$/.exec(text.slice(0, caret))
  if (!match) return undefined
  return { start: caret - match[1]!.length - 1, query: match[1]! }
}

/** Something a mention can name, and what goes in the text for it. */
export type Offer =
  | { kind: 'thread'; machine: MachineEntry; thread: ThreadInfo; insert: string }
  | { kind: 'file'; path: string; insert: string }
  | { kind: 'other'; type: string; item: MentionItem; insert: string }

/** What a source of an extension's things answered for the word: its items, and whether they were searched for (each a match). */
export type SourceItems = { kind: string; items: readonly MentionItem[]; searched?: boolean }

/** The most the menu holds. */
export const MAX_MENTIONS = 10
/** The most threads offered beside other things. */
export const THREADS = 5
/** The most offered of each extension's kind beside other things. */
export const MAX_PER_SOURCE = 3

/**
 * What `query` asks for: `thread:`, `file:` or an extension's kind (`canvas:`, of `kinds`) followed by what to match asks
 * for those alone (`scope`); anything else, for everything.
 */
export function scopeOf(query: string, kinds: readonly string[]): { scope?: string; q: string } {
  const named = /^([a-z][a-z0-9-]*):/.exec(query)
  if (named && (named[1] === 'thread' || named[1] === 'file' || kinds.includes(named[1]!))) return { scope: named[1]!, q: query.slice(named[0].length) }
  return { q: query }
}

/** A machine as a mention names it: by its name, where that is one word; else by its id. */
const machineName = (machine: MachineEntry) => /^[\w.-]+$/.test(machine.label) ? machine.label : machine.id

/** A file by its name before its path (as quick open ranks them). */
const fileScore = (path: string, query: string) => Math.max(score(path.split('/').at(-1)!, query) * 2, score(path, query))

/** How well an extension's thing matches: by its label or its id, or less well by its keywords (which don't show). */
const itemScore = (item: MentionItem, query: string) =>
  Math.max(score(item.label, query), score(item.id, query), item.keywords ? Math.min(score(item.keywords, query), 2) : 0)

/** A thread or an extension's thing as ranked against the others, before it's cut to the menu. */
type Ranked = { offer: Offer; rank: number }

/**
 * What `query` could mention from the thread `here` on `machine` (none: a thread yet to start): threads by how well
 * their titles match, the most recently active first among equals (not `here` itself), and extensions' things by how
 * well they match (what a search answered matches all the same, as does all of a kind whose name is being typed), the
 * higher `order` first among equals, interleaved by
 * how well they match (threads first among equals, then the sources in order); then files by how well their paths do,
 * the shorter first among equals. At most `THREADS` threads and `MAX_PER_SOURCE` of each source; `MAX_MENTIONS` in all.
 * `thread:`, `file:` or a source's `<kind>:` asks for those alone, up to `MAX_MENTIONS` of them.
 */
export function offers({ query, machine, here, machines, threads, files, sources = [], kinds = sources.map((s) => s.kind) }: {
  query: string
  machine: string
  here?: string
  machines: readonly MachineEntry[]
  threads: Readonly<Record<string, readonly ThreadInfo[] | undefined>>
  files: readonly string[]
  /** What each source of extensions' things answered (those asked: a scope's alone). */
  sources?: readonly SourceItems[]
  /** The kinds there are sources of (whether they've answered or not): what `<kind>:` scopes to. */
  kinds?: readonly string[]
}): Offer[] {
  const { scope, q } = scopeOf(query, kinds)
  const found: Ranked[][] = []
  if (!scope || scope === 'thread') {
    found.push(machines.filter((m) => m.state === 'connected').flatMap((m) => (threads[m.id] ?? [])
      .filter((thread) => !(m.id === machine && thread.id === here))
      .map((thread) => ({ machine: m, thread, rank: score(thread.title, q) })))
      .filter((t) => t.rank > 0)
      .sort((a, b) => b.rank - a.rank || b.thread.activeAt - a.thread.activeAt)
      .slice(0, scope ? MAX_MENTIONS : THREADS)
      .map(({ machine: m, thread, rank }) => ({ rank, offer: { kind: 'thread', machine: m, thread, insert: `${threadRef(thread.id, m.id === machine ? undefined : machineName(m))} ` } })))
  }
  for (const source of sources) {
    if (scope && scope !== source.kind) continue
    // Its kind typed (`@can`): its things all match, if only just.
    const least = source.searched || (q && source.kind.startsWith(q.toLowerCase())) ? 1 : 0
    found.push(source.items
      .map((item, index) => ({ item, index, rank: Math.max(itemScore(item, q), least) }))
      .filter((i) => i.rank > 0)
      .sort((a, b) => b.rank - a.rank || (b.item.order ?? 0) - (a.item.order ?? 0) || a.index - b.index)
      .slice(0, scope ? MAX_MENTIONS : MAX_PER_SOURCE)
      .map(({ item, rank }) => ({ rank, offer: { kind: 'other', type: source.kind, item, insert: `${mentionRef(source.kind, item.id)} ` } })))
  }
  // Interleaved by rank: a stable sort keeps threads, then each source in turn, first among equals.
  const named = found.flatMap((list, group) => list.map((r, index) => ({ ...r, group, index })))
    .sort((a, b) => b.rank - a.rank || a.group - b.group || a.index - b.index)
    .slice(0, MAX_MENTIONS)
    .map(({ offer }) => offer)
  if (scope && scope !== 'file') return named
  const paths = files.map((path) => ({ path, rank: fileScore(path, q) }))
    .filter((f) => f.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, MAX_MENTIONS - named.length)
    .map(({ path }): Offer => ({ kind: 'file', path, insert: `${fileRef(path)} ` }))
  return [...named, ...paths]
}
