// web-panes' UI half in a window: web links open beside a thread in Preview, the one kind that takes URLs (a profile's
// own first), and nowhere while the thread goes without web-panes; a page framed in a browser, and in a view of its own
// on the desktop.
import { afterEach, expect, it, vi } from 'vitest'
import { defineUiExtension, fileKind, type WebViewEvent } from '@superego/app/ui'
import { mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import webPanes from '../src/ui.tsx'
import { ARTIFACT, PREVIEW } from '../src/shared.ts'

const profile = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
const View = () => null
let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount() })

it('opens web links in Preview, and nowhere for a thread that goes without web-panes, or a window without it', async () => {
  ui = await mountUi({ extensions: [webPanes] })
  const where = { machine: 'local', thread: testThread() }
  expect(ui.urlKind(where)).toBe(PREVIEW)
  expect(ui.registry.panes.find((p) => p.kind === ARTIFACT)?.file).toBe(true)
  // An artifact is opened by the agent, by kind: a file still opens in the editor.
  expect(fileKind(ui.registry, where, 'page.html')).toBe('editor')
  expect(ui.urlKind({ thread: testThread({ without: ['web-panes'] }) })).toBeUndefined()
  await ui.unmount()
  ui = await mountUi({ extensions: [] })
  expect(ui.urlKind({ thread: testThread() })).toBeUndefined()
})

it("opens web links in a profile's own kind that takes them, for its threads", async () => {
  const browser = defineUiExtension({ name: 'browser', setup(superego) { superego.pane('browser', { title: 'Browser', component: View, urls: true }) } })
  ui = await mountUi({ extensions: [webPanes], profile: { ref: profile, extensions: [browser] } })
  expect(ui.urlKind({ thread: testThread({ profile }) })).toBe('browser')
  expect(ui.urlKind({ thread: testThread({ profile: null }) })).toBe(PREVIEW)
})

it('shows a page through the bridge\'s forward: at the address it gives, said when the port moved, or why it can\'t', async () => {
  ui = await mountUi({ extensions: [webPanes] })
  const asked: string[] = []
  window.superego.forward = async (_machine, url) => {
    asked.push(url)
    if (url.includes(':4000')) throw new Error("Superego on workbox can't forward its localhost here: update it to show this page.")
    return url.replace(':5173', ':5174')
  }
  const frame = (pane: Awaited<ReturnType<TestWindow['render']>>) => pane.find('iframe')?.getAttribute('src')
  const moved = await ui.render({ pane: { kind: PREVIEW, params: { url: 'http://localhost:5173/' } } })
  await vi.waitFor(() => expect(frame(moved)).toBe('http://localhost:5174/'))
  expect(moved.text()).toContain('here at localhost:5174')
  const same = await ui.render({ pane: { kind: PREVIEW, params: { url: 'https://example.com/' } } })
  await vi.waitFor(() => expect(frame(same)).toBe('https://example.com/'))
  expect(same.text()).not.toContain('here at')
  // Focused, the pane keeps the keyboard, and says so; Return passes it into the frame.
  const box = same.find('.web-view') as HTMLElement
  box.focus()
  await vi.waitFor(() => expect(same.text()).toContain('↩ to use the page'))
  expect(document.activeElement).toBe(box)
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(document.activeElement).toBe(same.find('iframe')))
  await vi.waitFor(() => expect(same.text()).not.toContain('↩ to use the page'))
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const old = await ui.render({ pane: { kind: PREVIEW, params: { url: 'http://localhost:4000/' } } })
  await vi.waitFor(() => expect(old.text()).toContain('update it to show this page'))
  expect(logged).toHaveBeenCalledOnce()
  logged.mockRestore()
  expect(asked).toEqual(['http://localhost:5173/', 'https://example.com/', 'http://localhost:4000/'])
})

it('shows a page in a view of its own on the desktop: placed over the pane, its header following it, and told what it did', async () => {
  ui = await mountUi({ extensions: [webPanes] })
  // The DOM here lays nothing out: every box is empty, so a pane is never in view, and never placed but out of sight.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  const views: { url: string; partition: string; ops: unknown[][]; listener?: (event: WebViewEvent) => void; closed: boolean }[] = []
  window.superego.forward = undefined
  window.superego.webView = ({ url, partition }) => {
    const view = { url, partition, ops: [] as unknown[][], listener: undefined as ((event: WebViewEvent) => void) | undefined, closed: false }
    views.push(view)
    const op = (name: string) => (...args: unknown[]) => { view.ops.push([name, ...args]) }
    return {
      place: op('place'), load: op('load'), go: op('go'), reload: op('reload'), focus: op('focus'), reveal: op('reveal'),
      snapshot: async () => null, onEvent: (listener) => { view.listener = listener }, close: () => { view.closed = true },
    }
  }
  const pane = await ui.render({ pane: { kind: PREVIEW, params: { url: 'http://localhost:5179/as/mikker' } } })
  await vi.waitFor(() => expect(views).toHaveLength(1))
  const [view] = views
  expect(view).toMatchObject({ url: 'http://localhost:5179/as/mikker', partition: 'preview' })
  expect(pane.find('iframe')).toBeFalsy()
  const state = { title: 'reforge', loading: false, canGoBack: true, canGoForward: false }
  view!.listener!({ type: 'state', state: { ...state, url: 'http://localhost:5173/' } })
  await vi.waitFor(() => expect(pane.text()).toContain('http://localhost:5173/'))
  const button = (label: string) => pane.find(`button[aria-label="${label}"]`) as HTMLButtonElement
  expect(button('Back').disabled).toBe(false)
  expect(button('Forward').disabled).toBe(true)
  await pane.click('Back')
  expect(view!.ops).toContainEqual(['go', -1])
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
  view!.listener!({ type: 'denied', permission: 'media' })
  await vi.waitFor(() => expect(pane.text()).toContain('The page asked for the camera or microphone: refused here'))
  // A page that doesn't load says why, in the pane.
  view!.listener!({ type: 'state', state: { ...state, url: 'http://localhost:5173/', error: { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:5173/' } } })
  await vi.waitFor(() => expect(pane.text()).toContain("didn't load: ERR_CONNECTION_REFUSED"))
  // The pane no longer drawn (its thread left), its page is hidden, not closed; drawn again, it's the same page, as it was.
  await pane.unmount()
  expect(view!.closed).toBe(false)
  expect(view!.ops.at(-1)).toEqual(['place', null, false])
  const again = await ui.render({ pane: { kind: PREVIEW, params: { url: 'http://localhost:5179/as/mikker' } } })
  await vi.waitFor(() => expect(again.text()).toContain("didn't load: ERR_CONNECTION_REFUSED"))
  expect(views).toHaveLength(1)
  expect(view!.ops.some(([op]) => op === 'load')).toBe(false)
  await ui.unmount()
  ui = undefined
  expect(view!.closed).toBe(true)
})
