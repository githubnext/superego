// @vitest-environment happy-dom
// A window's own state: kept under its id, beside the state every window shares; a new window starting as a copy of
// the one it came from; the state of windows gone for good dropped.
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** local-state.ts as a window at `search` loads it. */
async function load(search: string) {
  history.replaceState(null, '', `/index.html${search}`)
  vi.resetModules()
  return import('../src/renderer/local-state.ts')
}

beforeEach(() => localStorage.clear())

describe("a desktop window's state", () => {
  it('is its own, beside what every window shares', async () => {
    const { setLocalState, firstWindow } = await load('?window=a&first=1')
    expect(firstWindow).toBe(true)
    setLocalState('selection', { thread: 't1' }, undefined)
    setLocalState('draft.x', 'hi', '', { shared: true })
    expect(localStorage.getItem('superego.window.a.selection')).toBe('{"thread":"t1"}')
    expect(localStorage.getItem('superego.draft.x')).toBe('"hi"')
    const other = await load('?window=b')
    expect(other.firstWindow).toBe(false)
    expect(other.windowState()).toEqual({})
    expect(other.createStore('draft.x', '', { persist: true, shared: true }).get()).toBe('hi')
    expect(other.createStore('selection', null, { persist: true }).get()).toBe(null)
  })

  it('starts as a copy of the window it was opened from, taken once', async () => {
    const from = await load('?window=a&first=1')
    from.setLocalState('space', 'files', undefined)
    const seed = JSON.stringify(from.windowState())
    const copy = await load(`?window=b&seed=${encodeURIComponent(seed)}#x`)
    expect(copy.createStore('space', undefined, { persist: true }).get()).toBe('files')
    expect(location.search).toBe('?window=b')
    expect(location.hash).toBe('#x')
  })

  it('drops the state of windows gone for good', async () => {
    const { setLocalState, forgetWindows } = await load('?window=a')
    setLocalState('space', 'files', undefined)
    localStorage.setItem('superego.window.b.space', '"git"')
    localStorage.setItem('superego.window.c.space', '"git"')
    localStorage.setItem('superego.draft.x', '"kept"')
    forgetWindows(['b'])
    expect(Object.keys({ ...localStorage }).sort()).toEqual(['superego.draft.x', 'superego.window.a.space', 'superego.window.b.space'])
  })
})

it("the web app's one window keeps its state as it always has", async () => {
  const { setLocalState, firstWindow, windowState } = await load('')
  expect(firstWindow).toBe(true)
  setLocalState('selection', { thread: 't1' }, undefined)
  expect(localStorage.getItem('superego.selection')).toBe('{"thread":"t1"}')
  expect(windowState()).toEqual({})
})

it('drops state no longer kept from every window as one loads, the rest as it was', async () => {
  localStorage.setItem('superego.window.a.pane.widths', '{"t1":0.4}')
  localStorage.setItem('superego.window.b.pane.widths', '{"t2":0.3}')
  localStorage.setItem('superego.pane.widths', '{"t3":0.5}')
  localStorage.setItem('superego.window.a.pane.front', '{"t1":"p1"}')
  await load('?window=a')
  expect(Object.keys({ ...localStorage })).toEqual(['superego.window.a.pane.front'])
})
