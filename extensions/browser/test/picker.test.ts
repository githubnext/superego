// @vitest-environment happy-dom
// The element picker in a page (picker.ts): its layer over the page, outlining the element under the pointer with its
// label; ↑ to its parent and ↓ back; a click picks it (the page hears none), Esc or cancelPick cancels; every trace of
// it gone after. What it tells of the element: a selector that finds it alone, its tag, text, box and styles, its HTML
// cut short. And that, as the note the agent is given, found again in a sent message.
import { afterEach, expect, it, vi } from 'vitest'
import { cancelPick, pick, type Picked } from '../src/picker.ts'
import { elementFiles, elementNote, ELEMENT_TYPE, readElement, whereOf } from '../src/element.ts'

const options = { accent: 'rgb(110, 86, 207)', htmlLimit: 6 * 1024 }
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** The picker's layer and its shadow root, as it's put on the page. */
function layer() {
  const attach = vi.spyOn(Element.prototype, 'attachShadow')
  return {
    host: () => document.querySelector('superego-picker') as HTMLElement | null,
    root: () => attach.mock.results.at(-1)?.value as ShadowRoot,
  }
}
/** The pointer over `el`: what's under it, then the move, as the layer gets it. */
function hover(host: HTMLElement, el: Element) {
  document.elementsFromPoint = () => [host, el, document.body, document.documentElement]
  host.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }))
}
const key = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

it('outlines the element under the pointer, moves to its parent and back, and picks what is clicked without the page hearing it', async () => {
  document.body.innerHTML = `<main><section class="plans"><button class="primary big" type="submit" style="color: red">Start <b>free</b>   trial</button></section></main>`
  const button = document.querySelector('button')!
  const clicked = vi.fn()
  button.addEventListener('click', clicked)
  document.addEventListener('click', clicked)
  const { host, root } = layer()
  const picking = pick(window, options)
  expect(host()).toBeTruthy()
  const box = root().querySelector<HTMLElement>('.box')!
  const label = root().querySelector<HTMLElement>('.label')!
  expect(box.style.display).not.toBe('block')

  hover(host()!, button)
  expect(box.style.display).toBe('block')
  expect(label.textContent).toMatch(/^button\.primary\.big\d+ × \d+$/)
  // ↑ to its parent, ↓ back to it.
  key('ArrowUp')
  expect(label.textContent).toMatch(/^section\.plans/)
  key('ArrowDown')
  expect(label.textContent).toMatch(/^button\.primary/)

  host()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const picked = (await picking)!
  expect(clicked).not.toHaveBeenCalled()
  // Gone from the page, all of it.
  expect(host()).toBeNull()
  button.click()
  expect(clicked).toHaveBeenCalledTimes(2)

  expect(picked).toMatchObject({
    url: location.href, selector: 'button.primary.big', label: '<button.primary>',
    opening: '<button class="primary big" type="submit">', text: 'Start free trial',
  } satisfies Partial<Picked>)
  expect(picked.html).toBe(button.outerHTML)
  expect(picked.htmlSize).toBe(button.outerHTML.length)
  // (Of what this DOM computes: no spacing.)
  expect(picked.styles).toMatchObject({ display: 'inline-block', color: 'red' })
})

it('cancels on Esc, and on cancelPick, leaving nothing behind', async () => {
  document.body.innerHTML = '<p>Hi</p>'
  const { host } = layer()
  const first = pick(window, options)
  hover(host()!, document.querySelector('p')!)
  key('Escape')
  expect(await first).toBeNull()
  expect(host()).toBeNull()
  const second = pick(window, options)
  cancelPick(window)
  expect(await second).toBeNull()
  // A second picking cancels the first.
  const third = pick(window, options)
  const fourth = pick(window, options)
  expect(await third).toBeNull()
  expect(document.querySelectorAll('superego-picker')).toHaveLength(1)
  key('Escape')
  expect(await fourth).toBeNull()
  expect(document.querySelectorAll('superego-picker')).toHaveLength(0)
})

it('finds each element by a selector that finds it alone, as short as that allows', async () => {
  document.body.innerHTML = `
    <div id="app">
      <nav><a class="link" href="/">Home</a><a class="link" href="/docs">Docs</a></nav>
      <ul class="list"><li class="item">One</li><li class="item">Two</li><li class="item">Three</li></ul>
      <ul class="list"><li class="item">Four</li><li class="item">Five</li></ul>
      <form><input name="email"><button data-testid="save">Save</button><button aria-label="Close">×</button></form>
      <span id="lone">Alone</span>
      <section><p class="hover:bg-x w-1/2">Utility</p></section>
      <section><p class="hover:bg-x w-1/2">Utility</p></section>
    </div>`
  const { host } = layer()
  const selectorOf = async (el: Element) => {
    const picking = pick(window, options)
    hover(host()!, el)
    key('Enter')
    return (await picking)!.selector
  }
  const expected: [string, string][] = [
    ['#lone', '#lone'],
    ['input', 'input[name="email"]'],
    ['button[data-testid]', 'button[data-testid="save"]'],
    ['button[aria-label]', 'button[aria-label="Close"]'],
  ]
  for (const [find, selector] of expected) expect(await selectorOf(document.querySelector(find)!)).toBe(selector)
  for (const el of document.querySelectorAll('a, li, p, section, nav, ul, form')) {
    const selector = await selectorOf(el)
    expect(document.querySelectorAll(selector), selector).toHaveLength(1)
    expect(document.querySelector(selector), selector).toBe(el)
    // No utility class's variant in it.
    expect(selector).not.toContain('hover')
  }
  expect(await selectorOf(document.querySelectorAll('li')[3]!)).toBe('ul.list:nth-of-type(2) > li.item:nth-of-type(1)')
})

it('cuts a long outer HTML at a tag, and the note says so', async () => {
  document.body.innerHTML = `<ul>${Array.from({ length: 400 }, (_, i) => `<li class="row">Row ${i}</li>`).join('')}</ul>`
  const { host } = layer()
  const picking = pick(window, { ...options, htmlLimit: 1024 })
  hover(host()!, document.querySelector('ul')!)
  key('Enter')
  const picked = (await picking)!
  expect(picked.htmlSize).toBe(document.querySelector('ul')!.outerHTML.length)
  expect(picked.html.length).toBeLessThanOrEqual(1024)
  expect(picked.html.length).toBeGreaterThan(900)
  expect(picked.html.endsWith('>')).toBe(true)
  const note = elementNote(picked, 'http://localhost:4321/list', false)
  expect(note).toMatch(/Its HTML, cut to the first 1\.0 KB of \d+ KB:/)
  expect(note).not.toContain('Screenshot')
})

it('tells the agent where it is, what it is and how it looks, and is found again in the message it went with', () => {
  const picked: Picked = {
    url: 'http://localhost:5174/pricing', title: 'Pricing', selector: 'section.plans > button.primary', label: '<button.primary>',
    opening: '<button class="primary" type="submit">', text: 'Start trial', html: '<button class="primary" type="submit">Start `trial`</button>', htmlSize: 60,
    box: { x: 312, y: 488, width: 160, height: 40 }, viewport: { width: 1280, height: 800 },
    styles: { display: 'inline-flex', 'font-size': '15px', color: 'rgb(255, 255, 255)', margin: '0px', padding: '8px 16px' },
  }
  const [note, image] = elementFiles(picked, 'http://localhost:4321/pricing', 'iVBORw0KGgo=')
  expect(note).toMatchObject({ name: 'element.md', mimeType: ELEMENT_TYPE })
  expect(image).toEqual({ name: 'element.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' })
  const text = new TextDecoder().decode(Uint8Array.from(atob(note!.data), (c) => c.charCodeAt(0)))
  expect(text).toBe([
    'The element I picked in the Browser pane: <button.primary> on http://localhost:4321/pricing ("Pricing").',
    '',
    '- Selector: `section.plans > button.primary`',
    '- Tag: `<button class="primary" type="submit">`',
    '- Text: "Start trial"',
    '- Box: 160 × 40 at (312, 488), in a 1280 × 800 viewport',
    '- Styles: `display: inline-flex; font-size: 15px; color: rgb(255, 255, 255); margin: 0px; padding: 8px 16px`',
    '- Screenshot: the image attached after this',
    '',
    'Its HTML:',
    '',
    '```html',
    picked.html,
    '```',
  ].join('\n'))
  // As the daemon names it to the agent (its attachments.ts), found again; any other block isn't one.
  const block = `<attachment name="element.md" type="${ELEMENT_TYPE}" path="/data/attachments/t1/element.md">\n${text}\n</attachment>`
  expect(readElement(block)).toEqual({ label: '<button.primary>', where: 'localhost:4321', selector: 'section.plans > button.primary' })
  expect(readElement(`<attachment name="notes.md" type="text/markdown" path="/x/notes.md">\n${text}\n</attachment>`)).toBeUndefined()
  expect(readElement(text)).toBeUndefined()
  expect(whereOf('out/report.html')).toBe('report.html')
})
