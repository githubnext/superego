// web-panes' UI half in a window: web links open beside a thread in Preview, the one kind that takes URLs (a profile's
// own first), and nowhere while the thread goes without web-panes.
import { afterEach, expect, it } from 'vitest'
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
  expect(ui.urlKind({ thread: testThread() })).toBe(PREVIEW)
})
