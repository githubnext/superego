// The rail's sections: one shown at a time, its sidebar and what it holds in the main area; picking one shows it as it
// was left; what's shown from elsewhere takes its section with it.
import { describe, expect, it } from 'vitest'
import { ALONE, clear, keep, NO_SECTIONS, show, showSection, shownHeld, shownSection, type Held, type Section, type Sections } from '../src/renderer/sections.ts'
import type { SpaceAt } from '../src/renderer/history.ts'

const threads: Section = { id: 'threads.list' }
const staff: Section = { id: 'staff.sidebar' }
const notes: Section = { id: 'notes.list', owns: (at) => at.kind === 'notes.page' }
const sections = [threads, notes, staff]

const thread = (id: string): Held => ({ thread: { machine: 'local', thread: id } })
const space = (kind: string, params = {}, project?: string): Held => ({ space: { machine: 'local', kind, params, ...(project ? { project } : {}) } as SpaceAt })
/** Every thread and space its own, as the window keeps them once they're listed. */
const kept = (state: Sections) => keep(state, sections, () => true)

describe('sections', () => {
  it('starts on the first section, holding nothing', () => {
    expect(shownSection(NO_SECTIONS, sections)).toBe('threads.list')
    expect(shownHeld(NO_SECTIONS, sections)).toBeUndefined()
    // With no sidebars, what's shown is alone.
    expect(shownSection(show(NO_SECTIONS, thread('a'), []), [])).toBe(ALONE)
  })

  it('shows a thread in the thread section shown, a note in Notes, and each again as it was left', () => {
    let state = kept(show(NO_SECTIONS, thread('a'), sections))
    expect(shownSection(state, sections)).toBe('threads.list')
    // A note's link, from the thread: Notes, holding the note.
    state = kept(show(state, space('notes.page', { name: 'ideas' }), sections))
    expect(shownSection(state, sections)).toBe('notes.list')
    expect(shownHeld(state, sections)).toEqual(space('notes.page', { name: 'ideas' }))
    // Threads' button: back to the thread.
    state = showSection(state, 'threads.list', sections)
    expect(shownHeld(state, sections)).toEqual(thread('a'))
    // Notes' button: the note again.
    state = showSection(state, 'notes.list', sections)
    expect(shownHeld(state, sections)).toEqual(space('notes.page', { name: 'ideas' }))
  })

  it("shows a section picked for the first time empty, and each thread section's own thread", () => {
    let state = kept(show(NO_SECTIONS, thread('a'), sections))
    state = showSection(state, 'staff.sidebar', sections)
    expect(shownHeld(state, sections)).toBeUndefined()
    state = kept(show(state, thread('lead'), sections))
    expect(shownSection(state, sections)).toBe('staff.sidebar')
    state = showSection(state, 'threads.list', sections)
    expect(shownHeld(state, sections)).toEqual(thread('a'))
    state = showSection(state, 'staff.sidebar', sections)
    expect(shownHeld(state, sections)).toEqual(thread('lead'))
  })

  it('takes a thread shown from a section holding spaces to the thread section last shown', () => {
    let state = showSection(kept(show(NO_SECTIONS, thread('lead'), sections)), 'staff.sidebar', sections)
    state = kept(show(state, thread('lead'), sections))
    state = showSection(state, 'notes.list', sections)
    state = show(state, thread('b'), sections)
    expect(shownSection(state, sections)).toBe('staff.sidebar')
  })

  it("shows a space no sidebar holds alone, and a project's space in the thread section", () => {
    let state = kept(show(NO_SECTIONS, thread('a'), sections))
    state = show(state, space('vault.space'), sections)
    expect(shownSection(state, sections)).toBe(ALONE)
    expect(state.sidebar).toBe('threads.list')
    state = showSection(state, 'threads.list', sections)
    expect(shownHeld(state, sections)).toEqual(thread('a'))
    state = show(state, space('board.main', {}, '/src/shop'), sections)
    expect(shownSection(state, sections)).toBe('threads.list')
  })

  it("keeps only what's its own: back from a thread shown there from elsewhere (Ego's), to the one it listed", () => {
    const listed = new Set(['a'])
    const own = (h: Held) => 'space' in h || listed.has(h.thread.thread)
    let state = keep(show(NO_SECTIONS, thread('a'), sections), sections, own)
    state = keep(show(state, thread('ego'), sections), sections, own)
    expect(shownHeld(state, sections)).toEqual(thread('ego'))
    state = showSection(state, 'threads.list', sections)
    expect(shownHeld(state, sections)).toEqual(thread('a'))
    // Nothing to keep: the same state.
    expect(keep(state, sections, own)).toBe(state)
  })

  it('clears the section shown, keeping what it kept to come back to', () => {
    let state = kept(show(NO_SECTIONS, thread('a'), sections))
    state = clear(state, sections)
    expect(shownHeld(state, sections)).toBeUndefined()
    state = showSection(showSection(state, 'notes.list', sections), 'threads.list', sections)
    expect(shownHeld(state, sections)).toEqual(thread('a'))
  })

  it('shows the first section while the one left is gone (not loaded yet, or out of the layout), with what it held', () => {
    const state = kept(show(NO_SECTIONS, space('notes.page', { name: 'ideas' }), sections))
    expect(shownSection(state, [threads])).toBe('threads.list')
    expect(shownHeld(state, [threads])).toEqual(space('notes.page', { name: 'ideas' }))
    expect(shownSection(state, sections)).toBe('notes.list')
    // No sidebars at all: what was shown, alone.
    expect(shownSection(state, [])).toBe(ALONE)
    expect(shownHeld(state, [])).toEqual(space('notes.page', { name: 'ideas' }))
  })
})
