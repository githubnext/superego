// @vitest-environment happy-dom
// A Browser pane's address bar: a pill until it's clicked, then a field with the address selected (no shortcut: ⌘L
// stays the window's navigator); Return points the pane where it says (a web page, an HTML file, a search), Esc leaves it as it was.
// Opened blank (⌘T, the pane menu), the field waits to be typed in. A web page has the web's cookies and may ask for
// permissions; an HTML file's page has its own, and is refused them all.
import { afterEach, expect, it, vi } from 'vitest'
import type { WebViewEvent } from '@superego/app/ui'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import browser from '../src/ui.tsx'
import { BROWSER } from '../src/shared.ts'
import { SEARCH_ENGINE } from '../src/address.ts'

let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount() })

const thread = testThread({ id: 't1' })
/** A machine that answers what a pane asks of it: where to point it, and its file's version. */
function machine() {
  const updates: unknown[] = []
  const opened: unknown[] = []
  const m = fakeMachine({
    threads: [thread],
    methods: {
      'pane.update': (params) => { updates.push(params); return null },
      'pane.open': (params) => { opened.push(params); return { id: 'p9' } },
      'file.stat': () => ({ files: [{ mtimeMs: 1, size: 2 }] }),
    },
  })
  return { m, updates, opened }
}

/** Views opened on the desktop, as the main process would: by address and partition, with what each was told. */
function desktop() {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  const views: { url: string; partition: string; ops: unknown[][]; listener?: (event: WebViewEvent) => void }[] = []
  window.superego.forward = undefined
  window.superego.artifactUrl = (machine, thread, path) => `superego-artifact://${machine}/${thread}/${path}`
  window.superego.webView = ({ url, partition }) => {
    const view = { url, partition, ops: [] as unknown[][], listener: undefined as ((event: WebViewEvent) => void) | undefined }
    views.push(view)
    const op = (name: string) => (...args: unknown[]) => { view.ops.push([name, ...args]) }
    return {
      place: op('place'), load: op('load'), go: op('go'), reload: op('reload'), focus: op('focus'), reveal: op('reveal'), answer: op('answer'),
      snapshot: async () => null, onEvent: (listener) => { view.listener = listener }, close: op('close'),
    }
  }
  return views
}

const field = () => document.querySelector<HTMLInputElement>('input.browser-address')

it('turns into a field with the address selected; Return points the pane there, Esc leaves it be', async () => {
  const { m, updates } = machine()
  ui = await mountUi({ extensions: [browser], machines: [m] })
  const views = desktop()
  const pane = await ui.render({ thread: 't1', pane: { id: 'p1', kind: BROWSER, params: { url: 'https://example.com/a' } } })
  await vi.waitFor(() => expect(views).toHaveLength(1))
  expect(views[0]).toMatchObject({ url: 'https://example.com/a', partition: 'browser' })
  expect(field()).toBeNull()
  await pane.click('Address')
  expect(field()?.value).toBe('https://example.com/a')
  expect(document.activeElement).toBe(field())
  expect([field()!.selectionStart, field()!.selectionEnd]).toEqual([0, 'https://example.com/a'.length])
  // Esc: as it was, the pane keeping the keyboard.
  await ui.key('escape')
  expect(field()).toBeNull()
  expect(document.activeElement).toBe(pane.find('.web-view'))
  expect(pane.find('.browser-address__text')?.textContent).toBe('https://example.com/a')
  // A bare host, then a search, then a file in the working folder.
  for (const [typed, params] of [
    ['localhost:5173', { url: 'http://localhost:5173' }],
    ['how frames work', { url: 'https://duckduckgo.com/?q=how%20frames%20work' }],
    ['out/report.html', { path: 'out/report.html' }],
  ] as const) {
    await pane.click('Address')
    await ui.type('input.browser-address', typed)
    await ui.key('enter')
    expect(updates.at(-1)).toEqual({ thread: 't1', pane: 'p1', params })
    expect(field()).toBeNull()
  }
  // Where the pane points already: loaded again, the page given the keyboard.
  await pane.click('Address')
  await ui.key('enter')
  expect(updates).toHaveLength(3)
  expect(views[0]!.ops).toContainEqual(['load', 'https://example.com/a'])
  expect(views[0]!.ops).toContainEqual(['focus', true])
})

it('searches with the engine set', async () => {
  const { m, updates } = machine()
  ui = await mountUi({ extensions: [browser], machines: [m] })
  desktop()
  await ui.dispatch('app.settings.set', { key: SEARCH_ENGINE, value: 'google' }, { machine: 'app' })
  const pane = await ui.render({ thread: 't1', pane: { id: 'p1', kind: BROWSER, params: { url: 'https://example.com/' } } })
  await pane.click('Address')
  await ui.type('input.browser-address', 'superego')
  await ui.key('enter')
  expect(updates.at(-1)).toMatchObject({ params: { url: 'https://www.google.com/search?q=superego' } })
})

it("leaves ⌘L to the window's navigator, in the pane too", async () => {
  const { m } = machine()
  ui = await mountUi({ extensions: [browser], machines: [m] })
  const views = desktop()
  const pane = await ui.render({ thread: 't1', pane: { id: 'p1', kind: BROWSER, params: { url: 'https://example.com/' } } })
  await vi.waitFor(() => expect(views).toHaveLength(1))
  // The window's shortcuts are heard on the window, last (the app's key routing): ⌘L gets there.
  const heard = vi.fn()
  window.addEventListener('keydown', heard)
  ;(pane.find('.web-view') as HTMLElement).focus()
  await ui.key('mod+l')
  window.removeEventListener('keydown', heard)
  expect(heard).toHaveBeenCalledOnce()
  expect(field()).toBeNull()
})

it('opens blank, its address bar waiting, from ⌘T or the pane menu', async () => {
  const { m, updates, opened } = machine()
  ui = await mountUi({ extensions: [browser], machines: [m], select: { thread: 't1' } })
  const views = desktop()
  expect(await ui.press('mod+t')).toBe('browser.new')
  expect(opened).toEqual([{ thread: 't1', kind: BROWSER }])
  // Offered in the pane menu, by its name.
  expect(ui.placed('pane', { thread: 't1' })).toContain(BROWSER)
  const pane = await ui.render({ thread: 't1', pane: { id: 'p2', kind: BROWSER } })
  expect(views).toHaveLength(0)
  expect(field()?.value).toBe('')
  expect(field()?.placeholder).toBe('Search or type an address')
  expect(document.activeElement).toBe(field())
  expect(field()?.hasAttribute('data-focus')).toBe(true)
  expect((pane.find('button[aria-label="Reload"]') as HTMLButtonElement).disabled).toBe(true)
  // Esc empties it, and it stays.
  await ui.type('input.browser-address', 'exam')
  await ui.key('escape')
  expect(field()?.value).toBe('')
  await ui.type('input.browser-address', 'example.com')
  await ui.key('enter')
  expect(updates).toEqual([{ thread: 't1', pane: 'p2', params: { url: 'https://example.com' } }])
})

it("shows a web page with the web's cookies and permissions, an HTML file with its own and none", async () => {
  const { m } = machine()
  ui = await mountUi({ extensions: [browser], machines: [m] })
  const views = desktop()
  const file = await ui.render({ thread: 't1', pane: { id: 'p3', kind: BROWSER, params: { path: 'out/report.html' } } })
  await vi.waitFor(() => expect(views).toHaveLength(1))
  expect(views[0]).toMatchObject({ url: 'superego-artifact://local/t1/out/report.html', partition: 'artifact' })
  // Its address is its path, its folder quiet; a page of the folder it goes to, by its path too.
  expect(file.find('.browser-address__quiet')?.textContent).toBe('out/')
  expect(file.find('.browser-address__text')?.textContent).toBe('out/report.html')
  const state = { title: '', loading: false, canGoBack: true, canGoForward: false }
  views[0]!.listener!({ type: 'state', state: { ...state, url: 'superego-artifact://local/t1/out/next%20page.html' } })
  await vi.waitFor(() => expect(file.find('.browser-address__text')?.textContent).toBe('out/next page.html'))
  // No opening a file elsewhere: it's the thread's.
  expect(file.find('a[aria-label="Open in browser"]')).toBeNull()
  // Something it asks for is refused, and said.
  views[0]!.listener!({ type: 'denied', permission: 'media' })
  await vi.waitFor(() => expect(file.text()).toContain('The page asked for the camera or microphone: refused here'))
  await file.unmount()
  const web = await ui.render({ thread: 't1', pane: { id: 'p4', kind: BROWSER, params: { url: 'localhost:5173' } } })
  await vi.waitFor(() => expect(views).toHaveLength(2))
  // Given bare, by an agent: a web address all the same.
  expect(views[1]).toMatchObject({ url: 'http://localhost:5173', partition: 'browser' })
  expect(web.find('a[aria-label="Open in browser"]')).toBeTruthy()
})
