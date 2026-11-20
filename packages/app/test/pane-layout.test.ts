// The pane row's arithmetic: column widths scrolled and stacked, and which pane a stack shows.
import { describe, expect, it } from 'vitest'
import { arranged, dropIndex, endShare, frontOf, GAP, keptWidths, MIN_COLUMN, moved, placeAmong, roomFor, scrollWidths, slideOf, SNAP, stackWidths } from '../src/renderer/pane-layout.ts'

describe('scrolled', () => {
  it('gives each column its share and the last what the others leave', () => {
    const room = roomFor(1200 + 3 * GAP, 3)
    expect(room).toBe(1200)
    expect(scrollWidths(room, [0.5, 0.4, undefined])).toEqual([600, 480, MIN_COLUMN])
    expect(scrollWidths(room, [0.4, undefined])).toEqual([480, 720])
  })

  it('keeps a dragged last column its own width', () => {
    expect(scrollWidths(1200, [0.5, 0.35])).toEqual([600, 420])
  })

  it('lets the row run past the window rather than squeeze a column under its least', () => {
    const widths = scrollWidths(1000, [0.5, 0.5, 0.2, undefined])
    expect(widths).toEqual([500, 500, MIN_COLUMN, MIN_COLUMN])
    expect(widths.reduce((sum, w) => sum + w, 0)).toBeGreaterThan(1000)
  })

  it('lets the last column be dragged wider than what the others leave, and takes that again near it', () => {
    // The others leave 600: dragged out to 900, it's its own width and the row scrolls; back near 600, it fills.
    expect(endShare(900, 1200, 600)).toBe(0.75)
    expect(endShare(600 + SNAP, 1200, 600)).toBeUndefined()
    expect(endShare(500, 1200, 600)).toBeCloseTo(500 / 1200)
    // The row scrolls already (the others leave less than the least): it still grows, from the least.
    expect(endShare(MIN_COLUMN + 100, 1200, 1100)).toBeCloseTo((MIN_COLUMN + 100) / 1200)
    expect(endShare(MIN_COLUMN, 1200, 1100)).toBeUndefined()
    expect(endShare(5000, 1200, 0)).toBe(1)
  })

  it('never makes a column wider than the room', () => {
    expect(scrollWidths(300, [0.5, undefined])).toEqual([300, 300])
  })
})

describe('scrolled, the thread kept in view', () => {
  it('fills the row as scrolled does while the panes fit', () => {
    expect(keptWidths(1200, [0.5, undefined])).toEqual(scrollWidths(1200, [0.5, undefined]))
    expect(keptWidths(1200, [0.4, undefined])).toEqual([480, 720])
  })

  it('keeps every pane narrow enough to show whole beside the thread', () => {
    // Four columns' room of 1200 (the row 1232): the thread 600; in view beside it, 1232 less it and two gaps.
    const room = 1200
    const [thread, ...panes] = keptWidths(room, [0.5, 0.9, 0.8, undefined])
    expect(thread).toBe(600)
    for (const pane of panes) expect(pane).toBeLessThanOrEqual(room + 4 * GAP - thread! - 2 * GAP)
    expect(panes.at(-1)).toBe(MIN_COLUMN)
  })

  it('leaves the panes room however wide the thread is dragged', () => {
    expect(keptWidths(1200, [0.85, undefined])).toEqual([1200 - MIN_COLUMN, MIN_COLUMN])
    expect(keptWidths(600, [0.85, undefined])).toEqual([300, 300])
  })
})

describe('stacked', () => {
  it('splits the room between the thread and its panes', () => {
    expect(stackWidths(1200, undefined)).toEqual([600, 600])
    expect(stackWidths(1200, 0.4)).toEqual([480, 720])
  })

  it('never passes the window, however the thread was dragged', () => {
    for (const room of [500, 900, 1600]) {
      for (const share of [0.15, 0.5, 0.85]) {
        const [thread, stack] = stackWidths(room, share)
        expect(thread + stack).toBe(room)
        expect(Math.min(thread, stack)).toBeGreaterThanOrEqual(Math.min(MIN_COLUMN, Math.floor(room / 2)))
      }
    }
  })

  it('shows the pane last brought forward, else the focused one, else the last', () => {
    const panes = ['a', 'b', 'c']
    expect(frontOf(panes, 'b', 'a')).toBe('b')
    expect(frontOf(panes, 'gone', 'a')).toBe('a')
    expect(frontOf(panes, undefined, undefined)).toBe('c')
    expect(frontOf([], 'a', 'a')).toBeUndefined()
  })
})

describe('moving a pane', () => {
  it('moves one to a place, clamped to the ends', () => {
    expect(moved(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moved(['a', 'b', 'c'], 'a', 9)).toEqual(['b', 'c', 'a'])
    expect(moved(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
    expect(moved(['a', 'b'], 'z', 0)).toEqual(['a', 'b'])
  })

  it('shows the order asked for while it is the same panes, else the thread\'s', () => {
    const panes = [{ id: 'a' }, { id: 'b' }]
    expect(arranged(panes, ['b', 'a']).map((p) => p.id)).toEqual(['b', 'a'])
    expect(arranged(panes, undefined)).toBe(panes)
    expect(arranged(panes, ['b', 'a', 'c'])).toBe(panes)
    expect(arranged(panes, ['b', 'c'])).toBe(panes)
  })

  it('drops a dragged tab past each whose middle its leading edge has passed', () => {
    const slots = [{ left: 0, width: 100 }, { left: 104, width: 60 }, { left: 168, width: 40 }]
    expect(dropIndex(slots, 0, 20)).toBe(0)
    // Its right edge (100 + 40) past the second's middle (134).
    expect(dropIndex(slots, 0, 40)).toBe(1)
    // As far as it goes (its right edge at the last's): last, however narrow the last.
    expect(dropIndex(slots, 0, 108)).toBe(2)
    expect(dropIndex(slots, 2, -50)).toBe(1)
    expect(dropIndex(slots, 2, -130)).toBe(0)
    expect(dropIndex(slots, 1, 0)).toBe(1)
  })

  it('slides the tabs between where it was and where it is aside by its size', () => {
    expect([0, 1, 2, 3].map((i) => slideOf(i, 0, 2, 50))).toEqual([0, -50, -50, 0])
    expect([0, 1, 2, 3].map((i) => slideOf(i, 3, 1, 50))).toEqual([0, 50, 50, 0])
    expect([0, 1, 2].map((i) => slideOf(i, 1, 1, 50))).toEqual([0, 0, 0])
  })

  it('places it among all the panes by the ones shown, those out of sight keeping theirs', () => {
    // b is out of sight (the title bar's ···, a kind not drawn here): d dropped first among the shown goes before a.
    expect(placeAmong(['a', 'b', 'c', 'd'], ['a', 'c', 'd'], 'd', 0)).toBe(0)
    // Between a and c: before c, so after b.
    expect(placeAmong(['a', 'b', 'c', 'd'], ['a', 'c', 'd'], 'd', 1)).toBe(2)
    // Last among the shown: after c, the last other shown.
    expect(placeAmong(['a', 'b', 'c', 'd'], ['a', 'c', 'd'], 'a', 2)).toBe(3)
    expect(placeAmong(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', 2)).toBe(2)
  })
})
