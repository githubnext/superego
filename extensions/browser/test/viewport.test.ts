// @vitest-environment happy-dom
// A Browser pane's page at a size: picked from the toolbar's size menu (or typed in), kept in the pane's params, the
// page's box that wide (scaled down to fit), and Full the pane's width again.
import { afterEach, expect, it, vi } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import browser from '../src/ui.tsx'
import { BROWSER } from '../src/shared.ts'
import { fit, parseViewport } from '../src/viewport.ts'

let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount() })

it('reads a size typed in: a width, or a width and a height', () => {
  expect(parseViewport('1024')).toEqual({ width: 1024 })
  expect(parseViewport(' 1024 × 768 ')).toEqual({ width: 1024, height: 768 })
  expect(parseViewport('1024x768')).toEqual({ width: 1024, height: 768 })
  expect(parseViewport('1024px X 768px')).toEqual({ width: 1024, height: 768 })
  for (const not of ['', 'wide', '1024×', '×768', '10', '99999', '1024×768×2', '-390']) expect(parseViewport(not)).toBeUndefined()
})

it('fits a page in its stage: centred, scaled down to fit, never up', () => {
  expect(fit(undefined, 800, 600)).toBeUndefined()
  expect(fit({ width: 390 }, 800, 600)).toEqual({ width: 390, height: 600, left: 205, top: 0, scale: 1 })
  expect(fit({ width: 1600 }, 800, 600)).toEqual({ width: 1600, height: 1200, left: 0, top: 0, scale: 0.5 })
  expect(fit({ width: 400, height: 300 }, 800, 600)).toEqual({ width: 400, height: 300, left: 200, top: 150, scale: 1 })
  expect(fit({ width: 400, height: 1200 }, 800, 600)).toEqual({ width: 400, height: 1200, left: 300, top: 0, scale: 0.5 })
})

const thread = testThread({ id: 't1' })
function machine() {
  const updates: { params: unknown }[] = []
  const m = fakeMachine({ threads: [thread], methods: { 'pane.update': (params) => { updates.push(params as never); return null } } })
  return { m, updates }
}
const framed = () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  window.superego.webView = undefined
  window.superego.forward = undefined
}
const item = (text: string) => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) => el.textContent?.includes(text))

it('shows the page at the size picked, kept in the pane: from the menu, typed in, or Full again', async () => {
  const { m, updates } = machine()
  ui = await mountUi({ extensions: [browser], machines: [m] })
  framed()
  const url = 'https://example.com/'
  const full = await ui.render({ thread: 't1', pane: { id: 'p1', kind: BROWSER, params: { url } } })
  await vi.waitFor(() => expect(full.find('iframe')).not.toBeNull())
  expect(full.find('.browser-stage.is-sized')).toBeNull()
  expect(full.find('.browser-page')!.style.width).toBe('')

  await full.click('Page size')
  await vi.waitFor(() => expect(item('Small')).toBeDefined())
  item('Small')!.click()
  await vi.waitFor(() => expect(updates.at(-1)?.params).toEqual({ url, viewport: { width: 390 } }))

  // Drawn again from its params (as after a reload): that wide, its width on the button.
  const small = await ui.render({ thread: 't1', pane: { id: 'p1', kind: BROWSER, params: { url, viewport: { width: 390 } } } })
  await vi.waitFor(() => expect(small.find('iframe')).not.toBeNull())
  expect(small.find('.browser-stage.is-sized')).not.toBeNull()
  expect(small.find('.browser-page')!.style.width).toBe('390px')
  expect(small.find('.browser-size')!.textContent).toBe('390')

  // Custom: typed in, a height too.
  await small.click('Page size')
  await vi.waitFor(() => expect(item('Custom')).toBeDefined())
  item('Custom')!.click()
  await vi.waitFor(() => expect(small.find('input.browser-size-field')).not.toBeNull())
  await ui.type('input.browser-size-field', 'wide')
  small.find('input.browser-size-field')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(small.find('input.browser-size-field')!.getAttribute('aria-invalid')).toBe('true'))
  await ui.type('input.browser-size-field', '1024×768')
  small.find('input.browser-size-field')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(updates.at(-1)?.params).toEqual({ url, viewport: { width: 1024, height: 768 } }))
  const custom = await ui.render({ thread: 't1', pane: { id: 'p1', kind: BROWSER, params: { url, viewport: { width: 1024, height: 768 } } } })
  await vi.waitFor(() => expect(custom.find('iframe')).not.toBeNull())
  expect(custom.find('.browser-page')!.style).toMatchObject({ width: '1024px', height: '768px' })

  // Going somewhere from the address bar keeps the size.
  await custom.click('Address')
  await ui.type('input.browser-address', 'example.org')
  custom.find('input.browser-address')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(updates.at(-1)?.params).toEqual({ url: 'https://example.org', viewport: { width: 1024, height: 768 } }))

  // Full: the pane's width again.
  await custom.click('Page size')
  await vi.waitFor(() => expect(item('Full')).toBeDefined())
  item('Full')!.click()
  await vi.waitFor(() => expect(updates.at(-1)?.params).toEqual({ url }))
})
