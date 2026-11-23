import { expect, it } from 'vitest'
import { emptyHistory, step, visit, type History, type Place } from '../src/renderer/history.ts'

const t = (thread: string, machine = 'local'): Place => ({ thread: { machine, thread } })
const settings: Place = { settings: true }
const all = (_place: Place) => true
const through = (...places: Place[]) => places.reduce(visit, emptyHistory)
const back = (h: History, exists = all) => step(h, -1, h.places[h.at], exists)
const forward = (h: History, exists = all) => step(h, 1, h.places[h.at], exists)

it('keeps the places visited, once each in a row', () => {
  const h = through(t('a'), t('b'), t('b'), t('c'))
  expect(h.places).toEqual([t('a'), t('b'), t('c')])
  expect(h.at).toBe(2)
  // Another machine's thread of the same id is another place.
  expect(visit(h, t('c', 'box')).places).toHaveLength(4)
})

it('goes back and forward without adding places', () => {
  let h = through(t('a'), t('b'), t('c'))
  const b = back(h)!
  expect(b.place).toEqual(t('b'))
  h = visit(b.history, b.place)
  expect(h).toEqual({ places: [t('a'), t('b'), t('c')], at: 1 })
  h = back(h)!.history
  expect(h.at).toBe(0)
  expect(back(h)).toBeUndefined()
  const f = forward(h)!
  expect(f.place).toEqual(t('b'))
  h = forward(f.history)!.history
  expect(h.at).toBe(2)
  expect(forward(h)).toBeUndefined()
})

it('drops what was ahead when going somewhere new after going back', () => {
  let h = through(t('a'), t('b'), t('c'))
  h = back(back(h)!.history)!.history
  h = visit(h, t('d'))
  expect(h).toEqual({ places: [t('a'), t('d')], at: 1 })
  expect(forward(h)).toBeUndefined()
})

it('steps over places that are gone, and over the place shown', () => {
  const h = through(t('a'), t('gone'), t('b'), t('a'), t('gone'))
  const exists = (p: Place) => !('thread' in p && p.thread.thread === 'gone')
  // From the gone one at the end, back: a; from a, back over its gone neighbour: b.
  expect(back(h, exists)?.place).toEqual(t('a'))
  const fromA = { ...h, at: 3 }
  expect(step(fromA, -1, t('a'), exists)?.place).toEqual(t('b'))
  const fromB = { ...h, at: 2 }
  // Back from b: the gone one, then a.
  expect(step(fromB, -1, t('b'), exists)).toEqual({ history: { ...h, at: 0 }, place: t('a') })
  // Forward from a, over its own repeat and the gone one at the end: nothing.
  expect(step(fromA, 1, t('a'), exists)).toBeUndefined()
})

it('takes leaving Settings for where it was opened as going back', () => {
  let h = through(t('a'), settings)
  h = visit(h, t('a'))
  expect(h).toEqual({ places: [t('a'), settings], at: 0 })
  expect(forward(h)?.place).toEqual(settings)
  // Leaving it for somewhere else goes on from it.
  h = visit(through(t('a'), settings), t('b'))
  expect(h.places).toEqual([t('a'), settings, t('b')])
})


it('tells surfaces apart by kind, machine and params', () => {
  const note = (name: string, machine = 'local'): Place => ({ surface: { machine, kind: 'notes.page', params: { name } } })
  const h = through(t('a'), note('x'), note('x'), note('y'), note('y', 'box'))
  expect(h.places).toEqual([t('a'), note('x'), note('y'), note('y', 'box')])
  expect(back(h)?.place).toEqual(note('y'))
})
