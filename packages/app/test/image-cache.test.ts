// The window's image files (image-cache.ts), against a fake `window.superego`: read once and kept while the file stays
// the same version, and read again and swapped (the old blob let go of) when it changes.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SuperegoBridge } from '../src/shared/bridge.ts'
import { fileImage, onImageChange, recheckImages } from '../src/renderer/image-cache.ts'

type Call = { machine: string; method: string; params: any }
let calls: Call[]
/** The files on the fake machine: their version. */
let files: Record<string, { mtimeMs: number; size: number }>
let revoked: string[]
let made: number

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  files = {}
  revoked = []
  made = 0
  const bridge: Partial<SuperegoBridge> = {
    async call(machine, method, params: any) {
      calls.push({ machine, method, params })
      if (method === 'file.read') return { path: params.path, content: btoa('png'), ...files[params.path] }
      if (method === 'file.stat') {
        return { files: params.paths.map((path: string) => files[path] ?? null) }
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  ;(globalThis as { window?: unknown }).window = { superego: bridge }
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++made}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url) })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

let n = 0
/** A thread no other test has, so the cache starts empty for it. */
const fresh = () => `t${++n}`
const count = (method: string) => calls.filter((c) => c.method === method).length

it('keeps an image while its file is the same version, without reading it again', async () => {
  const thread = fresh()
  files['shot.png'] = { mtimeMs: 1, size: 3 }
  const src = await fileImage('m', thread, 'shot.png')
  const off = onImageChange('m', thread, 'shot.png', () => {})
  await recheckImages({ force: true })
  expect(await fileImage('m', thread, 'shot.png')).toBe(src)
  expect(count('file.stat')).toBe(1)
  expect(count('file.read')).toBe(1)
  off()
})

it('reads a changed file again, swaps it in, and lets the old blob go', async () => {
  const thread = fresh()
  files['shot.png'] = { mtimeMs: 1, size: 3 }
  const first = await fileImage('m', thread, 'shot.png')
  const heard = vi.fn()
  const off = onImageChange('m', thread, 'shot.png', heard)
  files['shot.png'] = { mtimeMs: 2, size: 3 }
  await recheckImages({ machine: 'm', thread, force: true })
  const second = await fileImage('m', thread, 'shot.png')
  expect(second).not.toBe(first)
  expect(heard).toHaveBeenCalledOnce()
  expect(count('file.read')).toBe(2)
  // Let go of a moment later, once what showed it has moved to the new one.
  expect(revoked).toEqual([])
  await vi.advanceTimersByTimeAsync(10_000)
  expect(revoked).toEqual([first])
  off()
})

it('checks many of a thread’s images in one call, only those shown, and not again so soon unless forced', async () => {
  const thread = fresh()
  files['a.png'] = { mtimeMs: 1, size: 1 }
  files['b.png'] = { mtimeMs: 1, size: 1 }
  files['c.png'] = { mtimeMs: 1, size: 1 }
  await Promise.all(['a.png', 'b.png', 'c.png'].map((path) => fileImage('m', thread, path)))
  const offs = ['a.png', 'b.png'].map((path) => onImageChange('m', thread, path, () => {}))
  await recheckImages({ thread })
  expect(count('file.stat')).toBe(0)
  await vi.advanceTimersByTimeAsync(5000)
  await recheckImages({ thread })
  expect(calls.filter((c) => c.method === 'file.stat').map((c) => c.params.paths)).toEqual([['a.png', 'b.png']])
  for (const off of offs) off()
})
