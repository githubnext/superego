// The sidebar's width as kept, and as its edge is dragged: held within its bounds, and hiding when let go short.
import { describe, expect, it } from 'vitest'
import { DEFAULT_WIDTH, dragSidebar, HIDE_AT, MAX_WIDTH, MIN_WIDTH, release, sidebarWidth, widest } from '../src/renderer/sidebar-width.ts'

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

  it('shows no wider than 40% of the window, nor narrower than its least, and comes back as the window widens', () => {
    expect(widest(1100)).toBe(MAX_WIDTH)
    expect(widest(800)).toBe(320)
    expect(widest(601)).toBe(240)
    expect(widest(400)).toBe(MIN_WIDTH)
    expect(sidebarWidth(400, 800)).toBe(320)
    expect(sidebarWidth(300, 800)).toBe(300)
    expect(sidebarWidth(undefined, 500)).toBe(200)
    expect(sidebarWidth(400, 300)).toBe(MIN_WIDTH)
    expect(sidebarWidth(400, 1200)).toBe(400)
  })
})

describe('dragging its edge', () => {
  it('follows the pointer between its least and its most', () => {
    expect(dragSidebar(300)).toEqual({ width: 300, hides: false })
    expect(dragSidebar(MAX_WIDTH + 1)).toEqual({ width: MAX_WIDTH, hides: false })
    expect(dragSidebar(2000)).toEqual({ width: MAX_WIDTH, hides: false })
  })

  it('holds at its least past it, and hides only once dragged short of HIDE_AT', () => {
    expect(dragSidebar(MIN_WIDTH - 1)).toEqual({ width: MIN_WIDTH, hides: false })
    expect(dragSidebar(HIDE_AT)).toEqual({ width: MIN_WIDTH, hides: false })
    expect(dragSidebar(HIDE_AT - 1)).toEqual({ width: MIN_WIDTH, hides: true })
    expect(dragSidebar(0)).toEqual({ width: MIN_WIDTH, hides: true })
    expect(dragSidebar(-50)).toEqual({ width: MIN_WIDTH, hides: true })
  })

  it('stops at 40% of the window, and still hides', () => {
    expect(dragSidebar(300, 700)).toEqual({ width: 280, hides: false })
    expect(dragSidebar(250, 700)).toEqual({ width: 250, hides: false })
    expect(dragSidebar(HIDE_AT - 1, 700)).toEqual({ width: MIN_WIDTH, hides: true })
  })
})

describe('letting go', () => {
  it('hides it short of HIDE_AT, keeps a new width, and does nothing for the same one', () => {
    expect(release(dragSidebar(HIDE_AT - 1), 300)).toBe('hide')
    expect(release(dragSidebar(150), 300)).toBe(MIN_WIDTH)
    expect(release(dragSidebar(360), 300)).toBe(360)
    expect(release(dragSidebar(300), 300)).toBeUndefined()
  })

  it('keeps the capped width when let go at the window\'s cap', () => {
    expect(release(dragSidebar(500, 700), 400)).toBe(280)
    expect(release(dragSidebar(HIDE_AT - 1, 700), 400)).toBe('hide')
  })

  it('does nothing after a drag from the rail that never brought the sidebar out', () => {
    expect(release(undefined, 300)).toBeUndefined()
  })
})
