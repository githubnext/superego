// Sections: the rail picks what the whole window is about. Each sidebar in the rail is a section, the sidebar where you
// pick and the main area what you picked there, and one is shown at a time, its button the one lit. A sidebar whose
// extension declares spaces (Notes' list, its notes) holds those spaces; any other (Threads, Staff) holds threads.
// Picking a rail button shows its section as it was left: what it held of its own (the last thread with its panes, the
// last note), else nothing yet. What's shown from elsewhere takes its section with it: a note's link shows Notes, a
// thread from ⌘L stays in the thread section shown (else the last one); a space no sidebar holds (a rail button's,
// Vault's) is shown alone, with no sidebar, as Ego's thread is. A project's spaces are rows of the Threads sidebar:
// they're held by the thread section.

import { sameSpace, type SpaceAt } from './history.ts'

type Selection = { machine: string; thread: string }

/** What a section's main area holds: a thread (with its panes) or a space. */
export type Held = { thread: Selection } | { space: SpaceAt }

/** A section as the rules need it: its sidebar's id; one that holds spaces says which (`owns`), else it holds threads. */
export type Section = { id: string; owns?(space: SpaceAt): boolean }

/** No sidebar: what's shown alone (a space no sidebar holds). */
export const ALONE = ''

export type Sections = {
  /** The section shown: a sidebar's id, or `ALONE`; unset, the first. */
  at?: string
  /** What each section's main area holds now, by id. */
  held: Record<string, Held>
  /** What each holds of its own (a space, or a thread its sidebar lists): shown again when you come back to it. */
  kept: Record<string, Held>
  /** The thread section last shown: where a thread shown from elsewhere goes. */
  threads?: string
  /** The section with a sidebar last shown: what a phone's drawer shows while the one shown has none. */
  sidebar?: string
}

export const NO_SECTIONS: Sections = { held: {}, kept: {} }

export const sameHeld = (a: Held | undefined, b: Held | undefined) => {
  if (!a || !b) return a === b
  if ('space' in a || 'space' in b) return 'space' in a && 'space' in b && sameSpace(a.space, b.space)
  return a.thread.machine === b.thread.machine && a.thread.thread === b.thread.thread
}

const holdsThreads = (sections: Section[], id: string | undefined) => Boolean(id !== undefined && sections.some((s) => s.id === id && !s.owns))

/** The section shown: `at`, while it's one of `sections` (or alone); else the first, if any. */
export function shownSection(state: Sections, sections: Section[]): string {
  const { at } = state
  if (at === ALONE && state.held[ALONE]) return ALONE
  if (at !== undefined && sections.some((s) => s.id === at)) return at
  return sections[0]?.id ?? ALONE
}

/**
 * What the main area shows: what the section shown holds; while the section left is gone (its sidebar taken out of the
 * layout, or not loaded yet), what it held, in the one shown instead.
 */
export function shownHeld(state: Sections, sections: Section[]): Held | undefined {
  const at = shownSection(state, sections)
  return state.held[at] ?? (state.at !== undefined && state.at !== at ? state.held[state.at] : undefined)
}

/** The section a thread goes to: the one shown, if it holds threads; else the last that did; else the first; else none. */
function threadSection(state: Sections, sections: Section[]): string {
  const now = shownSection(state, sections)
  if (holdsThreads(sections, now)) return now
  if (holdsThreads(sections, state.threads)) return state.threads!
  return sections.find((s) => !s.owns)?.id ?? ALONE
}

/** The section `held` belongs in: a space's sidebar (one that owns it); a thread's, or a project's space's, a thread section. */
export function sectionFor(state: Sections, held: Held, sections: Section[]): string {
  if ('space' in held) {
    const owner = sections.find((s) => s.owns?.(held.space))
    if (owner) return owner.id
    if (!held.space.project) return ALONE
  }
  return threadSection(state, sections)
}

/** Show `held` (a thread selected, a space opened, back or forward), in its section. */
export function show(state: Sections, held: Held, sections: Section[]): Sections {
  const at = sectionFor(state, held, sections)
  return { ...state, at, held: { ...state.held, [at]: held }, ...(holdsThreads(sections, at) ? { threads: at } : {}), ...(at !== ALONE ? { sidebar: at } : {}) }
}

/** A window's sections starting on `held`, in its section, as its own: a window opened where it was left. */
export const startingWith = (held: Held, sections: Section[]): Sections => keep(show(NO_SECTIONS, held, sections), sections, () => true)

/** Show nothing in the section shown (no thread selected). What it kept stays, to come back to. */
export function clear(state: Sections, sections: Section[]): Sections {
  const { [shownSection(state, sections)]: _, ...held } = state.held
  return { ...state, held }
}

/** Show section `id` (its rail button), as it was left: what it kept of its own, else nothing yet. */
export function showSection(state: Sections, id: string, sections: Section[]): Sections {
  const { [id]: _, ...rest } = state.held
  const kept = state.kept[id]
  return { ...state, at: id, held: kept ? { ...rest, [id]: kept } : rest, sidebar: id, ...(holdsThreads(sections, id) ? { threads: id } : {}) }
}

/**
 * Keep what the section shown holds as its own, if it is (`own`: a space, or a thread its sidebar lists, not one shown
 * there from elsewhere: Ego's): what coming back to it shows. The same state when nothing changes.
 */
export function keep(state: Sections, sections: Section[], own: (held: Held) => boolean): Sections {
  const at = shownSection(state, sections)
  const held = state.held[at]
  if (at === ALONE || !held || !own(held) || sameHeld(state.kept[at], held)) return state
  return { ...state, kept: { ...state.kept, [at]: held } }
}
