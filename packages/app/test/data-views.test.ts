// Data views: what a machine's daemon extensions declare as data becomes views the layout places, a thread's only from
// its machine (a profile's only in its threads), and the core draws their content.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defineApp, type DataViewInfo, type ThreadInfo } from '@superego/protocol'
import { contentOf, DataContent } from '../src/renderer/data-views.tsx'
import { createRegistry, defineUiExtension, paneKind, paneMenu, RegistryProvider, viewsIn } from '../src/renderer/extension.tsx'
import { resolveLayout } from '../src/renderer/layout.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const thread = (more: Partial<ThreadInfo> = {}): ThreadInfo => ({ id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state: 'idle' }, ...more })
const recent: DataViewInfo = { id: 'orders.recent', extension: 'orders', title: 'Recent orders', icon: 'list', context: 'window', fits: ['space', 'aside'], default: 'space', value: 'orders.recent' }
const notes: DataViewInfo = { id: 'orders.notes', extension: 'orders', title: 'Notes', context: 'thread', fits: ['aside', 'pane'], default: 'pane', method: 'orders.notes' }
const board: DataViewInfo = { id: 'staff.board', extension: 'staff', title: 'Board', context: 'thread', fits: ['aside', 'pane'], default: 'aside', value: 'staff.board', profiles: ['/p/staff'] }

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
    expect(viewsIn(registry, placed, 'aside', { machine: 'local', thread: mine }).map((v) => v.id)).toEqual(['staff.board'])
    expect(viewsIn(registry, placed, 'aside', { machine: 'local', thread: thread() })).toEqual([])
    expect(viewsIn(registry, placed, 'aside', { machine: 'box', thread: mine })).toEqual([])
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
    expect(contentOf(null)).toBeUndefined()
    expect(contentOf([1])).toBeUndefined()
    expect(contentOf({
      note: 'two', items: [{ title: 'A', status: 'working', actions: [{ title: 'Go', action: 'x.go' }, { title: 'No action' }] }, { subtitle: 'no title' }, 'junk'],
      facts: [{ label: 'Branch', value: 'main' }, { label: 'x' }], table: { columns: ['a'], rows: [[1, 'b', { no: 1 }], 'junk'] }, markdown: false, actions: 'nope',
    })).toEqual({
      note: 'two', items: [{ title: 'A', status: 'working', actions: [{ title: 'Go', action: 'x.go' }] }],
      facts: [{ label: 'Branch', value: 'main' }], table: { columns: ['a'], rows: [['1', 'b', null]] }, actions: [],
    })
  })

  it('draws a note, facts, a list with its buttons, a table and Markdown', () => {
    const registry = createRegistry(app, [], () => {})
    const machine = { id: 'local', label: 'This Mac', state: 'connected' } as never
    const draw = (content: unknown) => renderToStaticMarkup(createElement(RegistryProvider, { registry, children: createElement(DataContent, { machine, content }) }))
    const html = draw({
        note: '1 running', facts: [{ label: 'Branch', value: 'main' }],
        items: [{ title: 'No. 1', subtitle: 'Ada', detail: '5m', status: 'working', actions: [{ title: 'Ship', action: 'orders.ship', params: { id: '1' } }, { title: 'Archive', action: 'orders.archive', icon: 'archive' }] }],
        table: { columns: ['Day', 'Orders'], rows: [['Mon', 3]] }, markdown: '**Bold**', actions: [{ title: 'Refresh', action: 'orders.refresh' }],
    })
    for (const part of ['1 running', '<dt>Branch</dt><dd>main</dd>', 'No. 1', 'Ada', '5m', 'superego-status--working', '>Ship<', 'aria-label="Archive"', '<th>Day</th>', '<td>3</td>', '<strong>Bold</strong>', '>Refresh<']) {
      expect(html).toContain(part)
    }
    expect(draw({ empty: 'No orders yet.' })).toContain('No orders yet.')
  })
})
