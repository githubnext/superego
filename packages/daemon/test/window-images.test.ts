import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import type { ImageProcessor } from '@earendil-works/pi-durable/tools'
import { sniff } from '../src/image-kind.ts'
import { createWindowImages, opsWithoutPixels, THUMBNAIL, withoutPixels } from '../src/window-images.ts'
import { png } from './image-fixtures.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-window-images-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const sizeOf = (data: string) => sniff(Buffer.from(data, 'base64'))

/** The worker's processor, counting the images it's asked to make smaller. */
async function counted() {
  const processor = await createNodePhotonImages({ worker: false })
  const made = { count: 0 }
  const counting: ImageProcessor = { prepare: (...args) => { made.count++; return processor.prepare(...args) } }
  return { processor: counting, made }
}

it('gives a window images without their pixels, sharing what has none', () => {
  const big = b64(png(300, 2000))
  const entry = { id: 3, model: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: big, mimeType: 'image/png' }] }] }
  const plain = { id: 2, model: [{ role: 'user', content: 'hi' }] }
  const view = { entries: [plain, entry], docs: { 'pi.live': { run: null } } }
  const out = withoutPixels(view)
  expect(out.entries[1]!.model[0]!.content[1]).toEqual({ type: 'image', mimeType: 'image/png', bytes: Buffer.from(big, 'base64').length, width: 300, height: 2000 })
  expect(out.entries[0]).toBe(plain)
  expect(out.docs).toBe(view.docs)
  // The live view it came from is left as it was.
  expect((entry.model[0]!.content[1] as { data: string }).data).toBe(big)
  expect(withoutPixels(plain)).toBe(plain)
})

it("gives a watch's ops without pixels: an entry added, a value replaced", () => {
  const image = { type: 'image', data: b64(png(4, 4)), mimeType: 'image/png' }
  const ops = opsWithoutPixels([
    ['p', ['entries'], 2, 0, [{ id: 9, model: [{ role: 'toolResult', content: [image] }] }]],
    ['r', { entries: [{ id: 1, model: [{ role: 'user', content: [image] }] }] }],
    ['a', ['entries', 0, 'text'], 'more'],
  ]) as unknown[][]
  const stub = { type: 'image', mimeType: 'image/png', bytes: png(4, 4).length, width: 4, height: 4 }
  expect((ops[0]![4] as { model: { content: unknown[] }[] }[])[0]!.model[0]!.content[0]).toEqual(stub)
  expect((ops[1]![1] as { entries: { model: { content: unknown[] }[] }[] }).entries[0]!.model[0]!.content[0]).toEqual(stub)
  expect(ops[2]).toEqual(['a', ['entries', 0, 'text'], 'more'])
})

it("reads a file as a thumbnail, made once, kept beside the thread's attachments, and made again when the file changes", async () => {
  const { processor, made } = await counted()
  const shot = join(dir, 'shot.png')
  await writeFile(shot, png(2560, 12000))
  await utimes(shot, 1000, 1000)
  const images = createWindowImages({ dataDir: dir, processor, file: async (_thread, path) => join(dir, path), block: async () => undefined })
  const first = await images.read('7', { path: 'shot.png' }, true)
  // Scaled to fit the thumbnail's bounds, keeping its shape.
  expect(first).toMatchObject({ width: 1024, height: 4800, version: { mtimeMs: 1_000_000 } })
  expect(sizeOf(first.data)).toMatchObject({ width: 1024, height: 4800 })
  expect(first.data.length).toBeLessThanOrEqual(THUMBNAIL.maxBytes)
  const kept = join(dir, 'attachments', '7', '.thumbnails')
  expect(await readdir(kept)).toHaveLength(1)
  // Again, and two at once: the one kept, not made again.
  const [again, twice] = await Promise.all([images.read('7', { path: 'shot.png' }, true), images.read('7', { path: 'shot.png' }, true)])
  expect(again.data).toBe(first.data)
  expect(twice.data).toBe(first.data)
  expect(made.count).toBe(1)
  // Changed: made again, and the old one goes.
  await writeFile(shot, png(1000, 6000, [200, 30, 30]))
  await utimes(shot, 2000, 2000)
  const changed = await images.read('7', { path: 'shot.png' }, true)
  expect(changed).toMatchObject({ width: 800, height: 4800, version: { mtimeMs: 2_000_000 } })
  expect(made.count).toBe(2)
  expect(await readdir(kept)).toHaveLength(1)
  // Whole when asked for whole.
  const whole = await images.read('7', { path: 'shot.png' }, false)
  expect(whole).toMatchObject({ mimeType: 'image/png', width: 1000, height: 6000 })
  expect(whole.data).toBe(b64(png(1000, 6000, [200, 30, 30])))
})

it('reads an image small enough already as it is, and one of a transcript by where it is', async () => {
  const { processor, made } = await counted()
  const small = png(640, 480)
  await writeFile(join(dir, 'small.png'), small)
  const big = b64(png(3000, 2000))
  const images = createWindowImages({
    dataDir: dir, processor, file: async (_thread, path) => join(dir, path),
    block: async (_thread, entry, message, block) => entry === 5 && message === 0 && block === 1 ? { data: big, mimeType: 'image/png' } : undefined,
  })
  expect(await images.read('7', { path: 'small.png' }, true)).toMatchObject({ data: b64(small), mimeType: 'image/png', width: 640, height: 480 })
  expect(made.count).toBe(0)
  const thumbnail = await images.read('7', { entry: 5, message: 0, block: 1 }, true)
  expect(thumbnail).toMatchObject({ width: 1600, height: 1067 })
  expect(await readdir(join(dir, 'attachments', '7', '.thumbnails'))).toEqual([expect.stringMatching(/^entry-5-0-1\./)])
  expect(await images.read('7', { entry: 5, message: 0, block: 1 }, false)).toEqual({ data: big, mimeType: 'image/png', width: 3000, height: 2000 })
  await expect(images.read('7', { entry: 5, message: 0, block: 2 }, true)).rejects.toMatchObject({ kind: 'not_found' })
  await expect(images.read('7', { path: 'gone.png' }, true)).rejects.toMatchObject({ kind: 'not_found' })
})
