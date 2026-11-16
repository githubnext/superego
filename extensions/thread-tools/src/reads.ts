// What parents have read of their children: the thread tools' thread_read notes it, and thread-reports doesn't relay an
// answer the parent has read already (by waiting on it, say). One log per daemon (by its data folder), shared by the two
// for as long as either is set up.
import type { ThreadInfo } from '@superego/protocol'

export type ReadLog = {
  /** `reader` read `thread` as it stands. Kept only for its parent, and only once it had stopped working. */
  note(reader: string, thread: ThreadInfo): void
  /** Whether its parent read it as it stood at `thread`'s activity, or later. */
  read(thread: ThreadInfo): boolean
}

export function readLog(): ReadLog {
  const seen = new Map<string, number>()
  return {
    note(reader, thread) {
      if (thread.parent !== reader || thread.status.state === 'working') return
      seen.set(thread.id, Math.max(seen.get(thread.id) ?? 0, thread.activeAt))
    },
    read: (thread) => (seen.get(thread.id) ?? -1) >= thread.activeAt,
  }
}

const logs = new Map<string, { log: ReadLog; holders: number }>()
/**
 * The log of the daemon whose data folder this is (`superego.dataDir`), held until `signal` (`superego.signal`): one
 * daemon runs on a data folder, so its two extensions of this package find the same log, and it's forgotten once
 * neither holds it, so a daemon opened there again starts with none. Nothing else should share it.
 */
export function readsOf(dataDir: string, signal: AbortSignal): ReadLog {
  let held = logs.get(dataDir)
  if (!held) logs.set(dataDir, held = { log: readLog(), holders: 0 })
  const entry = held
  entry.holders++
  signal.addEventListener('abort', () => {
    if (--entry.holders === 0 && logs.get(dataDir) === entry) logs.delete(dataDir)
  }, { once: true })
  return entry.log
}
