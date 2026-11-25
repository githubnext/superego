// Each machine's colour (machines.ts, shared.ts): given when it's added, the next slot of the palette none has, then
// the least used; given in order to those without one, and saved by a store that follows the files; changed and kept.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MachineStore, nextColour, withColours } from '../src/index.ts'

let dir: string
const stores: MachineStore[] = []
const open = () => { const store = new MachineStore(dir); stores.push(store); return store }
const saved = async (name = 'machines.json') => JSON.parse(await readFile(join(dir, name), 'utf8'))
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check().catch(() => false)) return; await new Promise((r) => setTimeout(r, 10)) }
  throw new Error('never')
}
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'colours-')) })
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await rm(dir, { recursive: true, force: true }) })

it('gives the first free slot, then the least used, the first of those', () => {
  expect(nextColour([])).toBe(1)
  expect(nextColour([1, 2, 4])).toBe(3)
  expect(nextColour([1, 2, 3, 4, 5, 6, 7, 8])).toBe(1)
  expect(nextColour([1, 2, 3, 4, 5, 6, 7, 8, 1, 2])).toBe(3)
  expect(nextColour([undefined, 5])).toBe(1)
})

it('colours those without one in order, this computer first, around those that have one', () => {
  const { here, machines } = withColours(undefined, [{ id: 'a' }, { id: 'b', colour: 2 }, { id: 'c' }, { id: 'd', colour: 99 }])
  expect(here).toBe(1)
  expect(machines.map((m) => m.colour)).toEqual([3, 2, 4, 5])
  expect(withColours(undefined, [{ id: 'a' }, { id: 'b', colour: 2 }, { id: 'c' }, { id: 'd', colour: 99 }])).toEqual({ here, machines })
})

it('gives each machine added a colour of its own while the palette lasts, then wraps to the least used', async () => {
  const store = open()
  const added = []
  for (let i = 0; i < 9; i++) added.push(await store.add({ target: `me@box${i}` }))
  // This computer has 1.
  expect(store.hereColour()).toBe(1)
  expect(added.map((m) => m.colour)).toEqual([2, 3, 4, 5, 6, 7, 8, 1, 2])
  // Taking one away leaves the others as they are; the next added takes the slot freed.
  await store.remove(added[3]!.id)
  expect(store.list().map((m) => m.colour)).toEqual([2, 3, 4, 6, 7, 8, 1, 2])
  expect((await store.add({ target: 'me@new' })).colour).toBe(5)
  expect((await saved()).map((m: { colour: number }) => m.colour)).toEqual([2, 3, 4, 6, 7, 8, 1, 2, 5])
})

it('colours a list from before colours on first load, in its order, and saves them where it follows the files', async () => {
  await writeFile(join(dir, 'machines.json'), JSON.stringify([
    { id: 'a', label: 'a', target: 'a', enabled: true },
    { id: 'b', label: 'b', target: 'b', enabled: false },
  ]))
  const store = open()
  expect(store.hereColour()).toBe(1)
  expect(store.list().map((m) => m.colour)).toEqual([2, 3])
  store.watch()
  await until(async () => (await saved()).map((m: { colour: number }) => m.colour).join() === '2,3')
  expect(await saved('this-computer.json')).toEqual({ colour: 1 })
  // Another process adds one the old way, without a colour: it's given the next, and kept.
  await writeFile(join(dir, 'machines.json'), JSON.stringify([...await saved(), { id: 'c', label: 'c', target: 'c', enabled: true }]))
  await until(async () => (await saved()).map((m: { colour: number }) => m.colour).join() === '2,3,4')
  // The same again for any other reader.
  expect(open().list().map((m) => m.colour)).toEqual([2, 3, 4])
})

it('keeps a colour changed, this computer’s too, and refuses one not in the palette', async () => {
  const store = open()
  const box = await store.add({ target: 'me@box' })
  await store.update(box.id, { colour: 7 })
  await store.setHereColour(4)
  const again = open()
  expect(again.get(box.id)?.colour).toBe(7)
  expect(again.hereColour()).toBe(4)
  await expect(store.update(box.id, { colour: 9 })).rejects.toThrow(/No colour/)
  await expect(store.setHereColour(0)).rejects.toThrow(/No colour/)
  // A store following the file hears the change.
  again.watch()
  let heard = 0
  again.onChange(() => { heard++ })
  await store.update(box.id, { colour: 3 })
  await until(async () => heard > 0 && again.get(box.id)?.colour === 3)
})
