// Reporting back: a process that ends as its `notify` says (any end, or a failure) wakes its owner thread with a
// message saying how, with its last lines. Batched per thread (until none came for 5s, 30s at most), and held while
// the thread is in a run: what goes is decided when that run ends. Not sent when the thread learnt it meanwhile (it
// waited on the process, or read its logs), nor to an archived thread; to the thread that continues one (a handoff).
// Best-effort, as thread reports are: what waits is in memory, and `process_wait` is the reliable way to know.
import type { ThreadInfo } from '@superego/protocol'

export type ReportsHost = {
  info(id: string): Promise<ThreadInfo | undefined>
  /** Whether it's in a run (its reports wait till it ends). */
  busy(thread: ThreadInfo): boolean
  /** Whether the report of process `id` is still worth sending: it's there, and its thread hasn't learnt how it ended. */
  wanted(id: string): boolean
  /** Send a thread its reports, those of each process, in order. */
  send(thread: string, processes: string[]): Promise<void>
  error(message: string, error: unknown): void
}

export type Batching = { quietMs: number; maxMs: number }
export const BATCHING: Batching = { quietMs: 5_000, maxMs: 30_000 }

/** Reports by thread: `report` a process's end; `idle` says a thread's run ended; `stop` drops what waits. */
export function reporter(host: ReportsHost, { quietMs, maxMs }: Batching = BATCHING) {
  type Batch = { processes: Set<string>; first: number; due?: boolean; flushing?: boolean; ended?: boolean; timer?: ReturnType<typeof setTimeout> }
  const batches = new Map<string, Batch>()

  async function flush(thread: string) {
    const batch = batches.get(thread)
    if (!batch || batch.flushing) return
    batch.flushing = true
    const to = await host.info(thread)
    batch.flushing = false
    if (to?.continuedIn) { moved(thread, to.continuedIn); flushing(to.continuedIn); return }
    if (!to || to.archived) { batches.delete(thread); return }
    if (host.busy(to)) {
      batch.due = true
      if (batch.ended) { batch.ended = false; flushing(thread) }
      return
    }
    batches.delete(thread)
    const ids = [...batch.processes].filter((id) => host.wanted(id))
    if (ids.length) await host.send(thread, ids)
  }
  const flushing = (thread: string) => { flush(thread).catch((error) => host.error(`couldn't report to ${thread}`, error)) }
  function moved(from: string, to: string) {
    const batch = batches.get(from)
    if (!batch || from === to) return
    batches.delete(from)
    clearTimeout(batch.timer)
    const into = batches.get(to)
    if (!into) { batches.set(to, { processes: batch.processes, first: batch.first, due: true }); return }
    for (const id of batch.processes) into.processes.add(id)
    into.due = true
  }

  return {
    report(thread: string, process: string) {
      let batch = batches.get(thread)
      if (!batch) batches.set(thread, batch = { processes: new Set(), first: Date.now() })
      batch.processes.delete(process)
      batch.processes.add(process)
      if (batch.due) return
      clearTimeout(batch.timer)
      batch.timer = setTimeout(() => flushing(thread), Math.max(0, Math.min(quietMs, batch.first + maxMs - Date.now())))
    },
    idle(thread: string) {
      const batch = batches.get(thread)
      if (batch?.flushing) batch.ended = true
      else if (batch?.due) flushing(thread)
    },
    stop() {
      for (const batch of batches.values()) clearTimeout(batch.timer)
      batches.clear()
    },
  }
}
