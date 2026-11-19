// @vitest-environment happy-dom
// Under a finger (`pointer: coarse`), nothing typed in takes the focus by itself as it opens: the on-screen keyboard
// would come up over it. With a mouse, it does, as it always has.
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
