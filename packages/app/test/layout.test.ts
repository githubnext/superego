// Where views go: the views' defaults, the user's layout (`app.layout`) on top, the narrow layout on a phone; what
// stands in for a sidebar while there's none; placing and taking out; settings from before the layout read into it.
import { describe, expect, it, vi } from 'vitest'
import { defineApp, type Json, type ThreadInfo } from '@superego/protocol'
import { defineUiExtension, type UiExtension } from '../src/renderer/extension-api.ts'
import { createRegistry } from '../src/renderer/registry.tsx'
import { paneMenu, placedFor, viewsIn } from '../src/renderer/placement.tsx'
import { isLayout, placesNow, placeView, resolveLayout, type Layout, type Placeable } from '../src/shared/layout.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const None = () => null

/** The bundled app's views, as they declare their places. */
const bundled: Placeable[] = [
  { id: 'core.picker', fits: ['titlebar'], withoutSidebar: 'titlebar' },
  { id: 'threads.list', fits: ['sidebar'], default: 'sidebar' },
  { id: 'threads.details', fits: ['beside', 'pane'] },
  { id: 'threads.model', fits: ['header'], default: 'header' },
  { id: 'ego.button', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10 },
  { id: 'ego.clear', fits: ['header'], default: 'header' },
  { id: 'files.folder', fits: ['beside', 'pane'] },
  { id: 'git.changes', fits: ['pane'], default: 'pane' },
  { id: 'unread.bell', fits: ['rail', 'drawer'], withoutSidebar: 'rail', narrow: 'drawer' },
]

describe('resolving the layout', () => {
  it("puts the bundled app's views where they were before there was a layout", () => {
    expect(resolveLayout(bundled, undefined)).toEqual({
      sidebar: ['threads.list'], rail: ['ego.button'], drawer: [], titlebar: [], beside: [], pane: ['git.changes'], header: ['threads.model', 'ego.clear'],
    })
  })

  it('stands the picker and the bell in for a sidebar while there is none', () => {
    const placed = resolveLayout(bundled, { place: { 'threads.list': null } })
    expect(placed.sidebar).toEqual([])
    expect(placed.titlebar).toEqual(['core.picker'])
    // Ego first, as its order says.
    expect(placed.rail).toEqual(['ego.button', 'unread.bell'])
    // Without the threads extension at all, the same.
    expect(resolveLayout(bundled.filter((v) => v.id !== 'threads.list'), undefined).rail).toEqual(['ego.button', 'unread.bell'])
  })

  it("takes the user's changes over the defaults, and keeps a view out of places it doesn't fit", () => {
    const placed = resolveLayout(bundled, { place: { 'threads.details': 'beside', 'ego.button': null, 'threads.model': 'sidebar' } })
    expect(placed.beside).toEqual(['threads.details'])
    expect(placed.rail).toEqual([])
    expect(placed.header).toEqual(['ego.clear'])
    expect(placed.sidebar).toEqual(['threads.list'])
  })

  it('ignores views it does not know, so a removed extension drops out', () => {
    const layout: Layout = { place: { 'gone.view': 'beside', 'threads.details': 'beside' }, order: { beside: ['gone.view', 'threads.details'] } }
    expect(resolveLayout(bundled, layout).beside).toEqual(['threads.details'])
    expect(resolveLayout(bundled.filter((v) => !v.id.startsWith('threads.')), layout).beside).toEqual([])
  })

  it('puts a view in two places at once', () => {
    const placed = resolveLayout(bundled, { place: { 'files.folder': ['beside', 'pane'] } })
    expect(placed.beside).toEqual(['files.folder'])
    expect(placed.pane).toEqual(['files.folder', 'git.changes'])
  })

  it("orders a place as the user's layout lists it, then by the views' order", () => {
    const placed = resolveLayout(bundled, { place: { 'files.folder': 'pane' }, order: { pane: ['git.changes'] } })
    expect(placed.pane).toEqual(['git.changes', 'files.folder'])
  })

  it('narrow: the views\' own narrow places, then the user\'s narrow changes', () => {
    const narrow = resolveLayout(bundled, undefined, { narrow: true })
    expect(narrow.drawer).toEqual(['ego.button', 'unread.bell'])
    expect(narrow.rail).toEqual([])
    expect(narrow.sidebar).toEqual(['threads.list'])
    // The wide changes apply narrow too, unless the view has narrow places of its own or the narrow layout says; a view
    // hidden wide is hidden there too.
    const layout: Layout = { place: { 'threads.details': 'beside', 'ego.button': 'rail' }, narrow: { place: { 'unread.bell': null }, order: { drawer: [] } } }
    const changed = resolveLayout(bundled, layout, { narrow: true })
    expect(changed.beside).toEqual(['threads.details'])
    expect(changed.drawer).toEqual(['ego.button'])
  })

  it("narrow: what the user says beats what the view says, hidden included", () => {
    // Hidden wide is hidden on a phone, though Ego goes in the drawer there by default.
    expect(resolveLayout(bundled, { place: { 'ego.button': null } }, { narrow: true }).drawer).not.toContain('ego.button')
    // Put in a place a phone draws, it's there on a phone too; in one it doesn't (the rail), where the view goes on a phone.
    expect(resolveLayout(bundled, { place: { 'unread.bell': 'drawer' } }, { narrow: false }).drawer).toEqual(['unread.bell'])
    expect(resolveLayout(bundled, { place: { 'files.folder': 'beside' } }, { narrow: true }).beside).toEqual(['files.folder'])
    expect(resolveLayout(bundled, { place: { 'ego.button': 'rail' } }, { narrow: true }).drawer).toEqual(['ego.button', 'unread.bell'])
    // The phone's own layer beats the wide one.
    expect(resolveLayout(bundled, { place: { 'ego.button': null }, narrow: { place: { 'ego.button': 'drawer' } } }, { narrow: true }).drawer).toContain('ego.button')
  })
})

describe('placing a view', () => {
  it('toggles a view in a place, keeping only what differs from its default', () => {
    const on = placeView(bundled, undefined, 'threads.details', 'beside')
    expect(on).toEqual({ place: { 'threads.details': 'beside' } })
    expect(placeView(bundled, on, 'threads.details', 'beside')).toEqual({})
    // Already there: on stays on.
    expect(placeView(bundled, on, 'threads.details', 'beside', { on: true })).toEqual(on)
    // Into a second place, and out of a default one.
    expect(placeView(bundled, on, 'threads.details', 'pane').place).toEqual({ 'threads.details': ['beside', 'pane'] })
    expect(placeView(bundled, { order: { pane: ['git.changes'] } }, 'git.changes', 'pane', { on: false })).toEqual({ order: { pane: ['git.changes'] }, place: { 'git.changes': null } })
  })

  it('leaves the layout alone for a view it does not know', () => {
    expect(placeView(bundled, { place: { x: 'beside' } }, 'nothing.here', 'beside')).toEqual({ place: { x: 'beside' } })
  })

  it('reads only layouts', () => {
    expect(isLayout({ place: { a: 'beside', b: ['beside', 'pane'], c: null }, order: { pane: ['a'] }, narrow: { place: {} } })).toBe(true)
    expect(isLayout({ place: { a: 1 } } as Json)).toBe(false)
    expect(isLayout({ narrow: { narrow: {} } })).toBe(false)
    expect(isLayout({ sidebars: [] })).toBe(false)
    expect(isLayout([])).toBe(false)
  })
})

// Moving a view, as `layout.place` does for ⌘I and the views' "Move to…" menus: in, out, from one place to another,
// wide and on a phone, keeping only what differs from the views' defaults.
const moving: Placeable[] = [
  { id: 'threads.list', fits: ['sidebar'], default: 'sidebar' },
  { id: 'threads.details', fits: ['beside', 'pane'] },
  { id: 'ego.button', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10 },
  { id: 'files.folder', fits: ['beside', 'pane'] },
  { id: 'git.changes', fits: ['pane'], default: 'pane' },
]
const resolvedMoving = (layout: Layout, narrow = false) => resolveLayout(moving, layout, { narrow })

describe('moving a view', () => {
  it('puts a view in a place and takes it out again, leaving nothing stored', () => {
    const added = placeView(moving, {}, 'threads.details', 'beside', { on: true })
    expect(added).toEqual({ place: { 'threads.details': 'beside' } })
    expect(placeView(moving, added, 'threads.details', 'beside', { on: false })).toEqual({})
  })

  it('keeps a view in its other places when it is put in one more', () => {
    const both = placeView(moving, { place: { 'files.folder': 'beside' } }, 'files.folder', 'pane', { on: true })
    expect(placesNow(moving, both, 'files.folder')).toEqual(['beside', 'pane'])
  })

  it('moves the details from beside the thread to the pane menu and back, in one change each', () => {
    const inBeside: Layout = { place: { 'threads.details': 'beside' } }
    const inPane = placeView(moving, inBeside, 'threads.details', 'pane', { from: 'beside' })
    expect(inPane).toEqual({ place: { 'threads.details': 'pane' } })
    expect(resolvedMoving(inPane).pane).toEqual(['threads.details', 'git.changes'])
    expect(resolvedMoving(inPane).beside).toEqual([])
    expect(placeView(moving, inPane, 'threads.details', 'beside', { from: 'pane' })).toEqual(inBeside)
  })

  it('moves a view back where it was by default, leaving nothing stored', () => {
    const moved = placeView(moving, {}, 'ego.button', 'drawer', { from: 'rail' })
    expect(moved).toEqual({ place: { 'ego.button': 'drawer' } })
    expect(placeView(moving, moved, 'ego.button', 'rail', { from: 'drawer' })).toEqual({})
  })

  it("changes the phone's layer when narrow, leaving the wide one", () => {
    const layout: Layout = { place: { 'threads.details': 'beside' } }
    const moved = placeView(moving, layout, 'ego.button', 'rail', { from: 'drawer', narrow: true })
    expect(moved).toEqual({ place: { 'threads.details': 'beside' }, narrow: { place: { 'ego.button': 'rail' } } })
    expect(resolvedMoving(moved, true).rail).toEqual(['ego.button'])
    expect(placeView(moving, moved, 'ego.button', 'drawer', { from: 'rail', narrow: true })).toEqual(layout)
    const off = placeView(moving, layout, 'threads.details', 'beside', { on: false, narrow: true })
    expect(off.narrow).toEqual({ place: { 'threads.details': null } })
    expect(resolvedMoving(off).beside).toEqual(['threads.details'])
  })
})

describe('views in the registry', () => {
  const orders: UiExtension = defineUiExtension({
    name: 'orders',
    setup(superego) {
      superego.view('orders.recent', { title: 'Recent orders', context: 'window', fits: ['sidebar', 'rail'], default: 'sidebar', component: None })
      superego.view('orders.order', { title: 'Order', context: 'thread', fits: ['beside', 'pane'], default: 'pane', component: None })
      superego.pane('orders.log', { title: 'Log', component: None, menu: true })
    },
  })
  const thread: ThreadInfo = { id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state: 'idle' } }

  it("declares views, and a pane menu that's the layout's", () => {
    const registry = createRegistry(app, [orders], () => {})
    expect(registry.views.map((v) => v.id)).toEqual(['orders.recent', 'orders.order', 'orders.log'])
    const placed = resolveLayout(registry.views, undefined)
    const where = { machine: 'local', thread }
    expect(paneMenu(registry, placed, where)).toEqual([{ kind: 'orders.order', title: 'Order' }, { kind: 'orders.log', title: 'Log' }])
    expect(paneMenu(registry, resolveLayout(registry.views, { place: { 'orders.log': null } }), where).map((m) => m.kind)).toEqual(['orders.order'])
    // A thread view that fits a pane is a pane kind of its id.
    expect(registry.panes.map((p) => p.kind)).toEqual(['orders.order', 'orders.log'])
  })

  it("keeps a thread's view out of the sidebar, a window's section, saying so", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tree = defineUiExtension({ name: 'tree', setup(superego) { superego.view('tree.files', { title: 'Files', context: 'thread', fits: ['sidebar', 'beside'], component: None }) } })
    const registry = createRegistry(app, [tree], () => {})
    expect(registry.views.find((v) => v.id === 'tree.files')?.fits).toEqual(['beside'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("a sidebar is the window's"))
    warn.mockRestore()
  })

  it('names views after their extension', () => {
    const bad = defineUiExtension({ name: 'bad', setup(superego) { superego.view('other.view', { title: 'x', context: 'window', fits: ['sidebar'], component: None }) } })
    expect(() => createRegistry(app, [bad], () => {})).toThrow(/bad\.<name>/)
  })

  it("keeps a profile's views to the places that show its threads, and drops them when it's set up again without them", () => {
    const registry = createRegistry(app, [], () => {})
    const profile = { scope: 'user' as const, name: 'shop', dir: '/home/me/.superego/profiles/shop' }
    registry.installProfile('local', profile, [orders])
    const recent = registry.views.find((v) => v.id === 'orders.recent')
    expect(recent).toBeUndefined()
    expect(registry.views.find((v) => v.id === 'orders.order')?.fits).toEqual(['beside', 'pane'])
    const placed = resolveLayout(registry.views, undefined)
    const mine = { machine: 'local', thread: { ...thread, profile } }
    expect(viewsIn(registry, placed, 'pane', mine).map((v) => v.id)).toEqual(['orders.order', 'orders.log'])
    expect(viewsIn(registry, placed, 'pane', { machine: 'local', thread }).map((v) => v.id)).toEqual([])
    registry.installProfile('local', profile, [])
    expect(registry.views).toEqual([])
  })

  it("installs a global profile's UI as the app's: in any place, its spaces and their links; a thread-bound profile can't add a space", () => {
    const notes = defineUiExtension({
      name: 'notes',
      setup(superego) {
        superego.view('notes.list', { title: 'Notes', context: 'window', fits: ['sidebar'], default: 'sidebar', component: None })
        superego.space('notes.page', { title: (p) => String(p.name), component: None, match: 'note:', params: (href) => ({ name: href.slice(5) }) })
      },
    })
    const profile = { scope: 'user' as const, name: 'notes', dir: '/home/me/.superego/profiles/notes' }
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('local', profile, [notes], { global: true })
    expect(registry.views.find((v) => v.id === 'notes.list')?.fits).toEqual(['sidebar'])
    expect(viewsIn(registry, resolveLayout(registry.views, undefined), 'sidebar').map((v) => v.id)).toEqual(['notes.list'])
    expect(registry.spaces.map((s) => [s.kind, s.machine])).toEqual([['notes.page', 'local']])
    expect(registry.links.some((l) => l.match === 'note:')).toBe(true)
    // Set up again without being global: its sidebar and space go, and its links with them.
    registry.installProfile('local', profile, [notes])
    expect(registry.views.find((v) => v.id === 'notes.list')).toBeUndefined()
    expect(registry.spaces).toEqual([])
    expect(registry.links.some((l) => l.match === 'note:')).toBe(false)
  })

  it('resolves a view declared in several scopes from the scope a thread is in, once', () => {
    // The same profile on two machines, its notes beside the thread on one and in the pane menu on the other.
    const notes = (where: 'beside' | 'pane'): UiExtension => defineUiExtension({
      name: 'notes', setup(superego) { superego.view('notes.list', { title: `Notes (${where})`, context: 'thread', fits: ['beside', 'pane'], default: where, component: None }) },
    })
    const registry = createRegistry(app, [], () => {})
    const profile = { scope: 'user' as const, name: 'notes', dir: '/home/me/.superego/profiles/notes' }
    registry.installProfile('local', profile, [notes('beside')])
    registry.installProfile('box', profile, [notes('pane')])
    // The probe that gave {"beside":["notes.list","notes.list"]}: each id once, whatever is passed.
    expect(resolveLayout(registry.views, undefined).beside).toEqual(['notes.list'])
    const onLocal = { machine: 'local', thread: { ...thread, profile } }
    const onBox = { machine: 'box', thread: { ...thread, profile } }
    const local = placedFor(registry, undefined, { where: onLocal })
    expect(local.beside).toEqual(['notes.list'])
    expect(local.pane).toEqual([])
    expect(viewsIn(registry, local, 'beside', onLocal).map((v) => [v.title, v.owner.profile?.split('\u0000')[0]])).toEqual([['Notes (beside)', 'local']])
    const box = placedFor(registry, undefined, { where: onBox })
    expect(box.beside).toEqual([])
    expect(paneMenu(registry, box, onBox)).toEqual([{ kind: 'notes.list', title: 'Notes (pane)' }])
    // The user's layout names the view, not a scope: it applies in both.
    expect(placedFor(registry, { place: { 'notes.list': null } }, { where: onBox }).pane).toEqual([])
    // Not the profile's thread, nor the window: none of it.
    expect(placedFor(registry, undefined, { where: { machine: 'local', thread } }).beside).toEqual([])
    expect(placedFor(registry, undefined).beside).toEqual([])
    // A profile's data view, on two machines: once, from the thread's own machine.
    const board = { id: 'notes.board', extension: 'notes', title: 'Board', context: 'thread' as const, fits: ['beside' as const], default: 'beside' as const, value: 'notes.board', profiles: [profile.dir] }
    registry.setDataViews('local', [board])
    registry.setDataViews('box', [board])
    const withBoard = placedFor(registry, undefined, { where: onBox })
    expect(withBoard.beside).toEqual(['notes.board'])
    expect(viewsIn(registry, withBoard, 'beside', onBox).map((v) => v.machines)).toEqual([['box']])
  })
})
