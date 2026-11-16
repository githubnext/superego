// The app's windows between launches: which are kept as they close, which a launch reopens, and where.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { placeOn, WindowList } from '../src/main/windows.ts'

let dir: string
let path: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'superego-windows-')); path = join(dir, 'windows.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const bounds = { x: 10, y: 20, width: 900, height: 700 }

describe('the windows kept', () => {
  it('opens a new one first, the first of the app; another opened beside it is not', () => {
    const list = new WindowList(path)
    expect(list.closed()).toEqual([])
    const a = list.open()
    const b = list.open()
    expect(a.first).toBe(true)
    expect(b.first).toBe(false)
    expect(a.id).not.toBe(b.id)
    expect(list.recent()).toEqual([b.id, a.id])
  })

  it('keeps the one last in front first', () => {
    const list = new WindowList(path)
    const a = list.open().id
    const b = list.open().id
    list.focused(a)
    expect(list.recent()).toEqual([a, b])
  })

  it('forgets a window closed beside others, its state with it', () => {
    const list = new WindowList(path)
    const a = list.open().id
    const b = list.open().id
    list.close(b)
    expect(list.ids()).toEqual([a])
    expect(new WindowList(path).closed().map((e) => e.id)).toEqual([a])
  })

  it('keeps the last one closed, to reopen as it was', () => {
    const list = new WindowList(path)
    const a = list.open().id
    list.moved(a, bounds)
    list.close(a)
    expect(list.closed()).toEqual([{ id: a, bounds }])
    expect(list.open(a)).toEqual({ id: a, first: true })
    expect(list.closed()).toEqual([])
  })

  it('keeps every window open as the app quits, the one last in front first', () => {
    const list = new WindowList(path)
    const a = list.open().id
    const b = list.open().id
    list.focused(a)
    list.quitting()
    list.close(a)
    list.close(b)
    expect(new WindowList(path).closed().map((e) => e.id)).toEqual([a, b])
  })

  it('keeps the windows put away all at once (⌘Q with the menu bar item on)', () => {
    const list = new WindowList(path)
    const a = list.open().id
    const b = list.open().id
    const c = list.open().id
    list.close(c)
    list.keep(list.recent())
    list.close(a)
    list.close(b)
    expect(list.closed().map((e) => e.id)).toEqual([b, a])
    // Reopened, they're closed as any other again.
    list.open(a)
    list.open(b)
    list.close(a)
    expect(list.ids()).toEqual([b])
  })

  it('is kept as the app left it, after a quit without a word (app.exit), but where a window moved last', () => {
    const list = new WindowList(path)
    const a = list.open().id
    list.moved(a, bounds)
    expect(new WindowList(path).closed()).toEqual([{ id: a }])
    list.open()
    expect(new WindowList(path).closed().find((e) => e.id === a)).toEqual({ id: a, bounds })
  })

  it('reads past what is not a window', () => {
    writeFileSync(path, JSON.stringify({ windows: [{ id: 'ok' }, { id: '../no' }, { id: 'ok' }, { id: 'b', bounds: { x: 'no' } }, 7] }))
    expect(new WindowList(path).closed()).toEqual([{ id: 'ok' }, { id: 'b' }])
    writeFileSync(path, 'not json')
    expect(new WindowList(path).closed()).toEqual([])
  })
})

describe('where a window reopens', () => {
  const screens = [{ x: 0, y: 0, width: 1440, height: 900 }]
  it('where it was, while its title bar is on a screen', () => {
    expect(placeOn(bounds, screens)).toEqual(bounds)
    expect(placeOn({ ...bounds, x: 1300 }, screens)).toEqual({ ...bounds, x: 1300 })
  })

  it('at its size alone when the screen it was on is gone', () => {
    expect(placeOn({ ...bounds, x: 2000 }, screens)).toEqual({ width: 900, height: 700 })
    expect(placeOn({ ...bounds, y: -600 }, screens)).toEqual({ width: 900, height: 700 })
  })
})

it('reopens windows where they were among the others', () => {
  const list = new WindowList(path)
  const a = list.open().id
  const b = list.open().id
  list.quitting()
  list.close(a)
  list.close(b)
  const again = new WindowList(path)
  expect(again.open(b)).toEqual({ id: b, first: true })
  again.open(a)
  expect(again.recent()).toEqual([b, a])
})
