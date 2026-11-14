// Changing the layout, as Settings → Layout and the views' "Move to…" menus do: adding, removing, moving between places,
// reordering and resetting, wide and on a phone, keeping only what differs from the views' defaults.
import { describe, expect, it } from 'vitest'
import { resolveLayout, type Layout, type Placeable } from '../src/renderer/layout.ts'
import { addable, isChanged, moveView, moveViewTo, placesOf, placeView, removeView, resetPlace } from '../src/renderer/layout-edit.ts'

const views: Placeable[] = [
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
const resolved = (layout: Layout, narrow = false) => resolveLayout(views, layout, { narrow })

describe('adding and removing', () => {
  it('offers the views that fit a place and are not there', () => {
    expect(addable(views, {}, 'aside').map((v) => v.id)).toEqual(['threads.details', 'files.folder'])
    expect(addable(views, { place: { 'threads.details': 'aside' } }, 'aside').map((v) => v.id)).toEqual(['files.folder'])
    expect(addable(views, {}, 'pane').map((v) => v.id)).toEqual(['threads.details', 'files.folder'])
  })

  it('adds a view to a place, and removing it again leaves nothing stored', () => {
    const added = placeView(views, {}, 'threads.details', 'aside', { on: true })
    expect(added).toEqual({ place: { 'threads.details': 'aside' } })
    expect(resolved(added).aside).toEqual(['threads.details'])
    expect(removeView(views, added, 'threads.details', 'aside')).toEqual({})
  })

  it('removes a default and forgets it in the order kept for that place', () => {
    const ordered = moveView(views, {}, 'ego.clear', 'header', -1)
    expect(ordered.order?.header).toEqual(['ego.clear', 'threads.model'])
    const removed = removeView(views, ordered, 'ego.clear', 'header')
    expect(removed).toEqual({ place: { 'ego.clear': null }, order: { header: ['threads.model'] } })
    expect(resolved(removed).header).toEqual(['threads.model'])
  })

  it('keeps a view in its other places when it is added to one more', () => {
    const both = placeView(views, { place: { 'files.folder': 'aside' } }, 'files.folder', 'pane', { on: true })
    expect(placesOf(views, both, 'files.folder')).toEqual(['aside', 'pane'])
  })
})

describe('moving between places', () => {
  it('moves the details from the aside to the pane menu and back, in one change each', () => {
    const inAside: Layout = { place: { 'threads.details': 'aside' } }
    const inPane = placeView(views, inAside, 'threads.details', 'pane', { from: 'aside' })
    expect(inPane).toEqual({ place: { 'threads.details': 'pane' } })
    expect(resolved(inPane).pane).toEqual(['threads.details', 'git.changes'])
    expect(resolved(inPane).aside).toEqual([])
    expect(placeView(views, inPane, 'threads.details', 'aside', { from: 'pane' })).toEqual(inAside)
  })

  it('moves a view back where it was by default, leaving nothing stored', () => {
    const moved = placeView(views, {}, 'ego.button', 'drawer', { from: 'rail' })
    expect(moved).toEqual({ place: { 'ego.button': 'drawer' } })
    expect(placeView(views, moved, 'ego.button', 'rail', { from: 'drawer' })).toEqual({})
  })

  it("changes the phone's layer when narrow, leaving the wide one", () => {
    const layout: Layout = { place: { 'threads.details': 'aside' } }
    const moved = placeView(views, layout, 'ego.button', 'rail', { from: 'drawer', narrow: true })
    expect(moved).toEqual({ place: { 'threads.details': 'aside' }, narrow: { place: { 'ego.button': 'rail' } } })
    expect(resolved(moved, true).rail).toEqual(['ego.button'])
    expect(resolved(moved).rail).toEqual(['ego.button'])
    // Back to where a phone has it by default: the narrow layer goes.
    expect(placeView(views, moved, 'ego.button', 'drawer', { from: 'rail', narrow: true })).toEqual(layout)
    // A narrow removal of a wide placement is kept in the narrow layer.
    const off = removeView(views, layout, 'threads.details', 'aside', { narrow: true })
    expect(off.narrow).toEqual({ place: { 'threads.details': null } })
    expect(resolved(off).aside).toEqual(['threads.details'])
  })
})

describe('reordering', () => {
  it('moves a view up and down within a place, clamped at the ends', () => {
    const up = moveView(views, {}, 'ego.clear', 'header', -1)
    expect(resolved(up).header).toEqual(['ego.clear', 'threads.model'])
    expect(moveView(views, up, 'ego.clear', 'header', -1)).toBe(up)
    const down = moveView(views, up, 'ego.clear', 'header', 1)
    expect(resolved(down).header).toEqual(['threads.model', 'ego.clear'])
  })

  it('drops a view at an index', () => {
    const layout = placeView(views, {}, 'files.folder', 'pane', { on: true })
    expect(resolved(layout).pane).toEqual(['files.folder', 'git.changes'])
    const moved = moveViewTo(views, layout, 'files.folder', 'pane', 5)
    expect(resolved(moved).pane).toEqual(['git.changes', 'files.folder'])
    expect(moved.order).toEqual({ pane: ['git.changes', 'files.folder'] })
  })

  it("keeps a phone's order apart from the wide one", () => {
    const narrow = moveView(views, {}, 'unread.bell', 'drawer', -1, { narrow: true })
    expect(narrow).toEqual({ narrow: { order: { drawer: ['unread.bell', 'ego.button'] } } })
    expect(resolved(narrow, true).drawer).toEqual(['unread.bell', 'ego.button'])
  })
})

describe('resetting', () => {
  const changed: Layout = {
    place: { 'threads.details': 'aside', 'ego.clear': null, 'files.folder': ['aside', 'pane'] },
    order: { aside: ['files.folder', 'threads.details'], header: ['ego.clear'] },
    narrow: { place: { 'ego.button': 'rail' } },
  }

  it('puts one place back as the defaults say, keeping the others', () => {
    const reset = resetPlace(views, changed, 'aside')
    expect(reset).toEqual({
      place: { 'ego.clear': null, 'files.folder': 'pane' },
      order: { header: ['ego.clear'] },
      narrow: { place: { 'ego.button': 'rail' } },
    })
    expect(resolved(reset).aside).toEqual([])
    expect(isChanged(views, reset, 'aside')).toBe(false)
    expect(isChanged(views, reset, 'header')).toBe(true)
    expect(resetPlace(views, resetPlace(views, reset, 'header'), 'pane')).toEqual({ narrow: { place: { 'ego.button': 'rail' } } })
  })

  it("resets a phone's place in its own layer", () => {
    expect(isChanged(views, changed, 'rail', { narrow: true })).toBe(true)
    expect(isChanged(views, changed, 'aside', { narrow: true })).toBe(false)
    const { narrow: _narrow, ...wide } = changed
    // Out of the rail; the drawer it was moved from is a place of its own, reset by itself.
    const rail = resetPlace(views, changed, 'rail', { narrow: true })
    expect(rail).toEqual({ ...wide, narrow: { place: { 'ego.button': null } } })
    expect(isChanged(views, rail, 'drawer', { narrow: true })).toBe(true)
    expect(resetPlace(views, rail, 'drawer', { narrow: true })).toEqual(wide)
  })

  it('forgets a stand-in put where it stands in, so it goes back to standing in', () => {
    const put = placeView(views, {}, 'core.picker', 'titlebar', { on: true })
    expect(put).toEqual({ place: { 'core.picker': 'titlebar' } })
    expect(resetPlace(views, put, 'titlebar')).toEqual({})
  })
})
