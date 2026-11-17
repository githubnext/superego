// web-panes' UI half in a window: web links open beside a thread in Preview, the one kind that takes URLs (a profile's
// own first), and nowhere while the thread goes without web-panes.
import { afterEach, expect, it, vi } from 'vitest'
import { defineUiExtension, fileKind } from '@superego/app/ui'
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
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const old = await ui.render({ pane: { kind: PREVIEW, params: { url: 'http://localhost:4000/' } } })
  await vi.waitFor(() => expect(old.text()).toContain('update it to show this page'))
  expect(logged).toHaveBeenCalledOnce()
  logged.mockRestore()
  expect(asked).toEqual(['http://localhost:5173/', 'https://example.com/', 'http://localhost:4000/'])
})
