// The sidebar's two modes, full and folded: one state, which ⌘/, the open space's rail button and the edge all change,
// and a tight window folds by itself until it's unfolded there.
import { describe, expect, it } from 'vitest'
import { isFolded, showSidebar, type SidebarMode } from '../src/renderer/sidebar-mode.ts'

const full: SidebarMode = { open: true, unfolded: false }
const closed: SidebarMode = { open: false, unfolded: false }

describe('a wide window', () => {
  it('is full while open, folded while not', () => {
    expect(isFolded(full, false)).toBe(false)
    expect(isFolded(closed, false)).toBe(true)
  })

  it('toggles between the two', () => {
    const folded = showSidebar(full, false)
    expect(folded).toEqual(closed)
    expect(isFolded(folded, false)).toBe(true)
    expect(showSidebar(folded, false)).toEqual(full)
  })

  it('folds or shows as asked, whatever it was', () => {
    expect(showSidebar(full, false, true)).toEqual(full)
    expect(showSidebar(closed, false, false)).toEqual(closed)
    expect(showSidebar(full, false, false)).toEqual(closed)
    expect(showSidebar(closed, false, true)).toEqual(full)
  })
})

describe('a tight window', () => {
  it('folds by itself, open or not', () => {
    expect(isFolded(full, true)).toBe(true)
    expect(isFolded(closed, true)).toBe(true)
  })

  it('unfolds for as long as it is tight, and folds back without forgetting the window was left open', () => {
    const unfolded = showSidebar(full, true)
    expect(unfolded).toEqual({ open: true, unfolded: true })
    expect(isFolded(unfolded, true)).toBe(false)
    const again = showSidebar(unfolded, true)
    expect(again).toEqual(full)
    expect(isFolded(again, true)).toBe(true)
    expect(isFolded(again, false)).toBe(false)
  })

  it('unfolded from closed, is open once wide again', () => {
    const unfolded = showSidebar(closed, true, true)
    expect(isFolded(unfolded, true)).toBe(false)
    expect(isFolded({ ...unfolded, unfolded: false }, false)).toBe(false)
  })

  it('folded while closed stays closed', () => {
    expect(showSidebar(closed, true, false)).toEqual(closed)
  })
})
