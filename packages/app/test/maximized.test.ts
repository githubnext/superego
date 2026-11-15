// A maximized pane: when it lasts, what toggling does, and which Esc restores the layout.
import { describe, expect, it } from 'vitest'
import { maximizedPane, restoresOn, toggleMaximized, type Maximized } from '../src/renderer/maximized.ts'

const thread = 'local/t1'
const at: Maximized = { thread, pane: 'b', panes: ['a', 'b', 'c'] }

describe('while it lasts', () => {
  it('is the pane, in its thread, with its panes as they were', () => {
    expect(maximizedPane(at, thread, ['a', 'b', 'c'])).toBe('b')
  })

  it('outlasts another pane closing', () => {
    expect(maximizedPane(at, thread, ['b', 'c'])).toBe('b')
  })

  it('ends as the pane closes', () => {
    expect(maximizedPane(at, thread, ['a', 'c'])).toBeUndefined()
  })

  it('ends as another pane opens', () => {
    expect(maximizedPane(at, thread, ['a', 'b', 'c', 'd'])).toBeUndefined()
    // Even with one closed meanwhile: the new one is still new.
    expect(maximizedPane(at, thread, ['b', 'd'])).toBeUndefined()
  })

  it('ends as another thread is shown', () => {
    expect(maximizedPane(at, 'local/t2', ['a', 'b', 'c'])).toBeUndefined()
    expect(maximizedPane(at, 'other/t1', ['a', 'b', 'c'])).toBeUndefined()
  })

  it('is none when nothing is', () => {
    expect(maximizedPane(undefined, thread, ['a'])).toBeUndefined()
  })
})

describe('toggling', () => {
  const panes = ['a', 'b', 'c']

  it('maximizes the focused pane, and restores it again', () => {
    const next = toggleMaximized(undefined, thread, panes, undefined, 'a')
    expect(next).toEqual({ thread, pane: 'a', panes })
    expect(toggleMaximized(next, thread, panes, undefined, 'a')).toBeUndefined()
    // Restore restores, whichever has the focus.
    expect(toggleMaximized(next, thread, panes, undefined, 'b')).toBeUndefined()
  })

  it('does nothing with the thread focused', () => {
    expect(toggleMaximized(undefined, thread, panes, undefined, undefined)).toBeUndefined()
  })

  it('maximizes a pane named, or restores it when it is the one', () => {
    expect(toggleMaximized(undefined, thread, panes, 'c', 'a')).toEqual({ thread, pane: 'c', panes })
    expect(toggleMaximized(at, thread, panes, 'b', 'b')).toBeUndefined()
    expect(toggleMaximized(at, thread, panes, 'a', 'b')).toEqual({ thread, pane: 'a', panes })
  })

  it('takes only an open pane', () => {
    expect(toggleMaximized(undefined, thread, panes, 'gone', undefined)).toBeUndefined()
  })

  it('maximizes afresh over one left from another thread', () => {
    expect(toggleMaximized(at, 'local/t2', ['x'], undefined, 'x')).toEqual({ thread: 'local/t2', pane: 'x', panes: ['x'] })
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
