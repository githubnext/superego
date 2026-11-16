// The UI registry: what an extension registers is its own, a profile's is scoped to that profile on its machine, and
// installing a profile again replaces everything it registered before.
import { describe, expect, it, vi } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { defineWindowAction } from '../src/renderer/actions.tsx'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { Contained } from '../src/renderer/contained.tsx'
import { createRegistry, defineUiExtension, entryView, paneKind, fileKind, seenIn, settingsView, shownPanes, toolView, urlKind, type UiExtension } from '../src/renderer/extension.tsx'

const app = defineApp({ name: 'superego', id: 'superego' })
const profile = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
const thread = (withProfile: boolean): ThreadInfo => ({
  id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state: 'idle' },
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

  it("refuses an extension that needs an extension API this window isn't, before it runs, and tells machines each one's version", () => {
    let ran = false
    const future = defineUiExtension({ name: 'future', version: '3.0.0', api: '^3', setup() { ran = true } })
    expect(() => createRegistry(app, [future], () => {})).toThrow('Extension future needs extension API ^3, and this Superego has 2.0.0: update Superego')
    // A profile's is left out, and the rest of the profile set up.
    const registry = createRegistry(app, [defineUiExtension({ name: 'mine', version: '1.2.0', api: '^2', capabilities: ['x'], setup() {} })], () => {})
    const errors = console.error
    console.error = () => {}
    try { registry.installProfile('box', profile, [future, orders()]) } finally { console.error = errors }
    expect(ran).toBe(false)
    expect(toolView(registry, 'find_order', { machine: 'box', thread: thread(true) })).toBe(Order)
    expect(registry.extensions).toEqual([{ name: 'mine', version: '1.2.0', api: '^2', capabilities: ['x'] }])
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
  const required = defineUiExtension({ name: 'threads', required: true, setup(superego) { superego.view('threads.details', { title: 'Details', context: 'thread', fits: ['beside'], default: 'beside', component: Sidebar }) } })

  it("draws nothing of an optional extension for a thread that goes without it, and all of a required one's", () => {
    const registry = createRegistry(app, [optional, required], () => {})
    const without = { machine: 'local', thread: { ...thread(false), without: ['ask-user', 'threads'] } }
    const with_ = { machine: 'local', thread: thread(false) }
    expect(toolView(registry, 'ask_user', with_)).toBe(Card)
    expect(toolView(registry, 'ask_user', without)).toBeUndefined()
    expect(seenIn(registry.slots['composer.above'], without)).toHaveLength(0)
    expect(seenIn(registry.views, without).map((e) => e.id)).toEqual(['threads.details'])
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

describe("a profile's window actions", () => {
  it('are offered only while one of its threads is shown, and run as the shown thread\'s profile on its machine', async () => {
    const ran: string[] = []
    const builds = (said: string) => defineUiExtension({
      name: 'builds',
      setup(superego) { superego.action(defineWindowAction({ id: 'builds.open', title: 'Show the build queue', keys: 'mod+shift+b', run: () => { ran.push(said) } })) },
    })
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('box', profile, [builds('box')])
    registry.installProfile('laptop', profile, [builds('laptop')])
    const shown = (machine: string, t: ThreadInfo) => registry.router.setContext({ selection: { machine, thread: t.id }, threadOf: () => t } as never)
    expect(registry.router.all().find((a) => a.id === 'builds.open')).toMatchObject({ keys: 'mod+shift+b' })
    shown('box', thread(false))
    expect(registry.router.offered('builds.open')).toBe(false)
    shown('laptop', thread(true))
    expect(registry.router.offered('builds.open')).toBe(true)
    await registry.router.dispatch('builds.open')
    shown('box', thread(true))
    await registry.router.dispatch('builds.open')
    expect(ran).toEqual(['laptop', 'box'])
    // Gone with the profile's UI on each machine; the action with the last.
    registry.installProfile('box', profile, [])
    expect(registry.router.offered('builds.open')).toBe(false)
    registry.installProfile('laptop', profile, [])
    expect(registry.router.all().some((a) => a.id === 'builds.open')).toBe(false)
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

describe('lifetime', () => {
  it("runs a UI setup's cleanup on revoke and on remount, aborts its signal, and refuses what it registers after", () => {
    const heard: string[] = []
    let generation = 0
    const apis: { signal: AbortSignal; tool(name: string, view: () => null): void }[] = []
    const timer = defineUiExtension({
      name: 'timer',
      setup(superego) {
        const mine = ++generation
        apis.push(superego)
        superego.tool('tick', Order)
        return () => { heard.push(`cleanup ${mine}`) }
      },
    })
    const broken = defineUiExtension({ name: 'broken', setup() { return () => { throw new Error('a broken cleanup') } } })
    const registry = createRegistry(app, [], () => {})
    const there = { machine: 'box', thread: thread(true) }
    registry.installProfile('box', profile, [broken, timer])
    expect(toolView(registry, 'tick', there)).toBe(Order)
    // Installed again (its files changed): the first goes, cleanup and all, before the second sets up; another's
    // cleanup that throws stops none of it.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registry.installProfile('box', profile, [broken, timer])
    expect(heard).toEqual(['cleanup 1'])
    expect(apis[0]!.signal.aborted).toBe(true)
    expect(apis[1]!.signal.aborted).toBe(false)
    // Revoked: nothing of it left.
    registry.installProfile('box', profile, [])
    expect(heard).toEqual(['cleanup 1', 'cleanup 2'])
    expect(toolView(registry, 'tick', there)).toBeUndefined()
    error.mockRestore()
    // Late: refused, not left behind.
    expect(() => apis[1]!.tool('late', Order)).toThrow(/torn down/)
    expect(toolView(registry, 'late', there)).toBeUndefined()
  })
})

describe('what an extension draws, drawn apart', () => {
  it('says whose failed to draw, with the error and a retry, in its place', () => {
    const boundary = new Contained({ name: 'orders', children: null })
    boundary.state = Contained.getDerivedStateFromError(new Error('boom'))
    const html = renderToStaticMarkup(boundary.render() as never)
    expect(html).toContain('orders failed to draw')
    expect(html).toContain('boom')
    expect(html).toContain('Retry')
    // Until it throws, it's only what it holds.
    expect(renderToStaticMarkup(createElement(Contained, { name: 'orders', children: 'fine' }))).toBe('fine')
  })
})
