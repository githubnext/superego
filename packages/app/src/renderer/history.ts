// Back and forward, as a browser has them: the places this window has shown (a thread, a space, Settings), in memory. Going
// somewhere new after going back drops what was ahead; going back or forward moves along without adding a place.
// Places that are gone by then (a thread archived or deleted) are stepped over.

import type { Json } from '@superego/protocol'

/** A space open in the main area: its kind, on a machine, with its params. */
export type SpaceAt = { machine: string; kind: string; params: Record<string, Json> }

export type Place = { thread: { machine: string; thread: string } } | { space: SpaceAt } | { settings: true }

/** Whether two spaces are the same one: of a kind, on a machine, with the same params. */
export const sameSpace = (a: SpaceAt | undefined, b: SpaceAt | undefined) =>
  !a || !b ? a === b : a.machine === b.machine && a.kind === b.kind && JSON.stringify(a.params) === JSON.stringify(b.params)

export type History = { places: Place[]; at: number }

/** How many places a window keeps; the oldest go first. */
const LIMIT = 200

export const emptyHistory: History = { places: [], at: -1 }

export function samePlace(a: Place | undefined, b: Place | undefined): boolean {
  if (!a || !b) return a === b
  if ('settings' in a || 'settings' in b) return 'settings' in a && 'settings' in b
  if ('space' in a || 'space' in b) return 'space' in a && 'space' in b && sameSpace(a.space, b.space)
  return a.thread.machine === b.thread.machine && a.thread.thread === b.thread.thread
}

/**
 * The window now shows `place`. Already where history is, nothing changes. Leaving Settings for the place shown before
 * it is going back (closing it); anywhere else is a new place after this one, and what was ahead is dropped.
 */
export function visit(history: History, place: Place): History {
  const { places, at } = history
  if (samePlace(places[at], place)) return history
  if (places[at] && 'settings' in places[at] && samePlace(places[at - 1], place)) return { places, at: at - 1 }
  const next = [...places.slice(0, at + 1), place].slice(-LIMIT)
  return { places: next, at: next.length - 1 }
}

/** The place `by` steps along (-1 back, 1 forward), past those gone and the one shown; undefined at the end. */
export function step(history: History, by: -1 | 1, here: Place | undefined, exists: (place: Place) => boolean): { history: History; place: Place } | undefined {
  for (let i = history.at + by; i >= 0 && i < history.places.length; i += by) {
    const place = history.places[i]!
    if (exists(place) && !samePlace(place, here)) return { history: { ...history, at: i }, place }
  }
  return undefined
}
