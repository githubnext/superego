// @vitest-environment happy-dom
// Under a finger (a tap last, or `pointer: coarse` before any), nothing typed in takes the focus by itself as it opens:
// the on-screen keyboard would come up over it. With a mouse or a hardware keyboard, it does, as it always has.
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoFocusOnOpen, Dialog, TextField } from '@superego/ui'
import { focusRegion } from '../src/renderer/focus.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pointer = (coarse: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query === '(pointer: coarse)' ? coarse : false, media: query, addEventListener() {}, removeEventListener() {},
}))

let root: Root | undefined
beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.unstubAllGlobals()
})

describe.each([['a mouse', false], ['a finger', true]] as const)('under %s', (_, coarse) => {
  beforeEach(() => pointer(coarse))

  it(coarse ? 'opens a field without the focus' : 'opens a field focused', () => {
    expect(autoFocusOnOpen()).toBe(!coarse)
  })

  it(coarse ? 'focuses a pane, not the editor in it' : 'focuses a pane\'s editor', () => {
    document.body.innerHTML = '<div data-column="p" tabindex="-1"><div class="cm-content" contenteditable="true"></div></div>'
    const column = document.querySelector<HTMLElement>('[data-column]')!
    expect(focusRegion(column)).toBe(true)
    expect(document.activeElement).toBe(coarse ? column : column.querySelector('.cm-content'))
  })

  it(coarse ? 'opens a dialog with no field focused' : 'opens a dialog with its field focused', async () => {
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => {
      root!.render(h(Dialog, { onClose() {}, title: 'New thread', children: h(TextField, { 'aria-label': 'Prompt', autoFocus: autoFocusOnOpen() }) }))
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    const field = document.querySelector('input[aria-label="Prompt"]')
    expect(field).toBeTruthy()
    if (coarse) expect(document.activeElement?.matches('input, textarea')).toBe(false)
    else expect(document.activeElement).toBe(field)
  })

  it(coarse ? 'opens a dialog that is all field holding the focus itself' : 'opens a dialog that is all field in its field', async () => {
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => { root!.render(h(Dialog, { onClose() {}, label: 'Rename', children: h(TextField, { 'aria-label': 'Name' }) })) })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    const field = document.querySelector('input[aria-label="Name"]')
    expect(document.activeElement).toBe(coarse ? field!.closest('.superego-dialog') : field)
  })
})

// Last: what's in use sticks, for the rest of the file.
describe('on a finger-sized device (an iPad), what was used last', () => {
  beforeEach(() => pointer(true))
  const press = (pointerType: string) => window.dispatchEvent(new PointerEvent('pointerdown', { pointerType }))
  const key = (key: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }))
  const finger = () => document.documentElement.hasAttribute('data-finger')

  it('a hardware keyboard\'s shortcut or Tab hands the focus back to fields', () => {
    key('k', { metaKey: true })
    expect(autoFocusOnOpen()).toBe(true)
    expect(finger()).toBe(false)
    press('touch')
    expect(autoFocusOnOpen()).toBe(false)
    expect(finger()).toBe(true)
    key('Tab')
    expect(autoFocusOnOpen()).toBe(true)
  })

  it('typing on the on-screen keyboard doesn\'t', () => {
    press('touch')
    key('a')
    key('Enter')
    expect(autoFocusOnOpen()).toBe(false)
  })

  it('a trackpad does', () => {
    press('touch')
    press('mouse')
    expect(autoFocusOnOpen()).toBe(true)
    expect(finger()).toBe(false)
  })

  it('opens a dialog from a shortcut with its field focused', async () => {
    key('n', { metaKey: true })
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => { root!.render(h(Dialog, { onClose() {}, label: 'Rename', children: h(TextField, { 'aria-label': 'Name' }) })) })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="Name"]'))
  })
})
