// web-panes' UI half in a window: web links open beside a thread in Preview, the one kind that takes URLs (a profile's
// own first), and nowhere while the thread goes without web-panes.
import { afterEach, expect, it } from 'vitest'
import { paneKind } from '@superego/app/internals'
import { defineUiExtension, fileKind, urlKind } from '@superego/app/ui'
import { mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import webPanes from '../src/ui.tsx'
import { ARTIFACT, PREVIEW } from '../src/shared.ts'

const profile = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
const View = () => null
let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount() })

it('opens web links in Preview, and nowhere for a thread that goes without web-panes', async () => {
  ui = await mountUi({ extensions: [webPanes] })
  const where = { machine: 'local', thread: testThread() }
  expect(urlKind(ui.registry, where)).toBe(PREVIEW)
  expect(paneKind(ui.registry, ARTIFACT, where)?.file).toBe(true)
  // An artifact is opened by the agent, by kind: a file still opens in the editor.
  expect(fileKind(ui.registry, where, 'page.html')).toBe('editor')
  expect(urlKind(ui.registry, { machine: 'local', thread: testThread({ without: ['web-panes'] }) })).toBeUndefined()
})

it("opens web links in a profile's own kind that takes them, for its threads", async () => {
  const browser = defineUiExtension({ name: 'browser', setup(superego) { superego.pane('browser', { title: 'Browser', component: View, urls: true }) } })
  ui = await mountUi({ extensions: [webPanes], profile: { ref: profile, extensions: [browser] } })
  expect(urlKind(ui.registry, { machine: 'local', thread: testThread({ profile }) })).toBe('browser')
  expect(urlKind(ui.registry, { machine: 'local', thread: testThread() })).toBe(PREVIEW)
})
