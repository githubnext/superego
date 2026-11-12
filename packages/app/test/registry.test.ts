// The UI registry: what an extension registers is its own, a profile's is scoped to that profile on its machine, and
// installing a profile again replaces everything it registered before.
import { describe, expect, it } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { createRegistry, defineUiExtension, entryView, paneKind, settingsView, toolView, type UiExtension } from '../src/renderer/extension.tsx'

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
