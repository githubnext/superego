// A process's log: absolute positions across rotation, whole characters only, and plain text from terminal output.
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { matcher, OutputLog, plainLines, tail } from '../src/log.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'processes-log-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('keeps positions across rotation: a reader goes on where it was, and what rotated away twice is gone', async () => {
  const log = new OutputLog(dir, 0, 10)
  await appendFile(log.path, 'abcdefghijkl')
  expect(await log.read(4)).toEqual({ text: 'efghijkl', from: 4, end: 12, first: 0 })
  expect(await log.rotate()).toBe(true)
  expect(log.base).toBe(12)
  await appendFile(log.path, 'mnop')
  // From before the rotation: the old file, then the new.
  expect(await log.read(10)).toEqual({ text: 'klmnop', from: 10, end: 16, first: 0 })
  expect(await log.read(16)).toMatchObject({ text: '', end: 16 })
  await appendFile(log.path, 'qrstuvwxy')
  expect(await log.rotate()).toBe(true)
  // The first file's bytes are gone now: a read from 0 starts at what's kept.
  expect(await log.read(0)).toMatchObject({ from: 12, first: 12, text: 'mnopqrstuvwxy' })
  // At most `most` back from the end.
  expect(await log.read(0, 4)).toMatchObject({ from: 21, text: 'vwxy' })
})

it('reads whole characters: a cut in the middle of one moves past it, and one half-written waits', async () => {
  const log = new OutputLog(dir)
  await appendFile(log.path, Buffer.concat([Buffer.from('aé'), Buffer.from('→').subarray(0, 2)]))
  const first = await log.read(0)
  expect(first).toMatchObject({ text: 'aé', end: 3 })
  await appendFile(log.path, Buffer.from('→').subarray(2))
  expect(await log.read(first.end)).toMatchObject({ text: '→', end: 6 })
  // Cut short from the end, inside "é": starts after it.
  expect((await log.read(0, 4)).text).toBe('→')
})

it('reads output as plain lines: colours gone, a redrawn line its last drawing', () => {
  expect(plainLines('\u001b[32mok\u001b[0m\n10%\r50%\r100%\n')).toEqual(['ok', '100%', ''])
  expect(tail('a\nb\nc\n', 2)).toBe('b\nc')
  expect(tail('err 1\nok\nerr 2\n', 5, matcher('/^err/'))).toBe('err 1\nerr 2')
  expect(matcher('ready in')('vite ready in 300ms')).toBe(true)
  expect(matcher('/listening on :\\d+/')('listening on :5173')).toBe(true)
})
