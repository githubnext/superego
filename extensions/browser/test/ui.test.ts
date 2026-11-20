// browser's UI half in a window: web links open beside a thread in Browser, the one kind that takes URLs (a profile's
// own first), and nowhere while the thread goes without browser; a page framed in a browser, and in a view of its own
// on the desktop, a web page's with the cookies and permissions of the web, an HTML file's with neither.
import { afterEach, expect, it, vi } from 'vitest'
import { defineUiExtension, fileKind, type SitePermission, type WebViewEvent } from '@superego/app/ui'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import { act } from 'react'
import browser, { FINISH, SHOW_AFTER } from '../src/ui.tsx'
import { BROWSER } from '../src/shared.ts'

const profile = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
const View = () => null
let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount() })

it('opens web links in Browser, and nowhere for a thread that goes without browser, or a window without it', async () => {
  ui = await mountUi({ extensions: [browser] })
  const where = { machine: 'local', thread: testThread() }
  expect(ui.urlKind(where)).toBe(BROWSER)
  // Its tab is a file's name when it shows one.
  const kind = ui.registry.panes.find((p) => p.kind === BROWSER)!
  const file = kind.file as (pane: { id: string; kind: string; params?: unknown }) => boolean
  expect(file({ id: 'a', kind: BROWSER, params: { path: 'out/report.html' } })).toBe(true)
  expect(file({ id: 'a', kind: BROWSER, params: { url: 'https://example.com/' } })).toBe(false)
  expect((kind.title as (pane: unknown) => string)({ id: 'a', kind: BROWSER, params: { path: 'out/report.html' } })).toBe('report.html')
  expect((kind.title as (pane: unknown) => string)({ id: 'a', kind: BROWSER })).toBe('Browser')
  // An HTML file is opened in it by the agent, or from its address bar: a file named in a thread still opens in the editor.
  expect(fileKind(ui.registry, where, 'page.html')).toBe('editor')
  expect(ui.urlKind({ thread: testThread({ without: ['browser'] }) })).toBeUndefined()
  await ui.unmount()
  ui = await mountUi({ extensions: [] })
  expect(ui.urlKind({ thread: testThread() })).toBeUndefined()
})

it("opens web links in a profile's own kind that takes them, for its threads", async () => {
  const reader = defineUiExtension({ name: 'reader', setup(superego) { superego.pane('reader', { title: 'Reader', component: View, urls: true }) } })
  ui = await mountUi({ extensions: [browser], profile: { ref: profile, extensions: [reader] } })
  expect(ui.urlKind({ thread: testThread({ profile }) })).toBe('reader')
  expect(ui.urlKind({ thread: testThread({ profile: null }) })).toBe(BROWSER)
})

it('shows a page through the bridge\'s forward: at the address it gives, said when the port moved, or why it can\'t', async () => {
  ui = await mountUi({ extensions: [browser] })
  const asked: string[] = []
  window.superego.forward = async (_machine, url) => {
    asked.push(url)
    if (url.includes(':4000')) throw new Error("Superego on workbox can't forward its localhost here: update it to show this page.")
    return url.replace(':5173', ':5174')
  }
  const frame = (pane: Awaited<ReturnType<TestWindow['render']>>) => pane.find('iframe')?.getAttribute('src')
  const moved = await ui.render({ pane: { kind: BROWSER, params: { url: 'http://localhost:5173/' } } })
  await vi.waitFor(() => expect(frame(moved)).toBe('http://localhost:5174/'))
  expect(moved.text()).toContain('here at localhost:5174')
  const same = await ui.render({ pane: { kind: BROWSER, params: { url: 'https://example.com/' } } })
  await vi.waitFor(() => expect(frame(same)).toBe('https://example.com/'))
  expect(same.text()).not.toContain('here at')
  // The address says the scheme, and a local host, quietly; another host and the path as text.
  expect(moved.find('.browser-address__quiet')?.textContent).toBe('http://localhost:5173')
  expect(same.find('.browser-address__quiet')?.textContent).toBe('https://')
  expect(same.find('.browser-address__text')?.textContent).toBe('https://example.com/')
  // Focused, the pane keeps the keyboard, and says so; Return passes it into the frame.
  const box = same.find('.web-view') as HTMLElement
  box.focus()
  await vi.waitFor(() => expect(same.text()).toContain('↩ to use the page'))
  expect(document.activeElement).toBe(box)
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(document.activeElement).toBe(same.find('iframe')))
  await vi.waitFor(() => expect(same.text()).not.toContain('↩ to use the page'))
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const old = await ui.render({ pane: { kind: BROWSER, params: { url: 'http://localhost:4000/' } } })
  await vi.waitFor(() => expect(old.text()).toContain('update it to show this page'))
  expect(logged).toHaveBeenCalledOnce()
  logged.mockRestore()
  expect(asked).toEqual(['http://localhost:5173/', 'https://example.com/', 'http://localhost:4000/'])
})

it('shows a page in a view of its own on the desktop: placed over the pane, its header following it, and told what it did', async () => {
  ui = await mountUi({ extensions: [browser] })
  // The DOM here lays nothing out: every box is empty, so a pane is never in view, and never placed but out of sight.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  const views: { url: string; partition: string; ops: unknown[][]; listener?: (event: WebViewEvent) => void; closed: boolean }[] = []
  window.superego.forward = undefined
  window.superego.webView = ({ url, partition }) => {
    const view = { url, partition, ops: [] as unknown[][], listener: undefined as ((event: WebViewEvent) => void) | undefined, closed: false }
    views.push(view)
    const op = (name: string) => (...args: unknown[]) => { view.ops.push([name, ...args]) }
    return {
      place: op('place'), load: op('load'), go: op('go'), reload: op('reload'), stop: op('stop'), focus: op('focus'), reveal: op('reveal'), answer: op('answer'),
      snapshot: async () => null, onEvent: (listener) => { view.listener = listener }, close: () => { view.closed = true },
    }
  }
  const pane = await ui.render({ pane: { kind: BROWSER, params: { url: 'http://localhost:5179/as/mikker' } } })
  await vi.waitFor(() => expect(views).toHaveLength(1))
  const [view] = views
  expect(view).toMatchObject({ url: 'http://localhost:5179/as/mikker', partition: 'browser' })
  expect(pane.find('iframe')).toBeFalsy()
  const state = { title: 'reforge', loading: false, canGoBack: true, canGoForward: false }
  view!.listener!({ type: 'state', state: { ...state, url: 'http://localhost:5173/' } })
  await vi.waitFor(() => expect(pane.text()).toContain('http://localhost:5173/'))
  const button = (label: string) => pane.find(`button[aria-label="${label}"]`) as HTMLButtonElement
  expect(button('Back').disabled).toBe(false)
  expect(button('Forward').disabled).toBe(true)
  await pane.click('Back')
  expect(view!.ops).toContainEqual(['go', -1])
  // Gone back, it's loading: Reload is Stop until it's there.
  expect(button('Stop')).toBeTruthy()
  view!.listener!({ type: 'state', state: { ...state, url: 'http://localhost:5173/', loading: true } })
  view!.listener!({ type: 'state', state: { ...state, url: 'http://localhost:5173/' } })
  await vi.waitFor(() => expect(button('Reload')).toBeTruthy())
  await pane.click('Reload')
  expect(view!.ops).toContainEqual(['reload'])
  // Focused, the pane keeps the keyboard, and says so; Return gives it to the page.
  const box = pane.find('.web-view') as HTMLElement
  box.focus()
  await vi.waitFor(() => expect(pane.text()).toContain('↩ to use the page'))
  expect(view!.ops.some(([op]) => op === 'focus')).toBe(false)
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(view!.ops).toContainEqual(['focus', true]))
  await vi.waitFor(() => expect(pane.text()).not.toContain('↩ to use the page'))
  // A file it saved, shown where it is; something it asked for, refused.
  view!.listener!({ type: 'download', name: 'report.pdf', path: '/Users/me/Downloads/report.pdf', state: 'completed' })
  await vi.waitFor(() => expect(pane.text()).toContain('Saved report.pdf to Downloads'))
  await pane.click('Show')
  expect(view!.ops).toContainEqual(['reveal', '/Users/me/Downloads/report.pdf'])
  view!.listener!({ type: 'denied', permission: 'geolocation' })
  await vi.waitFor(() => expect(pane.text()).toContain('The page asked for your location: refused here'))
  // A page that doesn't load says why, in the pane.
  view!.listener!({ type: 'state', state: { ...state, url: 'http://localhost:5173/', error: { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:5173/' } } })
  await vi.waitFor(() => expect(pane.text()).toContain("didn't load: ERR_CONNECTION_REFUSED"))
  // The pane no longer drawn (its thread left), its page is hidden, not closed; drawn again, it's the same page, as it was.
  await pane.unmount()
  expect(view!.closed).toBe(false)
  expect(view!.ops.at(-1)).toEqual(['place', null, false])
  const again = await ui.render({ pane: { kind: BROWSER, params: { url: 'http://localhost:5179/as/mikker' } } })
  await vi.waitFor(() => expect(again.text()).toContain("didn't load: ERR_CONNECTION_REFUSED"))
  expect(views).toHaveLength(1)
  expect(view!.ops.some(([op]) => op === 'load')).toBe(false)
  await ui.unmount()
  ui = undefined
  expect(view!.closed).toBe(true)
})

it("asks for what the page asks for, under its toolbar, until the user answers; and says what macOS keeps from it", async () => {
  ui = await mountUi({ extensions: [browser] })
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  const ops: unknown[][] = []
  let listener: ((event: WebViewEvent) => void) | undefined
  window.superego.forward = undefined
  window.superego.webView = () => {
    const op = (name: string) => (...args: unknown[]) => { ops.push([name, ...args]) }
    return {
      place: op('place'), load: op('load'), go: op('go'), reload: op('reload'), stop: op('stop'), focus: op('focus'), reveal: op('reveal'), answer: op('answer'),
      snapshot: async () => null, onEvent: (next) => { listener = next }, close: () => {},
    }
  }
  const pane = await ui.render({ pane: { kind: BROWSER, params: { url: 'https://okta.example.com/signin' } } })
  await vi.waitFor(() => expect(listener).toBeDefined())
  const state = { url: 'https://okta.example.com/signin', title: 'Sign in', loading: false, canGoBack: false, canGoForward: false }
  const ask = (kinds: SitePermission[]) => listener!({ type: 'state', state: { ...state, ask: { origin: 'https://okta.example.com', kinds } } })
  ask(['loopback-network'])
  const asked = () => pane.find('.browser-ask')?.textContent ?? ''
  await vi.waitFor(() => expect(asked()).toMatch(/^okta\.example\.com wants to reach apps on this (Mac|computer)/))
  await pane.click('Allow')
  expect(ops).toContainEqual(['answer', true])
  // Answered, the page says so: the ask goes.
  listener!({ type: 'state', state })
  await vi.waitFor(() => expect(pane.find('.browser-ask')).toBeFalsy())
  ask(['camera', 'microphone'])
  await vi.waitFor(() => expect(asked()).toContain('okta.example.com wants to use the camera and microphone'))
  await pane.click("Don't allow")
  expect(ops).toContainEqual(['answer', false])
  ask(['notifications'])
  await vi.waitFor(() => expect(asked()).toContain('wants to show notifications'))
  listener!({ type: 'blocked', permission: 'camera' })
  await vi.waitFor(() => expect(pane.text()).toContain("macOS doesn't let Superego test use the camera: allow it in System Settings"))
})

it('frames a page in a browser: a web page as the web, saying sites may refuse; an HTML file without its origin, saying nothing', async () => {
  const m = fakeMachine({ threads: [testThread({ id: 't1' })], methods: { 'file.stat': () => ({ files: [{ mtimeMs: 1, size: 2 }] }) } })
  ui = await mountUi({ extensions: [browser], machines: [m] })
  window.superego.webView = undefined
  window.superego.forward = undefined
  window.superego.artifactUrl = (_machine, thread, path) => `/artifact/${thread}/${path}`
  const web = await ui.render({ thread: 't1', pane: { id: 'p5', kind: BROWSER, params: { url: 'https://example.com/' } } })
  await vi.waitFor(() => expect(web.find('iframe')?.getAttribute('src')).toBe('https://example.com/'))
  expect(web.find('iframe')?.getAttribute('sandbox')).toContain('allow-same-origin')
  expect(web.text()).toContain('many sites refuse to show')
  // The same address bar.
  await web.click('Address')
  expect((web.find('input.browser-address') as HTMLInputElement | null)?.value).toBe('https://example.com/')
  await ui.key('escape')
  await web.unmount()
  const file = await ui.render({ thread: 't1', pane: { id: 'p6', kind: BROWSER, params: { path: 'page.html' } } })
  await vi.waitFor(() => expect(file.find('iframe')?.getAttribute('src')).toBe('/artifact/t1/page.html'))
  expect(file.find('iframe')?.getAttribute('sandbox')).not.toContain('allow-same-origin')
  expect(file.text()).not.toContain('many sites refuse to show')
  expect(file.find('.browser-address__text')?.textContent).toBe('page.html')
})

it('shows a page loading: a line under the toolbar, from a moment in, at its progress; full, then gone, once it loads', async () => {
  ui = await mountUi({ extensions: [browser] })
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  const ops: unknown[][] = []
  let listener: ((event: WebViewEvent) => void) | undefined
  window.superego.forward = undefined
  window.superego.webView = () => {
    const op = (name: string) => (...args: unknown[]) => { ops.push([name, ...args]) }
    return {
      place: op('place'), load: op('load'), go: op('go'), reload: op('reload'), stop: op('stop'), focus: op('focus'), reveal: op('reveal'), answer: op('answer'),
      snapshot: async () => null, onEvent: (next) => { listener = next }, close: () => {},
    }
  }
  const pane = await ui.render({ pane: { kind: BROWSER, params: { url: 'https://example.com/' } } })
  await vi.waitFor(() => expect(listener).toBeDefined())
  const state = { url: 'https://example.com/', title: '', canGoBack: false, canGoForward: false }
  const tell = (loading: boolean, more: object = {}) => act(() => listener!({ type: 'state', state: { ...state, loading, ...more } }))
  const bar = () => pane.find('.browser-load')
  const now = () => (pane.find('.browser-load__now') as HTMLElement | null)?.style.transform
  const spinning = () => Boolean(pane.find('.browser-address .browser-spinner'))
  const button = (label: string) => pane.find(`button[aria-label="${label}"]`)
  vi.useFakeTimers()
  try {
    // A load done within SHOW_AFTER shows nothing at all; Reload is Stop meanwhile.
    tell(true, { progress: 0.1 })
    expect(button('Stop')).toBeTruthy()
    act(() => vi.advanceTimersByTime(SHOW_AFTER - 20))
    tell(false)
    act(() => vi.advanceTimersByTime(FINISH * 2))
    expect(bar()).toBeFalsy()
    expect(spinning()).toBe(false)
    expect(button('Reload')).toBeTruthy()

    // A slower one: shown a moment in, the spinner in place of the globe, its progress as it comes.
    tell(true, { progress: 0.1 })
    expect(bar()).toBeFalsy()
    act(() => vi.advanceTimersByTime(SHOW_AFTER))
    expect(bar()).toBeTruthy()
    expect(spinning()).toBe(true)
    expect(pane.find('.browser-address .browser-address__icon')).toBeFalsy()
    expect(pane.find('.browser-frame')?.getAttribute('aria-busy')).toBe('true')
    expect(now()).toBe('scaleX(0.1)')
    tell(true, { progress: 0.7 })
    expect(now()).toBe('scaleX(0.7)')
    // Loaded: full, then gone.
    tell(false)
    expect(bar()?.classList.contains('is-done')).toBe(true)
    expect(now()).toBe('scaleX(1)')
    expect(spinning()).toBe(false)
    act(() => vi.advanceTimersByTime(FINISH))
    expect(bar()).toBeFalsy()
    expect(pane.find('.browser-address .browser-address__icon')).toBeTruthy()

    // Stopped: Stop, or Esc in the address bar.
    tell(true)
    act(() => vi.advanceTimersByTime(SHOW_AFTER))
    act(() => (button('Stop') as HTMLButtonElement).click())
    expect(ops).toContainEqual(['stop'])
    ops.length = 0
    act(() => (pane.find('button.browser-address') as HTMLButtonElement).click())
    const field = pane.find('input.browser-address') as HTMLInputElement
    act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(ops).toContainEqual(['stop'])
    // A load that fails: the line goes, and the pane says why.
    tell(false, { error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: 'https://example.com/' } })
    act(() => vi.advanceTimersByTime(FINISH))
    expect(bar()).toBeFalsy()
    expect(pane.text()).toContain("didn't load: ERR_NAME_NOT_RESOLVED")
  } finally {
    vi.useRealTimers()
  }
})

it('starts the line at once when sent somewhere from the pane, before the page says it loads', async () => {
  ui = await mountUi({ extensions: [browser] })
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  let listener: ((event: WebViewEvent) => void) | undefined
  window.superego.forward = undefined
  window.superego.webView = () => {
    const op = () => () => {}
    return {
      place: op(), load: op(), go: op(), reload: op(), stop: op(), focus: op(), reveal: op(), answer: op(),
      snapshot: async () => null, onEvent: (next) => { listener = next }, close: () => {},
    }
  }
  const pane = await ui.render({ pane: { kind: BROWSER, params: { url: 'https://example.com/' } } })
  await vi.waitFor(() => expect(listener).toBeDefined())
  act(() => listener!({ type: 'state', state: { url: 'https://example.com/', title: '', loading: false, canGoBack: false, canGoForward: false } }))
  vi.useFakeTimers()
  try {
    act(() => (pane.find('button[aria-label="Reload"]') as HTMLButtonElement).click())
    act(() => vi.advanceTimersByTime(SHOW_AFTER))
    expect(pane.find('.browser-load')).toBeTruthy()
    // The page never says it's loading: the pane stops saying so for it.
    act(() => vi.advanceTimersByTime(3000))
    act(() => vi.advanceTimersByTime(FINISH))
    expect(pane.find('.browser-load')).toBeFalsy()
    expect(pane.find('button[aria-label="Reload"]')).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})
