// Mentioning as you type: the `@word` at the caret, and what it could name, best first: other threads (on every machine
// the window reaches, the machine named where it isn't the composer's), then the files in the thread's folder.
import { score, type MachineEntry, type ThreadInfo } from '@superego/app/ui'
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

/** How many of each are offered: threads first, then files to fill the menu. */
const THREADS = 5
const ALL = 10

/** A machine as a mention names it: by its name, where that is one word; else by its id. */
const machineName = (machine: MachineEntry) => /^[\w.-]+$/.test(machine.label) ? machine.label : machine.id

/** A file by its name before its path (as quick open ranks them). */
const fileScore = (path: string, query: string) => Math.max(score(path.split('/').at(-1)!, query) * 2, score(path, query))

/**
 * What `query` could mention from the thread `here` on `machine` (none: a thread yet to start): threads by how well
 * their titles match, the most recently active first among equals (not `here` itself); then files by how well their
 * paths do, the shorter first among equals. `thread:` asks for threads alone.
 */
export function offers({ query, machine, here, machines, threads, files }: {
  query: string
  machine: string
  here?: string
  machines: readonly MachineEntry[]
  threads: Readonly<Record<string, readonly ThreadInfo[] | undefined>>
  files: readonly string[]
}): Offer[] {
  const threadsOnly = query.startsWith('thread:')
  const q = threadsOnly ? query.slice('thread:'.length) : query
  const found = machines.filter((m) => m.state === 'connected').flatMap((m) => (threads[m.id] ?? [])
    .filter((thread) => !(m.id === machine && thread.id === here))
    .map((thread) => ({ machine: m, thread, rank: score(thread.title, q) })))
    .filter((t) => t.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.thread.activeAt - a.thread.activeAt)
    .slice(0, threadsOnly ? ALL : THREADS)
    .map(({ machine: m, thread }): Offer => ({ kind: 'thread', machine: m, thread, insert: `${threadRef(thread.id, m.id === machine ? undefined : machineName(m))} ` }))
  if (threadsOnly) return found
  const paths = files.map((path) => ({ path, rank: fileScore(path, q) }))
    .filter((f) => f.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, ALL - found.length)
    .map(({ path }): Offer => ({ kind: 'file', path, insert: `${fileRef(path)} ` }))
  return [...found, ...paths]
}
