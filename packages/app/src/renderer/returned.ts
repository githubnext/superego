// What a stop gave back: the messages you'd queued for a thread, waiting their turn when it was stopped (`thread.stop`),
// to go back into its composer as text to write again. Only this window's stop (the one that pressed it) gives them
// here; the thread's composer takes them as it shows, at once if it shows already. In memory: they're the window's
// to fill its composer with, as anything else typed there.
import type { ReturnedMessage } from '@superego/protocol'

const waiting = new Map<string, ReturnedMessage[]>()
const listeners = new Set<() => void>()
const keyOf = (machine: string, thread: string) => `${machine}/${thread}`

/** Give back `returned` (a stop's) to thread `thread` on `machine`'s composer: after what it was given before. */
export function giveBack(machine: string, thread: string, returned: readonly ReturnedMessage[]) {
  if (!returned.length) return
  const key = keyOf(machine, thread)
  waiting.set(key, [...waiting.get(key) ?? [], ...returned])
  for (const listener of listeners) listener()
}

/** Take what was given back to the thread's composer, if anything: it's the taker's then. */
export function takeBack(machine: string, thread: string): ReturnedMessage[] {
  const key = keyOf(machine, thread)
  const taken = waiting.get(key) ?? []
  waiting.delete(key)
  return taken
}

/** Be told when something's given back (to any thread), until the function returned is called. */
export function onGivenBack(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
