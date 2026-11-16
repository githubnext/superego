import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeAtomic, writeQueue } from '../src/write-atomic.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'write-atomic-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

it('writes a file whole, its folder made, for its owner only, and leaves no temporary file', async () => {
  const path = join(dir, 'deep', 'state.json')
  await writeAtomic(path, 'one')
  await writeAtomic(path, 'two')
  expect(await readFile(path, 'utf8')).toBe('two')
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await readdir(join(dir, 'deep'))).toEqual(['state.json'])
})

it('fails without touching the file or leaving a temporary one', async () => {
  // A folder where the file goes: the rename fails.
  const path = join(dir, 'taken')
  await writeFile(join(dir, 'other'), '')
  await mkdir(path)
  await expect(writeAtomic(path, 'x')).rejects.toThrow()
  expect((await readdir(dir)).sort()).toEqual(['other', 'taken'])
})

it('queues writes in turn: the file ends with the last, and one failing stops none after it', async () => {
  const path = join(dir, 'queued.json')
  const write = writeQueue(path)
  const writes = Array.from({ length: 20 }, (_, i) => write(String(i)))
  await Promise.all(writes)
  expect(await readFile(path, 'utf8')).toBe('19')

  const blocked = join(dir, 'blocked')
  await mkdir(blocked)
  const toFolder = writeQueue(blocked)
  await expect(toFolder('x')).rejects.toThrow()
  await rm(blocked, { recursive: true })
  await toFolder('y')
  expect(await readFile(blocked, 'utf8')).toBe('y')
})
