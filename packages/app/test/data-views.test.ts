// @vitest-environment happy-dom
// Data views: what a machine's daemon halves declare as data becomes views the layout places, a thread's only from
// its machine (a profile's only in its threads), and the core draws their blocks, whose buttons run the extension's
// own actions there.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { defineApp, type DataViewInfo, type ThreadInfo } from '@superego/protocol'
import { checkDataViews, LIMITS } from '../src/renderer/data-view-check.ts'
import { runViewAction, ViewBlocks } from '../src/renderer/data-views.tsx'
import { defineUiExtension } from '../src/renderer/extension-api.ts'
import { createRegistry, RegistryProvider } from '../src/renderer/registry.tsx'
import { paneKind } from '../src/renderer/lookups.ts'
import { paneMenu, viewsIn } from '../src/renderer/placement.tsx'
import { resolveLayout } from '../src/shared/layout.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const thread = (more: Partial<ThreadInfo> = {}): ThreadInfo => ({ id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state: 'idle' }, ...more })
const recent: DataViewInfo = { id: 'orders.recent', extension: 'orders', title: 'Recent orders', icon: 'list', context: 'window', fits: ['space', 'beside'], default: 'space', value: 'orders.recent' }
const notes: DataViewInfo = { id: 'orders.notes', extension: 'orders', title: 'Notes', context: 'thread', fits: ['beside', 'pane'], default: 'pane', method: 'orders.notes' }
const board: DataViewInfo = { id: 'staff.board', extension: 'staff', title: 'Board', context: 'thread', fits: ['beside', 'pane'], default: 'beside', value: 'staff.board', profiles: ['/p/staff'] }

describe('data views in the registry', () => {
  it('makes each a view the layout places, and a thread view that fits a pane a pane kind', () => {
    const registry = createRegistry(app, [], () => {})
    registry.setDataViews('local', [recent, notes])
    const placed = resolveLayout(registry.views, undefined)
    expect(placed.space).toEqual(['orders.recent'])
    expect(placed.pane).toEqual(['orders.notes'])
    const view = registry.views.find((v) => v.id === 'orders.recent')!
    expect(view).toMatchObject({ title: 'Recent orders', context: 'window', machines: ['local'] })
    expect(view.icon).toBeDefined()
    const where = { machine: 'local', thread: thread() }
    expect(paneKind(registry, 'orders.notes', where)?.title).toBe('Notes')
    expect(paneMenu(registry, placed, where)).toEqual([{ kind: 'orders.notes', title: 'Notes' }])
    // A thread that goes without the extension: none of it.
    expect(paneMenu(registry, placed, { machine: 'local', thread: thread({ without: ['orders'] }) })).toEqual([])
  })

  it("shows a thread's only from its machine, and one view however many machines have it", () => {
    const registry = createRegistry(app, [], () => {})
    registry.setDataViews('local', [recent, notes])
    registry.setDataViews('box', [recent])
    expect(registry.views.filter((v) => v.id === 'orders.recent').map((v) => v.machines)).toEqual([['local', 'box']])
    const placed = resolveLayout(registry.views, undefined)
    expect(paneMenu(registry, placed, { machine: 'box', thread: thread() })).toEqual([])
    expect(viewsIn(registry, placed, 'space').map((v) => v.id)).toEqual(['orders.recent'])
    // A machine gone, or its extension off: its views go with it.
    registry.setDataViews('local', [])
    expect(registry.views.filter((v) => v.id === 'orders.recent').map((v) => v.machines)).toEqual([['box']])
    expect(paneKind(registry, 'orders.notes', { machine: 'local', thread: thread() })).toBeUndefined()
  })

  it("puts a profile's in that profile's threads on that machine only", () => {
    const registry = createRegistry(app, [], () => {})
    registry.setDataViews('local', [board])
    const placed = resolveLayout(registry.views, undefined)
    const mine = thread({ profile: { name: 'staff', dir: '/p/staff', scope: 'user' } })
    expect(viewsIn(registry, placed, 'beside', { machine: 'local', thread: mine }).map((v) => v.id)).toEqual(['staff.board'])
    expect(viewsIn(registry, placed, 'beside', { machine: 'local', thread: thread() })).toEqual([])
    expect(viewsIn(registry, placed, 'beside', { machine: 'box', thread: mine })).toEqual([])
  })

  it("leaves a view an extension's UI declares to that UI", () => {
    const orders = defineUiExtension({ name: 'orders', setup(superego) { superego.view('orders.recent', { title: 'Mine', context: 'window', fits: ['space'], component: () => null }) } })
    const registry = createRegistry(app, [orders], () => {})
    registry.setDataViews('local', [recent])
    expect(registry.views.filter((v) => v.id === 'orders.recent').map((v) => v.title)).toEqual(['Mine'])
  })
})

describe("a data view's blocks", () => {
  const machine = { id: 'box', label: 'Box', state: 'connected' } as never
  const ofWindow = { extension: 'orders', context: 'window' } as const
  const draw = (blocks: unknown, info: { extension: string; context: 'window' | 'thread' } = ofWindow, more: { thread?: ThreadInfo } = {}) =>
    renderToStaticMarkup(createElement(RegistryProvider, { registry: createRegistry(app, [], () => {}), children: createElement(ViewBlocks, { machine, blocks, info, ...more }) }))

  it('draws its blocks: a list with its buttons, a table, Markdown', () => {
    const html = draw([
      { type: 'kv', items: [{ label: 'Branch', value: 'main' }] },
      { type: 'list', items: [{ title: 'No. 1', subtitle: 'Ada', detail: '5m', status: 'working', buttons: [{ id: 'ship-1', label: 'Ship', action: 'orders.ship', params: { id: '1' } }] }] },
      { type: 'table', columns: ['Day', 'Orders'], rows: [['Mon', 3]] }, { type: 'markdown', text: '**Bold**' },
    ])
    for (const part of ['Branch', 'main', 'No. 1', 'Ada', '5m', 'superego-status--working', '>Ship<', '>Day<', '>3<', '<strong>Bold</strong>']) expect(html).toContain(part)
  })

  it('says nothing is there for none, and that it is loading before it is read', () => {
    expect(draw(null)).toContain('Nothing here yet.')
    expect(draw([])).toContain('Nothing here yet.')
    expect(draw(undefined)).toContain('Loading…')
  })

  it('refuses whole what its extension may not draw, saying why in place', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Another's action; what views showed before blocks; a pane link from a window view, even drawn beside a thread.
    expect(draw([{ type: 'markdown', text: 'ok' }, { type: 'buttons', buttons: [{ id: 'x', label: 'X', action: 'thread.archive' }] }]))
      .toContain('This UI can’t be drawn: blocks[1].buttons[0].action: &quot;thread.archive&quot; isn&#x27;t one of orders&#x27;s actions')
    expect(draw({ note: 'ok', items: [] })).toContain('This UI can’t be drawn')
    const open = [{ type: 'open', label: 'Log', kind: 'editor', params: { path: 'log' } }]
    expect(draw(open, ofWindow, { thread: thread() })).toContain('a window view has no thread')
    expect(draw(open, { extension: 'orders', context: 'thread' }, { thread: thread() })).not.toContain('can’t be drawn')
    expect(draw([{ type: 'text', id: 'note' }])).toContain('need a button to send them')
    errors.mockRestore()
  })

  it("runs its extension's action on its machine with the inputs' values, then reads the view again", async () => {
    const calls: unknown[][] = []
    ;(globalThis as { window: { superego?: unknown } }).window.superego = { call: async (...args: unknown[]) => { calls.push(args); return null } }
    const ran = vi.fn()
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const blocks = [{ type: 'text', id: 'note', default: 'fragile' }, { type: 'buttons', buttons: [{ id: 'ship', label: 'Ship', action: 'orders.ship', params: { id: '1' } }] }]
    await act(async () => root.render(createElement(RegistryProvider, { registry: createRegistry(app, [], () => {}), children: createElement(ViewBlocks, { machine, blocks, info: ofWindow, ran }) })))
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Ship')!.click() })
    expect(calls).toEqual([['box', 'action.run', { id: 'orders.ship', params: { id: '1', note: 'fragile' }, exposure: 'ui' }]])
    expect(ran).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    container.remove()
  })
})

describe('what a machine sends, checked where it lands', () => {
  const on = (...names: string[]) => (extension: string) => names.includes(extension)
  const good = { id: 'orders.recent', extension: 'orders', title: 'Recent', context: 'window', fits: ['space'], value: 'orders.recent' }

  it('takes a good declaration, with only the keys a view has', () => {
    const { views, dropped } = checkDataViews([{ ...good, extra: { evil: true }, order: 3, default: ['space'], icon: 'list' }, board, notes], on('orders', 'staff'))
    expect(dropped).toEqual([])
    expect(views).toEqual([{ ...good, order: 3, default: ['space'], icon: 'list' }, board, notes])
  })

  it('leaves out what is malformed, of the wrong types, or of places there are not, and never throws', () => {
    const bad: unknown[] = [
      null, 3, 'view', [], { ...good, id: 7 }, { ...good, title: '' }, { ...good, title: { toString: 1 } }, { ...good, context: 'galaxy' },
      { ...good, fits: 'space' }, { ...good, fits: [] }, { ...good, fits: ['sidebar'] }, { ...good, fits: ['pane'] }, { ...good, fits: [null] },
      { ...good, fits: ['space', 'space', 'space', 'space'] }, { ...good, method: 'orders.read' }, { ...good, value: undefined },
      { ...good, icon: 'skull' }, { ...good, default: 'drawer' }, { ...good, narrow: ['space', 7] }, { ...good, order: Infinity }, { ...good, order: '1' },
      { ...good, about: 5 }, { ...good, profiles: 'p' }, { ...good, profiles: [] }, { ...good, profiles: [7] }, { ...good, profiles: [''] },
      { ...good, extension: undefined }, { ...good, extension: 'Orders' }, { ...good, extension: { name: 'orders' } }, { ...good, id: 'orders.' }, { ...good, id: 'orders.a b' },
    ]
    for (const view of bad) {
      const { views, dropped } = checkDataViews([view], on('orders'))
      expect(views, JSON.stringify(view)).toEqual([])
      expect(dropped).toHaveLength(1)
    }
    for (const list of [undefined, null]) expect(checkDataViews(list, on('orders'))).toEqual({ views: [], dropped: [] })
    for (const list of [{}, 'list', 5, { length: 3 }]) expect(checkDataViews(list, on('orders')).views).toEqual([])
    // Placed, none of it reaches the registry or breaks it.
    const registry = createRegistry(app, [], () => {})
    registry.setDataViews('box', checkDataViews(bad, on('orders')).views)
    expect(registry.views.filter((v) => v.owner.data)).toEqual([])
  })

  it("keeps a machine to its own extensions' names", () => {
    const { views, dropped } = checkDataViews([
      { ...good, id: 'git.status' },                        // another extension's id
      { ...good, value: 'git.secret' },                     // another extension's value
      { ...good, value: undefined, method: 'thread.list' }, // the core's method
      { ...good, extension: 'billing', id: 'billing.x', value: 'billing.x' }, // an extension the machine hasn't on
      { ...good, id: 'ordersx.recent', value: 'ordersx.recent' }, // a prefix that isn't the name
    ], on('orders'))
    expect(views).toEqual([])
    expect(dropped).toHaveLength(5)
  })

  it("keeps a profile's out of spaces, and an id to one declaration per profile", () => {
    const profiled = { ...good, context: 'thread', fits: ['space', 'beside'], profiles: ['/p'] }
    expect(checkDataViews([profiled], on('orders')).views.map((v) => v.fits)).toEqual([['beside']])
    expect(checkDataViews([{ ...profiled, fits: ['space'] }], on('orders')).views).toEqual([])
    expect(checkDataViews([good, good, profiled], on('orders')).views).toHaveLength(2)
  })

  it('bounds how much it takes', () => {
    const many = Array.from({ length: LIMITS.views + 50 }, (_, i) => ({ ...good, id: `orders.v${i}` }))
    const { views, dropped } = checkDataViews(many, on('orders'))
    expect(views).toHaveLength(LIMITS.views)
    expect(dropped).toEqual([`50 views past the first ${LIMITS.views}`])
    const long = 'x'.repeat(LIMITS.name + 1)
    for (const view of [{ ...good, title: long }, { ...good, id: `orders.${long}` }, { ...good, profiles: Array(LIMITS.profiles + 1).fill('/p') }, { ...good, about: 'x'.repeat(LIMITS.path + 1) }]) {
      expect(checkDataViews([view], on('orders')).views).toEqual([])
    }
  })
})

describe("a data view's buttons", () => {
  it("run only that extension's actions, on the machine that declared it", async () => {
    const calls: unknown[][] = []
    ;(globalThis as { window: { superego?: unknown } }).window.superego = { call: async (...args: unknown[]) => { calls.push(args); return null } }
    const registry = createRegistry(app, [], () => {})
    await runViewAction(registry, 'box', 'orders', 'orders.ship', { id: '1' })
    expect(calls).toEqual([['box', 'action.run', { id: 'orders.ship', params: { id: '1' }, exposure: 'ui' }]])
    for (const action of ['thread.archive', 'git.push', 'ordersx.go', 'orders']) {
      await expect(runViewAction(registry, 'box', 'orders', action)).rejects.toThrow()
    }
    expect(calls).toHaveLength(1)
  })

  it('keeps secret params out of the window\'s log, and all of an action it doesn\'t know yet', async () => {
    const actions = [{ id: 'orders.key', title: 'Key', runs: 'machine', expose: ['ui'], secret: ['key'] }, { id: 'orders.ship', title: 'Ship', runs: 'machine', expose: ['ui'] }]
    ;(globalThis as { window: { superego?: unknown } }).window.superego = { call: async (_machine: string, method: string) => method === 'action.list' ? actions : null }
    const registry = createRegistry(app, [], () => {})
    await runViewAction(registry, 'box', 'orders', 'orders.key', { key: 'hush-one' })
    await registry.router.load('box')
    await runViewAction(registry, 'box', 'orders', 'orders.key', { key: 'hush-two', name: 'n' })
    await registry.router.dispatch('orders.key', { key: 'hush-three' }, { machine: 'box' })
    await registry.router.dispatch('orders.ship', { id: '1' }, { machine: 'box' })
    const log = registry.router.router.log()
    expect(log.map((e) => e.params)).toEqual([undefined, { key: '•••', name: 'n' }, { key: '•••' }, { id: '1' }])
    expect(JSON.stringify(log)).not.toContain('hush')
  })
})
