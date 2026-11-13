// The UI registry: what an extension registers is its own, a profile's is scoped to that profile on its machine, and
// installing a profile again replaces everything it registered before.
import { describe, expect, it } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { defineWindowAction } from '../src/renderer/actions.tsx'
import { createRegistry, defineUiExtension, entryView, paneKind, fileKind, seenIn, settingsView, shownPanes, toolView, urlKind, type UiExtension } from '../src/renderer/extension.tsx'

const app = defineApp({ name: 'superego', id: 'superego' })
const profile = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
const thread = (withProfile: boolean): ThreadInfo => ({
  id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state: 'idle' },
  ...(withProfile ? { profile } : {}),
})
const Order = () => null
const Other = () => null
const orders = (component = Order): UiExtension => defineUiExtension({
  name: 'orders',
  setup(superego) {
    superego.tool('find_order', component)
    superego.entry('orders.note', component)
    superego.settings('orders', component)
    superego.pane('order', { title: 'Order', component })
  },
})

describe('the UI registry', () => {
  it("scopes a profile's UI to that profile's threads on its machine", () => {
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('box', profile, [orders()])
    const there = { machine: 'box', thread: thread(true) }
    expect(toolView(registry, 'find_order', there)).toBe(Order)
    expect(entryView(registry, 'orders.note', there)).toBe(Order)
    expect(paneKind(registry, 'order', there)?.component).toBe(Order)
    expect(settingsView(registry, 'orders', 'box')).toBe(Order)
    // The same profile folder on another machine, and a thread without the profile, see none of it.
    for (const where of [{ machine: 'local', thread: thread(true) }, { machine: 'box', thread: thread(false) }]) {
      expect(toolView(registry, 'find_order', where)).toBeUndefined()
      expect(paneKind(registry, 'order', where)).toBeUndefined()
    }
    expect(settingsView(registry, 'orders', 'local')).toBeUndefined()
  })

  it('replaces everything a profile registered when it is installed again', () => {
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('box', profile, [orders(Order)])
    registry.installProfile('box', profile, [orders(Other)])
    const there = { machine: 'box', thread: thread(true) }
    expect(toolView(registry, 'find_order', there)).toBe(Other)
    expect(registry.tools).toHaveLength(1)
    registry.installProfile('box', profile, [])
    expect([registry.tools, registry.entries, registry.settings, registry.panes].map((list) => list.length)).toEqual([0, 0, 0, 0])
  })

  it('refuses a second extension of a name, and keeps the first of two renderers for one tool', () => {
    expect(() => createRegistry(app, [orders(), orders()], () => {})).toThrow(/already set up/)
    const twice = defineUiExtension({ name: 'more', setup(superego) { superego.tool('find_order', Other) } })
    const registry = createRegistry(app, [orders(), twice], () => {})
    expect(toolView(registry, 'find_order', { machine: 'local', thread: thread(false) })).toBe(Order)
  })
})

describe('optional and required extensions', () => {
  const Card = () => null
  const Sidebar = () => null
  const optional = defineUiExtension({
    name: 'ask-user',
    setup(superego) {
      superego.slot('composer.above', Card)
      superego.tool('ask_user', Card)
    },
  })
  const required = defineUiExtension({ name: 'threads', required: true, setup(superego) { superego.slot('thread.aside', Sidebar) } })

  it("draws nothing of an optional extension for a thread that goes without it, and all of a required one's", () => {
    const registry = createRegistry(app, [optional, required], () => {})
    const without = { machine: 'local', thread: { ...thread(false), without: ['ask-user', 'threads'] } }
    const with_ = { machine: 'local', thread: thread(false) }
    expect(toolView(registry, 'ask_user', with_)).toBe(Card)
    expect(toolView(registry, 'ask_user', without)).toBeUndefined()
    expect(seenIn(registry.slots['composer.above'], without)).toHaveLength(0)
    expect(seenIn(registry.slots['thread.aside'], without).map((e) => e.component)).toEqual([Sidebar])
  })

  it("hides the open panes of an optional extension a thread goes without, keeping the core's and unknown kinds", () => {
    const Page = () => null
    const web = defineUiExtension({ name: 'web-panes', setup(superego) { superego.pane('preview', { title: 'Preview', component: Page, urls: true }) } })
    const registry = createRegistry(app, [web], (core) => core.pane('editor', { title: 'Editor', component: Page }))
    const panes = [{ id: 'a', kind: 'preview' }, { id: 'b', kind: 'editor' }, { id: 'c', kind: 'order' }]
    const with_ = { machine: 'local', thread: { ...thread(false), panes } }
    const without = { machine: 'local', thread: { ...thread(false), panes, without: ['web-panes'] } }
    expect(shownPanes(registry, with_).map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(shownPanes(registry, without).map((p) => p.id)).toEqual(['b', 'c'])
    // Web links open in the kind that shows web pages, while there is one.
    expect(urlKind(registry, with_)).toBe('preview')
    expect(urlKind(registry, without)).toBeUndefined()
  })

  it('opens a file in the kind that takes it, else in the one that takes any file, else nowhere', () => {
    const View = () => null
    const csv = defineUiExtension({ name: 'csv', setup(superego) { superego.pane('table', { title: 'Table', component: View, opens: (path) => path.endsWith('.csv') }) } })
    const registry = createRegistry(app, [csv], (core) => core.pane('editor', { title: 'Editor', component: View, fallback: true }))
    const where = { machine: 'local', thread: thread(false) }
    expect(fileKind(registry, where, 'a.csv')).toBe('table')
    expect(fileKind(registry, where, 'a.md')).toBe('editor')
    expect(fileKind(createRegistry(app, [csv], () => {}), where, 'a.md')).toBeUndefined()
  })
})

describe('actions of optional extensions', () => {
  it("aren't offered while a thread that goes without the extension is shown, and keep their own when", () => {
    let open = true
    const files = defineUiExtension({
      name: 'files',
      setup(superego) {
        superego.action(defineWindowAction({ id: 'files.open', title: 'Open', run: () => null }))
        superego.action(defineWindowAction({ id: 'files.close', title: 'Close', when: () => open, run: () => null }))
      },
    })
    const registry = createRegistry(app, [files], () => {})
    const shown = (t: ThreadInfo) => registry.router.setContext({ selection: { machine: 'local', thread: t.id }, threadOf: () => t } as never)
    shown(thread(false))
    expect([registry.router.offered('files.open'), registry.router.offered('files.close')]).toEqual([true, true])
    open = false
    expect(registry.router.offered('files.close')).toBe(false)
    open = true
    shown({ ...thread(false), without: ['files'] })
    expect([registry.router.offered('files.open'), registry.router.offered('files.close')]).toEqual([false, false])
  })
})

describe('names', () => {
  it("takes a profile's settings component over the app's, as other lookups do", () => {
    const App = () => null
    const registry = createRegistry(app, [], (core) => core.settings('orders', App))
    registry.installProfile('box', profile, [orders(Other)])
    expect(settingsView(registry, 'orders', 'box')).toBe(Other)
    expect(settingsView(registry, 'orders', 'local')).toBe(App)
  })

  it("refuses entry kinds and settings sections outside the extension's name", () => {
    expect(() => createRegistry(app, [defineUiExtension({ name: 'a', setup(superego) { superego.entry('b.note', Order) } })], () => {})).toThrow(/must name its entry kinds/)
    expect(() => createRegistry(app, [defineUiExtension({ name: 'a', setup(superego) { superego.settings('b', Order) } })], () => {})).toThrow(/must name its settings sections/)
  })
})
