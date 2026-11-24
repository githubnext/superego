// The sidebar, shown or hidden: one state, which ⌘/, the open sidebar's rail button and the edge all change, and a tight
// window hides it by itself until it's shown there.
import { describe, expect, it } from 'vitest'
import { sidebarIsHidden, showSidebar, type SidebarMode } from '../src/renderer/sidebar-mode.ts'

const shown: SidebarMode = { open: true, shownTight: false }
const closed: SidebarMode = { open: false, shownTight: false }

describe('a wide window', () => {
  it('is shown while open, hidden while not', () => {
    expect(sidebarIsHidden(shown, false)).toBe(false)
    expect(sidebarIsHidden(closed, false)).toBe(true)
  })

  it('toggles between the two', () => {
    const hidden = showSidebar(shown, false)
    expect(hidden).toEqual(closed)
    expect(sidebarIsHidden(hidden, false)).toBe(true)
    expect(showSidebar(hidden, false)).toEqual(shown)
  })

  it('hides or shows as asked, whatever it was', () => {
    expect(showSidebar(shown, false, true)).toEqual(shown)
    expect(showSidebar(closed, false, false)).toEqual(closed)
    expect(showSidebar(shown, false, false)).toEqual(closed)
    expect(showSidebar(closed, false, true)).toEqual(shown)
  })
})

describe('a tight window', () => {
  it('hides it by itself, open or not', () => {
    expect(sidebarIsHidden(shown, true)).toBe(true)
    expect(sidebarIsHidden(closed, true)).toBe(true)
  })

  it('shows it for as long as it is tight, and hides it again without forgetting the window was left open', () => {
    const shownTight = showSidebar(shown, true)
    expect(shownTight).toEqual({ open: true, shownTight: true })
    expect(sidebarIsHidden(shownTight, true)).toBe(false)
    const again = showSidebar(shownTight, true)
    expect(again).toEqual(shown)
    expect(sidebarIsHidden(again, true)).toBe(true)
    expect(sidebarIsHidden(again, false)).toBe(false)
  })

  it('shown from closed, is open once wide again', () => {
    const shownTight = showSidebar(closed, true, true)
    expect(sidebarIsHidden(shownTight, true)).toBe(false)
    expect(sidebarIsHidden({ ...shownTight, shownTight: false }, false)).toBe(false)
  })

  it('hidden while closed stays closed', () => {
    expect(showSidebar(closed, true, false)).toEqual(closed)
  })
})
