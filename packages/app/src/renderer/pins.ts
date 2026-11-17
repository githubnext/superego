// Pinned threads: kept at the top of the sidebar, across projects and machines, in the order they were pinned. Pins
// are yours, not a thread's: an app setting (`app.pins`), the same in every window, each a thread's machine and id. A
// thread that stops being listed (archived) leaves them.
import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'

/** The app setting the pins are kept in: `Pin[]`, first pinned first. */
export const PINS = 'app.pins'
/** App setting: whether the sidebar shows the Pinned section (on, unless turned off). Off, pinned threads still top their projects. */
export const SHOW_PINNED = 'app.pins.shown'

export type Pin = { machine: string; thread: string }

const same = (a: Pin) => (b: Pin) => a.machine === b.machine && a.thread === b.thread

/** The pins in a setting's value: none while it isn't known. */
export const pinsOf = (value: unknown): Pin[] => Array.isArray(value) ? value as Pin[] : []

export const isPinned = (pins: readonly Pin[], at: Pin) => pins.some(same(at))

/** `at` pinned: last, or at `index` (moved there, if it was pinned already). */
export function pinAt(pins: readonly Pin[], at: Pin, index?: number): Pin[] {
  const rest = pins.filter((pin) => !same(at)(pin))
  const to = Math.max(0, Math.min(rest.length, index ?? rest.length))
  return [...rest.slice(0, to), { machine: at.machine, thread: at.thread }, ...rest.slice(to)]
}

export const unpin = (pins: readonly Pin[], at: Pin): Pin[] => pins.filter((pin) => !same(at)(pin))

/**
 * The pins whose threads are still listed: one archived (or gone) leaves them. Only where that's known: a machine
 * that's connected, with its threads heard; others keep theirs.
 */
export function stillListed(pins: readonly Pin[], machines: readonly MachineEntry[], threads: Record<string, ThreadInfo[] | undefined>): Pin[] {
  return pins.filter((pin) => {
    const list = threads[pin.machine]
    return !list || machines.find((m) => m.id === pin.machine)?.state !== 'connected' || list.some((t) => t.id === pin.thread)
  })
}
