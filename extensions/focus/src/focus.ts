// The focus set: threads (a machine and id each) kept in an app setting. A thread's sub-threads come and go with it:
// focused, those it has started are too, and one it starts later joins on its own; unfocused, they leave with it.
// Focus mode narrows the sidebar to the set, and to every thread that needs you (a question, a permission, a failure),
// which is never hidden.
import type { MachineEntry, ThreadInfo } from '@superego/app/ui'
import type { Focused } from './shared.ts'

/** Every machine's threads in use, by machine id: what the window lists. */
export type Threads = Readonly<Record<string, readonly ThreadInfo[] | undefined>>

const same = (a: Focused) => (b: Focused) => a.machine === b.machine && a.thread === b.thread

/** The set in a setting's value: none while it isn't known. */
export const focusedOf = (value: unknown): Focused[] => Array.isArray(value) ? value as Focused[] : []

export const isFocused = (set: readonly Focused[], at: Focused) => set.some(same(at))

/** `at` and every thread under it (started by it, or by one of those), on its machine. */
function family(threads: Threads, at: Focused): Focused[] {
  const list = threads[at.machine] ?? []
  const found: Focused[] = [at]
  for (let i = 0; i < found.length; i++) {
    for (const t of list) if (t.parent === found[i]!.thread && !found.some((f) => f.thread === t.id)) found.push({ machine: at.machine, thread: t.id })
  }
  return found
}

/** The set with `at` in focus, and the threads under it. */
export function focus(set: readonly Focused[], at: Focused, threads: Threads): Focused[] {
  return [...set, ...family(threads, at).filter((f) => !isFocused(set, f))]
}

/** The set without `at`, nor the threads under it. */
export function unfocus(set: readonly Focused[], at: Focused, threads: Threads): Focused[] {
  const leaving = family(threads, at)
  return set.filter((f) => !isFocused(leaving, f))
}

/** `at` in focus if it wasn't, out if it was, with the threads under it. */
export const toggle = (set: readonly Focused[], at: Focused, threads: Threads) =>
  isFocused(set, at) ? unfocus(set, at, threads) : focus(set, at, threads)

/** The set with `thread`, new on `machine`, in it when the thread that started it is: undefined when it doesn't join. */
export function joined(set: readonly Focused[], machine: string, thread: ThreadInfo): Focused[] | undefined {
  if (!thread.parent || !isFocused(set, { machine, thread: thread.parent }) || isFocused(set, { machine, thread: thread.id })) return undefined
  return [...set, { machine, thread: thread.id }]
}

/** Whether a thread waits on you: a question, a permission, signing in, or a failure. Focus mode never hides one. */
export const needsYou = (thread: ThreadInfo) => thread.status.state === 'blocked' || thread.status.state === 'error'

/** Whether focus mode shows `thread` on `machine`: in focus, or it needs you. */
export const shows = (set: readonly Focused[], machine: string, thread: ThreadInfo) => needsYou(thread) || isFocused(set, { machine, thread: thread.id })

/**
 * The set without threads no longer listed (archived, or gone). Only where that's known: a machine that's connected,
 * with its threads heard; others keep theirs.
 */
export function stillListed(set: readonly Focused[], machines: readonly MachineEntry[], threads: Threads): Focused[] {
  return set.filter((f) => {
    const list = threads[f.machine]
    return !list || machines.find((m) => m.id === f.machine)?.state !== 'connected' || list.some((t) => t.id === f.thread)
  })
}

/** Minutes left of a timed focus mode, rounded up: at least 1 while any is. */
export const minutesLeft = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 60_000))
