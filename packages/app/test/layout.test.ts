// Where views go: the views' defaults, the user's layout (`app.layout`) on top, the narrow layout on a phone; what
// stands in for a space while there's none; placing and taking out; settings from before the layout read into it.
import { describe, expect, it } from 'vitest'
import { defineApp, type Json, type ThreadInfo } from '@superego/protocol'
import { MemorySettingsStore } from '@superego/settings'
import { createRegistry, defineUiExtension, paneMenu, viewsIn, type UiExtension } from '../src/renderer/extension.tsx'
import { isLayout, placesNow, placeView, resolveLayout, type Layout, type Placeable } from '../src/renderer/layout.ts'
import { withMovedLayout } from '../src/shared.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const None = () => null

/** The bundled app's views, as they declare their places. */
const bundled: Placeable[] = [
  { id: 'core.picker', fits: ['titlebar'], withoutSpaces: 'titlebar' },
  { id: 'threads.list', fits: ['space'], default: 'space' },
  { id: 'threads.details', fits: ['aside', 'pane'] },
  { id: 'threads.model', fits: ['header'], default: 'header' },
  { id: 'ego.button', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10 },
  { id: 'ego.clear', fits: ['header'], default: 'header' },
  { id: 'files.folder', fits: ['space', 'aside', 'pane'] },
  { id: 'git.changes', fits: ['pane'], default: 'pane' },
  { id: 'unread.bell', fits: ['rail', 'drawer'], withoutSpaces: 'rail', narrow: 'drawer' },
]

describe('resolving the layout', () => {
  it("puts the bundled app's views where they were before there was a layout", () => {
    expect(resolveLayout(bundled, undefined)).toEqual({
      space: ['threads.list'], rail: ['ego.button'], drawer: [], titlebar: [], aside: [], pane: ['git.changes'], header: ['threads.model', 'ego.clear'],
    })
  })

  it('stands the picker and the bell in for a space while there is none', () => {
    const placed = resolveLayout(bundled, { place: { 'threads.list': null } })
    expect(placed.space).toEqual([])
    expect(placed.titlebar).toEqual(['core.picker'])
    // Ego first, as its order says.
    expect(placed.rail).toEqual(['ego.button', 'unread.bell'])
    // Without the threads extension at all, the same.
    expect(resolveLayout(bundled.filter((v) => v.id !== 'threads.list'), undefined).rail).toEqual(['ego.button', 'unread.bell'])
  })

  it("takes the user's changes over the defaults, and keeps a view out of places it doesn't fit", () => {
    const placed = resolveLayout(bundled, { place: { 'threads.details': 'aside', 'ego.button': null, 'threads.model': 'space' } })
    expect(placed.aside).toEqual(['threads.details'])
    expect(placed.rail).toEqual([])
    expect(placed.header).toEqual(['ego.clear'])
    expect(placed.space).toEqual(['threads.list'])
  })

  it('ignores views it does not know, so a removed extension drops out', () => {
    const layout: Layout = { place: { 'gone.view': 'aside', 'threads.details': 'aside' }, order: { aside: ['gone.view', 'threads.details'] } }
    expect(resolveLayout(bundled, layout).aside).toEqual(['threads.details'])
    expect(resolveLayout(bundled.filter((v) => !v.id.startsWith('threads.')), layout).aside).toEqual([])
  })

  it('puts a view in two places at once', () => {
    const placed = resolveLayout(bundled, { place: { 'files.folder': ['aside', 'pane'] } })
    expect(placed.aside).toEqual(['files.folder'])
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
    expect(narrow.space).toEqual(['threads.list'])
    // The wide changes apply narrow too, unless the view has narrow places of its own or the narrow layout says; a view
    // hidden wide is hidden there too.
    const layout: Layout = { place: { 'threads.details': 'aside', 'ego.button': 'rail' }, narrow: { place: { 'unread.bell': null }, order: { drawer: [] } } }
    const changed = resolveLayout(bundled, layout, { narrow: true })
    expect(changed.aside).toEqual(['threads.details'])
    expect(changed.drawer).toEqual(['ego.button'])
    expect(resolveLayout(bundled, { place: { 'ego.button': null } }, { narrow: true }).drawer).not.toContain('ego.button')
  })
})

describe('placing a view', () => {
  it('toggles a view in a place, keeping only what differs from its default', () => {
    const on = placeView(bundled, undefined, 'threads.details', 'aside')
    expect(on).toEqual({ place: { 'threads.details': 'aside' } })
    expect(placeView(bundled, on, 'threads.details', 'aside')).toEqual({})
    // Already there: on stays on.
    expect(placeView(bundled, on, 'threads.details', 'aside', { on: true })).toEqual(on)
    // Into a second place, and out of a default one.
    expect(placeView(bundled, on, 'threads.details', 'pane').place).toEqual({ 'threads.details': ['aside', 'pane'] })
    expect(placeView(bundled, { order: { pane: ['git.changes'] } }, 'git.changes', 'pane', { on: false })).toEqual({ order: { pane: ['git.changes'] }, place: { 'git.changes': null } })
  })

  it('leaves the layout alone for a view it does not know', () => {
    expect(placeView(bundled, { place: { x: 'aside' } }, 'nothing.here', 'aside')).toEqual({ place: { x: 'aside' } })
  })

  it('reads only layouts', () => {
    expect(isLayout({ place: { a: 'aside', b: ['aside', 'pane'], c: null }, order: { pane: ['a'] }, narrow: { place: {} } })).toBe(true)
    expect(isLayout({ place: { a: 1 } } as Json)).toBe(false)
    expect(isLayout({ narrow: { narrow: {} } })).toBe(false)
    expect(isLayout({ spaces: [] })).toBe(false)
    expect(isLayout([])).toBe(false)
  })
})

// Moving a view, as `layout.place` does for ⌘I and the views' "Move to…" menus: in, out, from one place to another,
// wide and on a phone, keeping only what differs from the views' defaults.
const moving: Placeable[] = [
  { id: 'threads.list', fits: ['space'], default: 'space' },
  { id: 'threads.details', fits: ['aside', 'pane'] },
  { id: 'ego.button', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10 },
  { id: 'files.folder', fits: ['space', 'aside', 'pane'] },
  { id: 'git.changes', fits: ['pane'], default: 'pane' },
]
const resolvedMoving = (layout: Layout, narrow = false) => resolveLayout(moving, layout, { narrow })

describe('moving a view', () => {
  it('puts a view in a place and takes it out again, leaving nothing stored', () => {
    const added = placeView(moving, {}, 'threads.details', 'aside', { on: true })
    expect(added).toEqual({ place: { 'threads.details': 'aside' } })
    expect(placeView(moving, added, 'threads.details', 'aside', { on: false })).toEqual({})
  })

  it('keeps a view in its other places when it is put in one more', () => {
    const both = placeView(moving, { place: { 'files.folder': 'aside' } }, 'files.folder', 'pane', { on: true })
    expect(placesNow(moving, both, 'files.folder')).toEqual(['aside', 'pane'])
  })

  it('moves the details from the aside to the pane menu and back, in one change each', () => {
    const inAside: Layout = { place: { 'threads.details': 'aside' } }
    const inPane = placeView(moving, inAside, 'threads.details', 'pane', { from: 'aside' })
    expect(inPane).toEqual({ place: { 'threads.details': 'pane' } })
    expect(resolvedMoving(inPane).pane).toEqual(['threads.details', 'git.changes'])
    expect(resolvedMoving(inPane).aside).toEqual([])
    expect(placeView(moving, inPane, 'threads.details', 'aside', { from: 'pane' })).toEqual(inAside)
  })

  it('moves a view back where it was by default, leaving nothing stored', () => {
    const moved = placeView(moving, {}, 'ego.button', 'drawer', { from: 'rail' })
    expect(moved).toEqual({ place: { 'ego.button': 'drawer' } })
    expect(placeView(moving, moved, 'ego.button', 'rail', { from: 'drawer' })).toEqual({})
  })

  it("changes the phone's layer when narrow, leaving the wide one", () => {
    const layout: Layout = { place: { 'threads.details': 'aside' } }
    const moved = placeView(moving, layout, 'ego.button', 'rail', { from: 'drawer', narrow: true })
    expect(moved).toEqual({ place: { 'threads.details': 'aside' }, narrow: { place: { 'ego.button': 'rail' } } })
    expect(resolvedMoving(moved, true).rail).toEqual(['ego.button'])
    expect(placeView(moving, moved, 'ego.button', 'drawer', { from: 'rail', narrow: true })).toEqual(layout)
    const off = placeView(moving, layout, 'threads.details', 'aside', { on: false, narrow: true })
    expect(off.narrow).toEqual({ place: { 'threads.details': null } })
    expect(resolvedMoving(off).aside).toEqual(['threads.details'])
  })
})

describe('views in the registry', () => {
  const orders: UiExtension = defineUiExtension({
    name: 'orders',
    setup(superego) {
      superego.view('orders.recent', { title: 'Recent orders', context: 'window', fits: ['space', 'rail'], default: 'space', component: None })
      superego.view('orders.order', { title: 'Order', context: 'thread', fits: ['aside', 'pane'], default: 'pane', component: None })
      superego.slot('thread.header', None)
      superego.slot('thread.header', None, { order: 5 })
      superego.pane('orders.log', { title: 'Log', component: None, menu: true })
    },
  })
  const thread: ThreadInfo = { id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state: 'idle' } }

  it("declares views, slots in the old places as views of them, and a pane menu that's the layout's", () => {
    const registry = createRegistry(app, [orders], () => {})
    expect(registry.views.map((v) => v.id)).toEqual(['orders.recent', 'orders.order', 'orders.thread.header', 'orders.thread.header.2', 'orders.log'])
    const placed = resolveLayout(registry.views, undefined)
    expect(placed.header).toEqual(['orders.thread.header.2', 'orders.thread.header'])
    const where = { machine: 'local', thread }
    expect(paneMenu(registry, placed, where)).toEqual([{ kind: 'orders.order', title: 'Order' }, { kind: 'orders.log', title: 'Log' }])
    expect(paneMenu(registry, resolveLayout(registry.views, { place: { 'orders.log': null } }), where).map((m) => m.kind)).toEqual(['orders.order'])
    // A thread view that fits a pane is a pane kind of its id.
    expect(registry.panes.map((p) => p.kind)).toEqual(['orders.order', 'orders.log'])
  })

  it('names views after their extension', () => {
    const bad = defineUiExtension({ name: 'bad', setup(superego) { superego.view('other.view', { title: 'x', context: 'window', fits: ['space'], component: None }) } })
    expect(() => createRegistry(app, [bad], () => {})).toThrow(/bad\.<name>/)
  })

  it("keeps a profile's views to the places that show its threads, and drops them when it's set up again without them", () => {
    const registry = createRegistry(app, [], () => {})
    const profile = { scope: 'user' as const, name: 'shop', dir: '/home/me/.superego/profiles/shop' }
    registry.installProfile('local', profile, [orders])
    const recent = registry.views.find((v) => v.id === 'orders.recent')
    expect(recent).toBeUndefined()
    expect(registry.views.find((v) => v.id === 'orders.order')?.fits).toEqual(['aside', 'pane'])
    const placed = resolveLayout(registry.views, undefined)
    const mine = { machine: 'local', thread: { ...thread, profile } }
    expect(viewsIn(registry, placed, 'pane', mine).map((v) => v.id)).toEqual(['orders.order', 'orders.log'])
    expect(viewsIn(registry, placed, 'pane', { machine: 'local', thread }).map((v) => v.id)).toEqual([])
    registry.installProfile('local', profile, [])
    expect(registry.views).toEqual([])
  })

  it('draws and lists a view once, however many scopes declare it, as the thread\'s own declares it', () => {
    const registry = createRegistry(app, [], () => {})
    const profile = { scope: 'user' as const, name: 'shop', dir: '/home/me/.superego/profiles/shop' }
    registry.installProfile('local', profile, [orders])
    registry.installProfile('box', profile, [orders])
    const placed = resolveLayout(registry.views, undefined)
    expect(placed.pane).toEqual(['orders.order', 'orders.log'])
    const onBox = { machine: 'box', thread: { ...thread, profile } }
    const drawn = viewsIn(registry, placed, 'pane', onBox)
    expect(drawn.map((v) => v.id)).toEqual(['orders.order', 'orders.log'])
    expect(drawn.every((v) => v.owner.profile?.startsWith('box'))).toBe(true)
    expect(paneMenu(registry, placed, onBox).map((m) => m.kind)).toEqual(['orders.order', 'orders.log'])
    // A profile's data view, on two machines.
    registry.setDataViews('local', [{ id: 'shop.board', extension: 'shop', title: 'Board', context: 'thread', fits: ['aside'], default: 'aside', value: 'shop.board', profiles: [profile.dir] }])
    registry.setDataViews('box', [{ id: 'shop.board', extension: 'shop', title: 'Board', context: 'thread', fits: ['aside'], default: 'aside', value: 'shop.board', profiles: [profile.dir] }])
    expect(resolveLayout(registry.views, undefined).aside).toEqual(['shop.board'])
    expect(viewsIn(registry, resolveLayout(registry.views, undefined), 'aside', onBox).map((v) => v.machines)).toEqual([['box']])
  })
})

describe('settings from before the layout', () => {
  it("reads thread details turned on as the details in the aside, and drops the old setting", () => {
    expect(withMovedLayout(new MemorySettingsStore({ 'threads.details': true, 'app.keys': {} })).load())
      .toEqual({ 'app.keys': {}, 'app.layout': { place: { 'threads.details': 'aside' } } })
    expect(withMovedLayout(new MemorySettingsStore({ 'threads.details': false })).load()).toEqual({})
    // A layout that already says where details go wins.
    expect(withMovedLayout(new MemorySettingsStore({ 'threads.details': true, 'app.layout': { place: { 'threads.details': null }, order: {} } })).load())
      .toEqual({ 'app.layout': { place: { 'threads.details': null }, order: {} } })
    expect(withMovedLayout(new MemorySettingsStore({ 'app.layout': { order: {} } })).load()).toEqual({ 'app.layout': { order: {} } })
  })

  it('places the views the old settings did, so the window looks as it did', () => {
    const layout = withMovedLayout(new MemorySettingsStore({ 'threads.details': true })).load()['app.layout'] as Layout
    expect(resolveLayout(bundled, layout).aside).toEqual(['threads.details'])
  })
})
