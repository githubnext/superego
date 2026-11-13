// The window's list of installed font families (fonts.ts), against a fake Local Font Access API and storage: kept
// across launches, read again in the background only where access is granted, once a session, and never asked for.
import { beforeEach, expect, it, vi } from 'vitest'
import { createFontList, type FontSource } from '../src/renderer/fonts.ts'

let stored: Map<string, string>
let installed: string[]
let permission: PermissionState | undefined
let queries: number
let hasApi: boolean

const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) }
const source = (): FontSource => ({
  query: () => hasApi ? async () => { queries++; return installed.map((family) => ({ family })) } : undefined,
  permission: async () => permission,
  storage,
})

beforeEach(() => {
  stored = new Map()
  installed = ['Menlo', 'Arial', 'Arial', 'Helvetica']
  permission = 'granted'
  queries = 0
  hasApi = true
})

it('reads the families once, sorted and without repeats, and keeps them for the next launch', async () => {
  const first = createFontList(source(), () => 42)
  expect(first.get()).toBeUndefined()
  expect(await first.load()).toEqual(['Arial', 'Helvetica', 'Menlo'])
  expect(await first.load()).toEqual(['Arial', 'Helvetica', 'Menlo'])
  expect(queries).toBe(1)
  expect(JSON.parse(stored.get('superego.fonts')!)).toEqual({ families: ['Arial', 'Helvetica', 'Menlo'], at: 42 })

  const next = createFontList(source())
  expect(next.get()).toEqual(['Arial', 'Helvetica', 'Menlo'])
  expect(queries).toBe(1)
})

it('refreshes the kept list in the background where access is granted, telling listeners only of a change', async () => {
  createFontList(source()).load()
  await vi.waitFor(() => expect(stored.has('superego.fonts')).toBe(true))
  const list = createFontList(source())
  const changed = vi.fn()
  list.subscribe(changed)

  await list.refresh()
  expect(queries).toBe(2)
  expect(changed).not.toHaveBeenCalled()

  installed.push('Georgia')
  const later = createFontList(source())
  later.subscribe(changed)
  await later.refresh()
  expect(later.get()).toEqual(['Arial', 'Georgia', 'Helvetica', 'Menlo'])
  expect(changed).toHaveBeenCalledOnce()
  // Once a session.
  await later.refresh()
  expect(queries).toBe(3)
})

it('never reads in the background without access granted, nor where there is no API', async () => {
  for (const state of ['prompt', 'denied', undefined] as const) {
    permission = state
    await createFontList(source()).refresh()
  }
  hasApi = false
  permission = 'granted'
  await createFontList(source()).refresh()
  expect(queries).toBe(0)
})

it('asks when opened without access, keeps what it gets, and fails as before where there is no API', async () => {
  permission = 'prompt'
  const list = createFontList(source())
  expect(await list.load()).toEqual(['Arial', 'Helvetica', 'Menlo'])
  expect(createFontList(source()).get()).toEqual(['Arial', 'Helvetica', 'Menlo'])

  hasApi = false
  await expect(createFontList(source()).load()).rejects.toThrow('This build cannot list fonts')
})

it('tries again after a failed read, and ignores a broken saved list', async () => {
  stored.set('superego.fonts', '{not json')
  let fail = true
  const list = createFontList({ ...source(), query: () => async () => { if (fail) throw new Error('denied'); return [{ family: 'Menlo' }] } })
  expect(list.get()).toBeUndefined()
  await expect(list.load()).rejects.toThrow('denied')
  await Promise.resolve()
  fail = false
  expect(await list.load()).toEqual(['Menlo'])
})
