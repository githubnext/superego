// A phone's drawer under a finger: which touches move it, how it follows, and where it settles when let go.
import { describe, expect, it } from 'vitest'
import { axisOf, drawerOffset, FLICK, pulls, settlesOpen, velocityOf } from '../src/renderer/drawer-swipe.ts'

describe('the drawer swipe', () => {
  it('waits for the slop, then takes a mostly sideways touch as sideways', () => {
    expect(axisOf(4, 2)).toBeUndefined()
    expect(axisOf(12, 3)).toBe('x')
    expect(axisOf(-12, 6)).toBe('x')
    expect(axisOf(3, 12)).toBe('y')
    // About 45°: a scroll, not the drawer.
    expect(axisOf(10, 10)).toBe('y')
  })

  it('pulls the shut drawer out to the right and pushes the open one back to the left', () => {
    expect(pulls(false, 10)).toBe(true)
    expect(pulls(false, -10)).toBe(false)
    expect(pulls(true, -10)).toBe(true)
    expect(pulls(true, 10)).toBe(false)
  })

  it('follows the finger, within the drawer', () => {
    expect(drawerOffset(false, 100, 300)).toBe(100)
    expect(drawerOffset(false, 500, 300)).toBe(300)
    expect(drawerOffset(true, -100, 300)).toBe(200)
    expect(drawerOffset(true, -500, 300)).toBe(0)
    expect(drawerOffset(true, 50, 300)).toBe(300)
  })

  it('settles by a flick, else by halfway', () => {
    expect(settlesOpen(200, 300, 0)).toBe(true)
    expect(settlesOpen(100, 300, 0)).toBe(false)
    expect(settlesOpen(40, 300, FLICK)).toBe(true)
    expect(settlesOpen(260, 300, -FLICK)).toBe(false)
    expect(settlesOpen(100, 300, FLICK / 2)).toBe(false)
  })
})

describe('how fast the finger went', () => {
  it('over its last 100ms', () => {
    const moves = [{ x: 0, t: 0 }, { x: 10, t: 100 }, { x: 40, t: 150 }, { x: 70, t: 200 }]
    expect(velocityOf(moves, 210)).toBeCloseTo(0.6)
  })

  it('is still once held before letting go', () => {
    expect(velocityOf([{ x: 0, t: 0 }, { x: 60, t: 50 }], 300)).toBe(0)
    expect(velocityOf([{ x: 0, t: 0 }], 10)).toBe(0)
  })
})
