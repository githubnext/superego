// Moving a view, as `layout.place` does for ⌘I and the views' "Move to…" menus: in, out, from one place to another,
// wide and on a phone, keeping only what differs from the views' defaults.
import { describe, expect, it } from 'vitest'
import { resolveLayout, type Layout, type Placeable } from '../src/renderer/layout.ts'
import { placesOf, placeView } from '../src/renderer/layout-edit.ts'

const views: Placeable[] = [
  { id: 'threads.list', fits: ['space'], default: 'space' },
  { id: 'threads.details', fits: ['aside', 'pane'] },
  { id: 'ego.button', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10 },
  { id: 'files.folder', fits: ['space', 'aside', 'pane'] },
  { id: 'git.changes', fits: ['pane'], default: 'pane' },
]
const resolved = (layout: Layout, narrow = false) => resolveLayout(views, layout, { narrow })

describe('moving a view', () => {
  it('puts a view in a place and takes it out again, leaving nothing stored', () => {
    const added = placeView(views, {}, 'threads.details', 'aside', { on: true })
    expect(added).toEqual({ place: { 'threads.details': 'aside' } })
    expect(placeView(views, added, 'threads.details', 'aside', { on: false })).toEqual({})
  })

  it('keeps a view in its other places when it is put in one more', () => {
    const both = placeView(views, { place: { 'files.folder': 'aside' } }, 'files.folder', 'pane', { on: true })
    expect(placesOf(views, both, 'files.folder')).toEqual(['aside', 'pane'])
  })

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
    expect(placeView(views, moved, 'ego.button', 'drawer', { from: 'rail', narrow: true })).toEqual(layout)
    const off = placeView(views, layout, 'threads.details', 'aside', { on: false, narrow: true })
    expect(off.narrow).toEqual({ place: { 'threads.details': null } })
    expect(resolved(off).aside).toEqual(['threads.details'])
  })
})
