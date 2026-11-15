// The pane row's arithmetic: column widths scrolled and stacked, and which pane a stack shows.
import { describe, expect, it } from 'vitest'
import { frontOf, GAP, MIN_COLUMN, roomFor, scrollWidths, stackWidths } from '../src/renderer/pane-layout.ts'

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

  it('never makes a column wider than the room', () => {
    expect(scrollWidths(300, [0.5, undefined])).toEqual([300, 300])
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
