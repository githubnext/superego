// A maximized column (the thread's or a pane's): when it lasts, what toggling does, and which Esc restores the layout.
import { describe, expect, it } from 'vitest'
import { maximizedColumn, restoresOn, THREAD_COLUMN, toggleMaximized, type Maximized } from '../src/renderer/maximized.ts'

const thread = 'local/t1'
const at: Maximized = { thread, column: 'b', panes: ['a', 'b', 'c'] }

describe('while it lasts', () => {
  it('is the pane, in its thread, with its panes as they were', () => {
    expect(maximizedColumn(at, thread, ['a', 'b', 'c'])).toBe('b')
  })

  it('outlasts another pane closing', () => {
    expect(maximizedColumn(at, thread, ['b', 'c'])).toBe('b')
  })

  it('ends as the pane closes', () => {
    expect(maximizedColumn(at, thread, ['a', 'c'])).toBeUndefined()
  })

  it('ends as another pane opens', () => {
    expect(maximizedColumn(at, thread, ['a', 'b', 'c', 'd'])).toBeUndefined()
    // Even with one closed meanwhile: the new one is still new.
    expect(maximizedColumn(at, thread, ['b', 'd'])).toBeUndefined()
  })

  it('ends as another thread is shown', () => {
    expect(maximizedColumn(at, 'local/t2', ['a', 'b', 'c'])).toBeUndefined()
    expect(maximizedColumn(at, 'other/t1', ['a', 'b', 'c'])).toBeUndefined()
  })

  it('is the thread, while its panes are as they were', () => {
    const maximized: Maximized = { thread, column: THREAD_COLUMN, panes: ['a', 'b'] }
    expect(maximizedColumn(maximized, thread, ['a', 'b'])).toBe(THREAD_COLUMN)
    expect(maximizedColumn(maximized, thread, ['a'])).toBe(THREAD_COLUMN)
    expect(maximizedColumn(maximized, thread, ['a', 'b', 'c'])).toBeUndefined()
    expect(maximizedColumn(maximized, 'local/t2', ['a', 'b'])).toBeUndefined()
  })

  it('is none when nothing is', () => {
    expect(maximizedColumn(undefined, thread, ['a'])).toBeUndefined()
  })
})

describe('toggling', () => {
  const panes = ['a', 'b', 'c']

  it('maximizes the focused pane, and restores it again', () => {
    const next = toggleMaximized(undefined, thread, panes, undefined, 'a')
    expect(next).toEqual({ thread, column: 'a', panes })
    expect(toggleMaximized(next, thread, panes, undefined, 'a')).toBeUndefined()
    // Restore restores, whichever has the focus.
    expect(toggleMaximized(next, thread, panes, undefined, 'b')).toBeUndefined()
  })

  it('maximizes the thread focused, and restores it again', () => {
    const next = toggleMaximized(undefined, thread, panes, undefined, THREAD_COLUMN)
    expect(next).toEqual({ thread, column: THREAD_COLUMN, panes })
    expect(toggleMaximized(next, thread, panes, undefined, THREAD_COLUMN)).toBeUndefined()
    expect(toggleMaximized(next, thread, panes, THREAD_COLUMN, 'a')).toBeUndefined()
  })

  it('leaves a thread without panes as it is: there is nothing to cover', () => {
    expect(toggleMaximized(undefined, thread, [], undefined, THREAD_COLUMN)).toBeUndefined()
  })

  it('maximizes a pane named, or restores it when it is the one', () => {
    expect(toggleMaximized(undefined, thread, panes, 'c', 'a')).toEqual({ thread, column: 'c', panes })
    expect(toggleMaximized(at, thread, panes, 'b', 'b')).toBeUndefined()
    expect(toggleMaximized(at, thread, panes, 'a', 'b')).toEqual({ thread, column: 'a', panes })
  })

  it('takes only an open pane', () => {
    expect(toggleMaximized(undefined, thread, panes, 'gone', THREAD_COLUMN)).toBeUndefined()
  })

  it('maximizes afresh over one left from another thread', () => {
    expect(toggleMaximized(at, 'local/t2', ['x'], undefined, 'x')).toEqual({ thread: 'local/t2', column: 'x', panes: ['x'] })
  })
})

describe('Esc', () => {
  const key = (key: string, more: Partial<KeyboardEvent> = {}) =>
    ({ key, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more })

  it('restores the layout, pressed in the thread’s area', () => {
    expect(restoresOn(key('Escape'), true)).toBe(true)
  })

  it('stays with what took it: an editor, a terminal, a menu', () => {
    expect(restoresOn(key('Escape', { defaultPrevented: true }), true)).toBe(false)
  })

  it('leaves a dialog’s to the dialog', () => {
    expect(restoresOn(key('Escape'), false)).toBe(false)
  })

  it('is a bare Esc only', () => {
    expect(restoresOn(key('Escape', { shiftKey: true }), true)).toBe(false)
    expect(restoresOn(key('Escape', { metaKey: true }), true)).toBe(false)
    expect(restoresOn(key('Enter'), true)).toBe(false)
  })
})
