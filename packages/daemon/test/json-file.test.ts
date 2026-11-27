// An extension's JSON state file (`superego.jsonFile`): read once, saved whole and atomically one at a time, the newest
// winning; a file that doesn't read kept aside and never written over, what's wrong said; saves refused after teardown.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openJsonFile } from '../src/json-file.ts'

type State = { version: 1; items: string[] }
const EMPTY: State = { version: 1, items: [] }
const check = (data: unknown) => Array.isArray((data as State | null)?.items) ? undefined : 'it has no list of items'

let dir: string
let said: (string | undefined)[]
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'json-file-')); said = [] })
afterEach(() => rm(dir, { recursive: true, force: true }))
const open = () => openJsonFile<State>(() => dir, 'state.json', 'test', { empty: EMPTY, check, trouble: (message) => said.push(message) })

it('reads what was saved, or empty; saves one at a time, the newest of those made meanwhile', async () => {
  const file = open()
  expect(await file.read()).toEqual(EMPTY)
  let asked = 0
  const saves = [1, 2, 3, 4].map((n) => file.save(() => { asked++; return { version: 1, items: [`v${n}`] } }))
  await Promise.all(saves)
  // The first, then the newest of those made while it wrote.
  expect(asked).toBe(2)
  expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual({ version: 1, items: ['v4'] })
  expect(await open().read()).toEqual({ version: 1, items: ['v4'] })
  expect(await readdir(dir)).toEqual(['state.json'])
  expect(said).toEqual([])
})

it("keeps a file that doesn't read aside, says so, and saves anew", async () => {
  await writeFile(join(dir, 'state.json'), '{"version":1,"items":["a",')
  const file = open()
  expect(await file.read()).toEqual(EMPTY)
  expect(file.bad).toMatchObject({ text: '{"version":1,"items":["a",', keptAs: expect.stringMatching(/state\.json\.bad-\d+$/) })
  expect(said).toEqual([expect.stringMatching(/^state\.json didn't read \(.+\), so what it held is gone for now: it's kept as .+state\.json\.bad-\d+\.$/)])
  await file.save({ version: 1, items: ['b'] })
  expect(await readFile(file.bad!.keptAs!, 'utf8')).toBe('{"version":1,"items":["a",')
  // One that `check` refuses is as bad.
  await writeFile(join(dir, 'state.json'), '{"version":1}')
  const refused = open()
  expect(await refused.read()).toEqual(EMPTY)
  expect(refused.bad?.why).toBe('it has no list of items')
})

it("never writes over one it couldn't keep aside: saves refused, and said", async () => {
  await writeFile(join(dir, 'state.json'), 'not json')
  // A folder it can't rename in.
  await chmod(dir, 0o500)
  try {
    const file = open()
    expect(await file.read()).toEqual(EMPTY)
    expect(file.bad?.keptAs).toBeUndefined()
    await expect(file.save({ version: 1, items: ['x'] })).rejects.toThrow(/nor could it be kept aside/)
    expect(said.at(-1)).toMatch(/nothing is saved until it's fixed or removed/)
  } finally {
    await chmod(dir, 0o700)
  }
  expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe('not json')
})

it('says a failed save, and clears it once one lands; refuses saves once closed, after the last landed', async () => {
  const file = open()
  await file.read()
  await mkdir(join(dir, 'state.json'))
  await expect(file.save(EMPTY)).rejects.toThrow()
  expect(said.at(-1)).toMatch(/^Saving state\.json failed: /)
  await rm(join(dir, 'state.json'), { recursive: true })
  await file.save({ version: 1, items: ['ok'] })
  expect(said.at(-1)).toBeUndefined()
  const last = file.save({ version: 1, items: ['last'] })
  await file.close()
  await last
  expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).items).toEqual(['last'])
  await expect(file.save(EMPTY)).rejects.toThrow(/torn down/)
})
