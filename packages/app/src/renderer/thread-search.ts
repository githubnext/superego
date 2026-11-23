// Searching threads: one way for the window, ⌘L's navigator and the phone's drawer alike. A row is searched by where it
// sits and what it's called ("superego login": a project's name, then a thread's title, then a pane's); the matches best
// first (score.ts), by the title alone between equals, the archived after the rest however well they match.
import type { ThreadInfo } from '@superego/protocol'
import { call } from './client.ts'
import { score } from './score.ts'
import type { MachineEntry } from '../shared/bridge.ts'

/** What a search looks through: its path (the titles it sits under, then its own), and its own title. */
export type Searchable = { path: string; title: string; archived?: boolean }

/** A thread's path: its project's name, then its title. */
export const threadPath = (project: string, title: string) => `${project} ${title}`

/** The rows that match `query`, best first; an empty query matches none. */
export function search<T extends Searchable>(rows: readonly T[], query: string): T[] {
  if (!query.trim()) return []
  return rows.map((row) => ({ row, rank: score(row.path, query), own: score(row.title, query) })).filter(({ rank }) => rank > 0)
    .sort((a, b) => Number(Boolean(a.row.archived)) - Number(Boolean(b.row.archived)) || b.rank - a.rank || b.own - a.own)
    .map(({ row }) => row)
}

/** The archived threads, each machine's (or why it couldn't say). */
export type ArchivedThreads = { threads: { machine: MachineEntry; thread: ThreadInfo }[]; failed: { machine: MachineEntry; message: string }[] }

/** Every connected machine's archived threads, newest first; a machine that fails says so (and to the console). */
export async function listArchived(machines: readonly MachineEntry[]): Promise<ArchivedThreads> {
  const answers = await Promise.all(machines.filter((m) => m.state === 'connected').map((machine) =>
    call<ThreadInfo[]>(machine.id, 'thread.list', { archived: true }).then(
      (list) => ({ machine, list }),
      (error: unknown) => {
        console.error(`Listing ${machine.label}'s archived threads`, error)
        return { machine, message: error instanceof Error ? error.message : String(error) }
      })))
  return {
    threads: answers.flatMap((a) => 'list' in a ? a.list.map((thread) => ({ machine: a.machine, thread })) : []).sort((a, b) => b.thread.activeAt - a.thread.activeAt),
    failed: answers.flatMap((a) => 'message' in a ? [{ machine: a.machine, message: a.message }] : []),
  }
}
