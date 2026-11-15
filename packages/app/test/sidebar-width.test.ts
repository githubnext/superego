// The sidebar's width as kept, and as its edge is dragged: held within its bounds, and folding when let go short.
import { describe, expect, it } from 'vitest'
import { DEFAULT_WIDTH, dragSidebar, FOLD_AT, MAX_WIDTH, MIN_WIDTH, release, sidebarWidth } from '../src/renderer/sidebar-width.ts'

describe('the width kept', () => {
  it('is the default until one is kept', () => {
    expect(sidebarWidth(undefined)).toBe(DEFAULT_WIDTH)
    expect(sidebarWidth(null)).toBe(DEFAULT_WIDTH)
    expect(sidebarWidth('300')).toBe(DEFAULT_WIDTH)
    expect(sidebarWidth(Number.NaN)).toBe(DEFAULT_WIDTH)
  })

  it('is brought within its bounds', () => {
    expect(sidebarWidth(300)).toBe(300)
    expect(sidebarWidth(MAX_WIDTH + 200)).toBe(MAX_WIDTH)
    expect(sidebarWidth(20)).toBe(MIN_WIDTH)
    expect(sidebarWidth(250.6)).toBe(251)
  })
})

describe('dragging its edge', () => {
  it('follows the pointer between its least and its most', () => {
    expect(dragSidebar(300)).toEqual({ width: 300, folds: false })
    expect(dragSidebar(MAX_WIDTH + 1)).toEqual({ width: MAX_WIDTH, folds: false })
    expect(dragSidebar(2000)).toEqual({ width: MAX_WIDTH, folds: false })
  })

  it('holds at its least past it, and folds only once dragged short of FOLD_AT', () => {
    expect(dragSidebar(MIN_WIDTH - 1)).toEqual({ width: MIN_WIDTH, folds: false })
    expect(dragSidebar(FOLD_AT)).toEqual({ width: MIN_WIDTH, folds: false })
    expect(dragSidebar(FOLD_AT - 1)).toEqual({ width: MIN_WIDTH, folds: true })
    expect(dragSidebar(0)).toEqual({ width: MIN_WIDTH, folds: true })
    expect(dragSidebar(-50)).toEqual({ width: MIN_WIDTH, folds: true })
  })
})

describe('letting go', () => {
  it('folds it short of FOLD_AT, keeps a new width, and does nothing for the same one', () => {
    expect(release(dragSidebar(FOLD_AT - 1), 300)).toBe('fold')
    expect(release(dragSidebar(150), 300)).toBe(MIN_WIDTH)
    expect(release(dragSidebar(360), 300)).toBe(360)
    expect(release(dragSidebar(300), 300)).toBeUndefined()
  })

  it('does nothing after a drag from the rail that never brought the sidebar out', () => {
    expect(release(undefined, 300)).toBeUndefined()
  })
})
