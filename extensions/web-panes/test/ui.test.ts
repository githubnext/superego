// web-panes' UI half in the registry: web links open beside a thread in Preview, the one kind that takes URLs (a
// profile's own first), and nowhere while the thread goes without web-panes.
import { expect, it } from 'vitest'
// The registry isn't part of the UI API (the window builds it), so it's taken from where it's made.
import { createRegistry, defineUiExtension, fileKind, paneKind, urlKind } from '../../../packages/app/src/renderer/extension.tsx'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import webPanes from '../src/ui.tsx'
import { ARTIFACT, PREVIEW } from '../src/shared.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const profile = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
const thread = (more: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state: 'idle' }, ...more,
})
const View = () => null

it('opens web links in Preview, and nowhere for a thread that goes without web-panes', () => {
  const registry = createRegistry(app, [webPanes], (core) => core.pane('editor', { title: 'Editor', component: View, fallback: true }))
  const where = { machine: 'local', thread: thread() }
  expect(urlKind(registry, where)).toBe(PREVIEW)
  expect(paneKind(registry, ARTIFACT, where)?.file).toBe(true)
  // An artifact is opened by the agent, by kind: a file still opens in the editor.
  expect(fileKind(registry, where, 'page.html')).toBe('editor')
  expect(urlKind(registry, { machine: 'local', thread: thread({ without: ['web-panes'] }) })).toBeUndefined()
  expect(urlKind(createRegistry(app, [], () => {}), where)).toBeUndefined()
})

it("opens web links in a profile's own kind that takes them, for its threads", () => {
  const registry = createRegistry(app, [webPanes], () => {})
  registry.installProfile('local', profile, [defineUiExtension({ name: 'browser', setup(superego) { superego.pane('browser', { title: 'Browser', component: View, urls: true }) } })])
  expect(urlKind(registry, { machine: 'local', thread: thread({ profile }) })).toBe('browser')
  expect(urlKind(registry, { machine: 'local', thread: thread() })).toBe(PREVIEW)
})
