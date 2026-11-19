// What a thread's machine has at the paths its messages name in code (`src/a.ts`, `docs/plan.md:12`): a file, a folder,
// or nothing. Code is drawn as a link only once it's known to be one of the first two (links.tsx), so it's asked for as
// it's drawn: the names asked for together go in one `file.locate`, to the thread's machine, and the answers are kept
// for every place that draws them. Nothing found is asked again after a while: a file an agent names often comes after.
import { useSyncExternalStore } from 'react'
import type { Result } from '@superego/protocol'
import type { MachineId } from '../shared/bridge.ts'
import { machine as client } from './client.ts'

/** A file or folder in a thread's folder, by its path there, with the line a name gave. */
export type KnownFile = NonNullable<Result<'file.locate'>['found'][number]>

/** How long a path found to be nothing stays so before it's asked again. */
const MISS_FOR = 15_000

type Entry = { found: KnownFile | null; at: number } | 'asking'
const known = new Map<string, Map<string, Entry>>()
const queued = new Map<string, Set<string>>()
const listeners = new Set<() => void>()
let version = 0

const keyOf = (machine: MachineId, thread: string) => `${machine}\u0000${thread}`

function changed() {
  version++
  for (const listener of listeners) listener()
}

async function ask(machine: MachineId, thread: string, names: string[]) {
  const entries = known.get(keyOf(machine, thread))!
  try {
    const { found } = await client(machine).call('file.locate', { thread, names })
    const at = Date.now()
    names.forEach((name, i) => entries.set(name, { found: found[i] ?? null, at }))
  } catch (error) {
    // Not known, so drawn as plain code; asked again once a while has passed (the machine back, say).
    console.error(`Looking up ${names.length} path(s) on ${machine}`, error)
    const at = Date.now()
    for (const name of names) entries.set(name, { found: null, at })
  }
  changed()
}

/**
 * What `name` is in a thread's folder on `machine`, exactly as given (from the folder; absolute or `~` inside it): a
 * file or a folder, null for nothing, undefined while it's being asked (asked now, if it wasn't).
 */
export function knownFile(machine: MachineId, thread: string, name: string): KnownFile | null | undefined {
  const key = keyOf(machine, thread)
  const entries = known.get(key) ?? known.set(key, new Map()).get(key)!
  const entry = entries.get(name)
  if (entry === 'asking') return undefined
  if (entry && (entry.found || Date.now() - entry.at < MISS_FOR)) return entry.found
  entries.set(name, 'asking')
  const batch = queued.get(key)
  if (batch) batch.add(name)
  else {
    queued.set(key, new Set([name]))
    // Every name drawn in this pass, in one call.
    setTimeout(() => {
      const names = [...queued.get(key) ?? []]
      queued.delete(key)
      void ask(machine, thread, names)
    }, 0)
  }
  return undefined
}

/** Forget what's known (tests). */
export function forgetKnownFiles() {
  known.clear()
  queued.clear()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const current = () => version

/** Drawn again as answers come in. */
export const useKnownFiles = () => useSyncExternalStore(subscribe, current, current)
