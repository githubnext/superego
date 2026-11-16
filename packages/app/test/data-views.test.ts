// Data views: what a machine's daemon halves declare as data becomes views the layout places, a thread's only from
// its machine (a profile's only in its threads), and the core draws their content.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defineApp, type DataViewInfo, type ThreadInfo } from '@superego/protocol'
import { checkContent, checkDataViews, contentOf, LIMITS } from '../src/renderer/data-view-check.ts'
import { DataContent, DataViewBoundary, runViewAction } from '../src/renderer/data-views.tsx'
import { createRegistry, defineUiExtension, paneKind, paneMenu, RegistryProvider, viewsIn } from '../src/renderer/extension.tsx'
import { resolveLayout } from '../src/renderer/layout.ts'

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

describe('data view content', () => {
  it('keeps only what is shaped as content', () => {
    expect(contentOf(null, 'x')).toBeUndefined()
    expect(contentOf([1], 'x')).toBeUndefined()
    expect(contentOf({
      note: 'two', items: [{ title: 'A', status: 'working', actions: [{ title: 'Go', action: 'x.go' }, { title: 'No action' }] }, { subtitle: 'no title' }, 'junk'],
      facts: [{ label: 'Branch', value: 'main' }, { label: 'x' }], table: { columns: ['a'], rows: [[1, 'b', { no: 1 }], 'junk'] }, markdown: false, actions: 'nope',
    }, 'x')).toEqual({
      note: 'two', items: [{ title: 'A', status: 'working', actions: [{ title: 'Go', action: 'x.go' }] }],
      facts: [{ label: 'Branch', value: 'main' }], table: { columns: ['a'], rows: [['1', 'b', null]] }, actions: [],
    })
  })

  it("keeps only buttons that run the extension's own actions", () => {
    const content = contentOf({ actions: [{ title: 'Ship', action: 'orders.ship' }, { title: 'Archive', action: 'thread.archive' }, { title: 'Sneaky', action: 'ordersx.go' }, { title: 'Bare', action: 'orders' }] }, 'orders')
    expect(content?.actions).toEqual([{ title: 'Ship', action: 'orders.ship' }])
  })

  it('draws a note, facts, a list with its buttons, a table and Markdown', () => {
    const registry = createRegistry(app, [], () => {})
    const machine = { id: 'local', label: 'This Mac', state: 'connected' } as never
    const draw = (content: unknown) => renderToStaticMarkup(createElement(RegistryProvider, { registry, children: createElement(DataContent, { machine, content, extension: 'orders' }) }))
    const html = draw({
        note: '1 running', facts: [{ label: 'Branch', value: 'main' }],
        items: [{ title: 'No. 1', subtitle: 'Ada', detail: '5m', status: 'working', actions: [{ title: 'Ship', action: 'orders.ship', params: { id: '1' } }, { title: 'Archive', action: 'orders.archive', icon: 'archive' }] }],
        table: { columns: ['Day', 'Orders'], rows: [['Mon', 3]] }, markdown: '**Bold**', actions: [{ title: 'Refresh', action: 'orders.refresh' }],
    })
    for (const part of ['1 running', '<dt>Branch</dt><dd>main</dd>', 'No. 1', 'Ada', '5m', 'superego-status--working', '>Ship<', 'aria-label="Archive"', '<th>Day</th>', '<td>3</td>', '<strong>Bold</strong>', '>Refresh<']) {
      expect(html).toContain(part)
    }
    expect(draw({ empty: 'No orders yet.' })).toContain('No orders yet.')
    // Read, with nothing: none, not loading.
    expect(draw(null)).toContain('Nothing here yet.')
    expect(draw(undefined)).toContain('Loading…')
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

  it('leaves out content of the wrong shape or too big, and says so', () => {
    for (const raw of ['text', 5, true, [1, 2]]) expect(checkContent(raw, 'x')).toEqual({ dropped: ['isn’t view content'] })
    expect(checkContent(null, 'x')).toEqual({ dropped: [] })
    const huge = 'x'.repeat(LIMITS.text + 1)
    const deep = Array.from({ length: LIMITS.depth + 2 }).reduce<unknown>((inner) => ({ inner }), 1)
    const { content, dropped } = checkContent({
      note: huge, markdown: 'x'.repeat(LIMITS.markdown + 1), facts: { label: 'a' }, items: Array.from({ length: LIMITS.items + 3 }, (_, i) => ({ title: `r${i}` })),
      table: { columns: Array(LIMITS.columns + 5).fill('c'), rows: [Array(LIMITS.columns + 5).fill(1), 'row'] },
      actions: [{ title: 'Deep', action: 'x.deep', params: deep }, { title: 'Big', action: 'x.big', params: { s: 'x'.repeat(LIMITS.params) } },
        { title: 'Odd', action: 'x.odd', params: { n: NaN } }, { title: 'Fine', action: 'x.fine', params: { id: 1 }, icon: 'skull' }],
    }, 'x')
    expect(content).toMatchObject({ actions: [{ title: 'Fine', action: 'x.fine', params: { id: 1 } }] })
    expect(content?.note).toBeUndefined()
    expect(content?.markdown).toBeUndefined()
    expect(content?.facts).toEqual([])
    expect(content?.items).toHaveLength(LIMITS.items)
    expect(content?.table?.columns).toHaveLength(LIMITS.columns)
    expect(content?.table?.rows).toHaveLength(1)
    expect(content?.table?.rows[0]).toHaveLength(LIMITS.columns)
    expect(dropped.length).toBeGreaterThanOrEqual(8)
  })

  it('draws a quiet word where content was left out', () => {
    const registry = createRegistry(app, [], () => {})
    const machine = { id: 'box', label: 'Box', state: 'connected' } as never
    const html = renderToStaticMarkup(createElement(RegistryProvider, { registry, children: createElement(DataContent, { machine, content: { note: 'ok', actions: [{ title: 'X', action: 'thread.archive' }] }, extension: 'orders' }) }))
    expect(html).toContain('ok')
    expect(html).toContain('Left out some of what Box sent')
    expect(html).not.toContain('>X<')
  })
})

describe("a data view's buttons", () => {
  it("run only that extension's actions, on the machine that declared it", async () => {
    const calls: unknown[][] = []
    ;(globalThis as { window?: unknown }).window = { superego: { call: async (...args: unknown[]) => { calls.push(args); return null } } }
    const registry = createRegistry(app, [], () => {})
    await runViewAction(registry, 'box', 'orders', { title: 'Ship', action: 'orders.ship', params: { id: '1' } })
    expect(calls).toEqual([['box', 'action.run', { id: 'orders.ship', params: { id: '1' }, exposure: 'ui' }]])
    for (const action of ['thread.archive', 'git.push', 'ordersx.go', 'orders']) {
      await expect(runViewAction(registry, 'box', 'orders', { title: 'Sneaky', action })).rejects.toThrow()
    }
    expect(calls).toHaveLength(1)
  })

})

describe('a data view that throws as it draws', () => {
  it('says so in its place, with Try again', () => {
    const boundary = new DataViewBoundary({ id: 'orders.recent', place: 'beside', children: null })
    boundary.state = DataViewBoundary.getDerivedStateFromError(new Error('boom'))
    const html = renderToStaticMarkup(boundary.render() as never)
    expect(html).toContain('orders.recent couldn’t be drawn')
    expect(html).toContain('title="boom"')
    expect(html).toContain('Try again')
  })
})
