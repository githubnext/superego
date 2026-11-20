// @vitest-environment happy-dom
// Select element in a Browser pane, over a real daemon, in the window drawn whole: the toolbar's button (and ⌘⇧C) puts
// the page in pick mode, Esc leaves it; an element clicked shows in a card at the pane's foot with an image of it; Add
// to prompt puts it in the composer as a chip (two picks, two chips), and the message sent with them carries, for each,
// the page's address, the selector, the HTML and the image; the transcript draws a chip for each. Framed (Web access),
// a page of another site can't be reached into: the button says so.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window as PageWindow } from 'happy-dom'
import { MESSAGE_ENTRY } from '@superego/protocol'
import { mountUi, testDaemon, testThread, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import browser from '../src/ui.tsx'
import { BROWSER } from '../src/shared.ts'
import { ELEMENT_TYPE } from '../src/element.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0))

let daemon: TestDaemon
let ui: TestWindow | undefined
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); ui = undefined; await daemon.close() })

/** A page in a view of its own, as the desktop shows it: its scripts run in a DOM of its own, its captures a PNG. */
function desktopPage(html: string) {
  const page = new PageWindow({ url: 'http://localhost:5179/pricing' })
  page.document.write(html)
  page.document.title = 'Pricing'
  const runs: string[] = []
  const captures: unknown[] = []
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  window.superego.forward = undefined
  window.superego.webView = ({ url }) => {
    const nothing = () => {}
    return {
      place: nothing, load: nothing, go: nothing, reload: nothing, stop: nothing, focus: nothing, reveal: nothing, answer: nothing,
      snapshot: async () => null,
      run: async (code) => {
        runs.push(code)
        return await (new Function('window', `return ${code}`) as (window: unknown) => unknown)(page)
      },
      capture: async (rect) => { captures.push(rect); return PNG },
      onEvent: (listener) => listener({ type: 'state', state: { url, title: 'Pricing', loading: false, canGoBack: false, canGoForward: false } }),
      close: nothing,
    }
  }
  const host = () => page.document.querySelector('superego-picker') as unknown as HTMLElement | null
  /** The pointer over the element `selector` finds in the page, then a click there. */
  const click = (selector: string) => {
    const el = page.document.querySelector(selector)!
    // Where it's drawn (this DOM lays nothing out): partly out of view, at the top.
    el.getBoundingClientRect = () => ({ left: 10, top: -10, width: 100, height: 30, right: 110, bottom: 20, x: 10, y: -10 }) as never
    Object.assign(page.document, { elementsFromPoint: () => [host()!, el] })
    host()!.dispatchEvent(new page.PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5 }) as never)
    host()!.dispatchEvent(new page.MouseEvent('click', { bubbles: true, cancelable: true }) as never)
  }
  return { page, runs, captures, host, click }
}

it('picks an element in the page, shows it, and sends it with the message as the page, its selector, its HTML and an image', async () => {
  const thread = await daemon.thread(undefined, { title: 'Pricing' })
  ui = await mountUi({ window: true, extensions: [browser], machines: [daemon], select: { thread: thread.id } })
  const { runs, host, click, captures } = desktopPage('<main><section class="plans"><button class="primary" type="submit">Start trial</button><a href="/faq">FAQ</a></section></main>')
  await daemon.call('pane.open', { thread: thread.id, kind: BROWSER, params: { url: 'http://localhost:5179/pricing' } })
  await ui.until(() => Boolean($('button[aria-label="Select element"]')), 'the button')
  const button = $('button[aria-label="Select element"]') as HTMLButtonElement
  expect(button.disabled).toBe(false)
  expect(button.title).toBe(`Select element (${navigator.platform.startsWith('Mac') ? '⌘⇧C' : 'Ctrl+Shift+C'})`)

  // Pick mode, from the button; Esc in the pane leaves it, and the page's layer goes.
  await ui.window!.click('button[aria-label="Select element"]')
  await ui.until(() => Boolean(host()), 'the page in pick mode')
  expect(button.getAttribute('aria-pressed')).toBe('true')
  expect($('.browser-toolbar')?.textContent).toContain('esc to cancel')
  $('.browser-frame .web-view')!.focus()
  await ui.key('escape')
  await ui.until(() => !host(), 'pick mode left')
  expect(button.getAttribute('aria-pressed')).toBe('false')
  // ⌘⇧C, with the pane's keyboard: pick mode again.
  $('.browser-frame .web-view')!.focus()
  await ui.key('mod+shift+c')
  await ui.until(() => Boolean(host()), 'pick mode from the keys')
  click('button.primary')
  await ui.until(() => Boolean($('.browser-picked')), 'the card')
  expect(host()).toBeNull()
  expect(runs.some((code) => code.includes('superego.picker'))).toBe(true)
  // Of the part in view.
  expect(captures).toEqual([{ x: 10, y: 0, width: 100, height: 20 }])
  expect($('.browser-picked__selector')?.textContent).toBe('button.primary')
  expect($('.browser-picked__about')?.textContent).toBe('<button class="primary" type="submit"> Start trial')
  expect($('.browser-picked__image')?.getAttribute('src')).toMatch(/^data:image\/png;base64,iVBOR/)

  // Copy selector.
  const copied = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: copied }, configurable: true })
  await ui.window!.click('button[aria-label="Copy selector"]')
  expect(copied).toHaveBeenCalledWith('button.primary')

  // Added: a chip in the composer, which has the keyboard; the card goes.
  await ui.window!.click('Add to prompt')
  await ui.until(() => $$('.composer-item').length === 1, 'the chip')
  expect($('.browser-picked')).toBeNull()
  expect($('.composer-item .attachment__name')?.textContent).toBe('<button.primary> · localhost:5179')
  expect(document.activeElement).toBe($('.composer textarea'))
  // A second: its own chip.
  await ui.window!.click('button[aria-label="Select element"]')
  await ui.until(() => Boolean(host()), 'pick mode again')
  click('a')
  await ui.until(() => Boolean($('.browser-picked')), 'the second card')
  await ui.window!.click('Add to prompt')
  await ui.until(() => $$('.composer-item').length === 2, 'two chips')
  expect($$('.composer-item .attachment__name').map((el) => el.textContent)).toEqual(['<button.primary> · localhost:5179', '<a> · localhost:5179'])
  // One taken off, and put back.
  await ui.window!.click('button[aria-label="Remove <a> · localhost:5179"]')
  await ui.until(() => $$('.composer-item').length === 1, 'one chip')

  await ui.type('.composer textarea', 'Make this bigger')
  await ui.key('enter')
  await ui.until(() => $$('.composer-item').length === 0, 'the chips sent')
  // The composer empties as it sends: the message is the daemon's a moment later, and its run is waited out after that.
  const sentMessage = async () => (JSON.parse(await daemon.transcript(thread.id)) as { kind: string; model?: { content: { type: string; text?: string; mimeType?: string }[] }[] }[])
    .find((e) => e.kind === MESSAGE_ENTRY)
  await vi.waitFor(async () => expect(await sentMessage()).toBeDefined())
  await daemon.idle(thread.id)
  const sent = (await sentMessage())!.model![0]!.content
  expect(sent.map((block) => block.type)).toEqual(['text', 'text', 'text', 'image'])
  expect(sent[0]!.text).toBe('Make this bigger')
  const note = sent[1]!.text!
  expect(note).toContain(`type="${ELEMENT_TYPE}"`)
  expect(note).toContain('The element I picked in the Browser pane: <button.primary> on http://localhost:5179/pricing ("Pricing").')
  expect(note).toContain('- Selector: `button.primary`')
  expect(note).toContain('```html\n<button class="primary" type="submit">Start trial</button>\n```')
  expect(sent[2]!.text).toMatch(/^<attachment name="element\.png" type="image\/png"/)
  expect(sent[3]!.mimeType).toBe('image/png')
  // In the transcript: a chip for the element, its note left out, its image beside it.
  await ui.until(() => Boolean($('.msg__files .attachment--chip')), 'the sent chip')
  expect($('.msg__files .attachment--chip')?.textContent).toBe('<button.primary> · localhost:5179')
  expect($('.msg__files .attachment--chip')?.getAttribute('title')).toBe('button.primary')
  const message = $('.msg__files .attachment--chip')!.closest('.msg--user')!
  expect(message.textContent).toBe('Make this bigger<button.primary> · localhost:5179')
  expect(message.querySelector('.image-frame')?.getAttribute('title')).toBe('element.png')
})

it('framed, picks in a page of its own origin, and says why it can\'t in another site\'s', async () => {
  ui = await mountUi({ extensions: [browser] })
  window.superego.webView = undefined
  window.superego.forward = undefined
  // (This DOM loads no frame's page: it says so, to the console.)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const away = await ui.render({ pane: { kind: BROWSER, params: { url: 'https://example.com/' } } })
  await vi.waitFor(() => expect(away.find('iframe')).toBeTruthy())
  const button = away.find('button[aria-label="Select element"]') as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.title).toBe('Select element needs the desktop app: this page is framed from another site')
  await away.unmount()

  const own = await ui.render({ thread: testThread(), pane: { kind: BROWSER, params: { url: `${location.origin}/page` } } })
  await vi.waitFor(() => expect(own.find('iframe')).toBeTruthy())
  // Its page, as a frame of this origin has it (this DOM loads no frame's page).
  const page = new PageWindow({ url: `${location.origin}/page` }) as unknown as Window & typeof globalThis
  page.document.body.innerHTML = '<h1 class="title">Hello</h1>'
  Object.defineProperty(own.find('iframe'), 'contentWindow', { value: page })
  expect((own.find('button[aria-label="Select element"]') as HTMLButtonElement).disabled).toBe(false)
  await own.click('button[aria-label="Select element"]')
  const host = () => page.document.querySelector('superego-picker') as HTMLElement | null
  await vi.waitFor(() => expect(host()).toBeTruthy())
  page.document.elementsFromPoint = () => [host()!, page.document.querySelector('h1')!]
  host()!.dispatchEvent(new page.PointerEvent('pointermove', { bubbles: true }))
  host()!.dispatchEvent(new page.MouseEvent('click', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(own.find('.browser-picked__selector')?.textContent).toBe('h1.title'))
  // No image of it: a frame's page can't be captured.
  expect(own.find('.browser-picked__image')).toBeFalsy()
})
