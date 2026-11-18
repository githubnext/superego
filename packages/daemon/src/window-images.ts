// The images a window shows of a thread's. A transcript keeps each image it holds (a pasted screenshot, one `read`
// gave the model) whole, as base64, for the model; a window gets it without its pixels (`ImageStub`: its kind and
// size), so opening a thread doesn't bring every screenshot in it over the link, a remote machine's over ssh. The window
// reads the pixels with `image.read` as each image nears the screen: as a thumbnail, as small as a transcript shows it,
// made here (on the machine with the image) in the same worker that fits images to the model, and kept beside the
// thread's attachments (`.thumbnails/`) for next time; whole only when it's opened in the lightbox.
import { createHash } from 'node:crypto'
import { open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ImageProcessor } from '@earendil-works/pi-durable/tools'
import { RpcError, type FileVersion, type ImageRef, type ImageStub, type Methods } from '@superego/protocol'
import { attachmentsDir } from './attachments.ts'
import { sniff } from './image-kind.ts'
import { writeAtomic } from './write-atomic.ts'

/**
 * How big a thumbnail may be: about the transcript's widest column at twice the device's pixels, and three times that
 * tall (a screenshot of a whole page shows its top, cropped); the weight a screenshot takes as a good JPEG at that size.
 */
export const THUMBNAIL = { maxWidth: 1600, maxHeight: 4800, maxBytes: 1024 * 1024 }
/** What a thumbnail is made of: the formats the worker decodes. GIFs (they may move) and SVGs (they scale) stay as they are. */
const SCALED = new Set(['image/png', 'image/jpeg', 'image/webp'])
/** How much of an image's base64 is read for its header. */
const HEAD = 4 * Math.ceil(64 * 1024 / 3)
/** How large a file is read whole: `file.read`'s limit. */
const READ_LIMIT = 16 * 1024 * 1024

type Block = { type?: unknown; data?: unknown; mimeType?: unknown }
const isImage = (value: unknown): value is Block & { data: string; mimeType: string } => {
  const block = value as Block | null
  return typeof block === 'object' && block !== null && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
}

/** An image block as a window gets it: its kind, weight and size, not its pixels. */
export function stubOf(block: { data: string; mimeType: string }): ImageStub {
  const kind = sniff(Buffer.from(block.data.slice(0, HEAD), 'base64'))
  return { type: 'image', mimeType: block.mimeType, bytes: Buffer.byteLength(block.data, 'base64'), ...(kind?.width && kind.height ? { width: kind.width, height: kind.height } : {}) }
}

/** `value` with every image block in it a stub: copied where one is, the rest shared as it is (it's the live view's). */
export function withoutPixels<T>(value: T): T {
  if (isImage(value)) return stubOf(value) as T
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    value.forEach((item, index) => {
      const next = withoutPixels(item)
      if (next !== item) (copy ??= [...value])[index] = next
    })
    return (copy ?? value) as T
  }
  if (value && typeof value === 'object') {
    let copy: Record<string, unknown> | undefined
    for (const [key, item] of Object.entries(value)) {
      const next = withoutPixels(item)
      if (next !== item) (copy ??= { ...value as Record<string, unknown> })[key] = next
    }
    return (copy ?? value) as T
  }
  return value
}

/**
 * A watch's ops (Chord's: `["r", value]`, `["s", path, value]`, `["p", path, at, count, values]`, …) with what they put
 * in a stub for each image. An image's own fields aren't set one by one: entries are whole when they're added.
 */
export function opsWithoutPixels(ops: readonly unknown[]): unknown[] {
  return ops.map((op) => {
    if (!Array.isArray(op)) return op
    if (op[0] === 'r' && op.length === 2) return withoutPixels(op)
    if (op[0] === 's' && op.length === 3) return withoutPixels(op)
    if (op[0] === 'p' && op.length === 5) return withoutPixels(op)
    return op
  })
}

type Read = Methods['image.read']['result']

export type WindowImages = {
  read(thread: string, image: ImageRef, thumbnail: boolean): Promise<Read>
}

/**
 * `image.read`: `file` resolves a path as `file.read` would (refusing one it wouldn't); `block` finds an entry's image
 * block in a thread's transcript.
 */
export function createWindowImages({ dataDir, processor, file, block }: {
  dataDir: string
  processor: ImageProcessor
  file(thread: string, path: string): Promise<string>
  block(thread: string, entry: number, message: number, block: number): Promise<{ data: string; mimeType: string } | undefined>
}): WindowImages {
  /** Thumbnails being made, by where they're kept: two windows asking at once wait for the one. */
  const making = new Map<string, Promise<Read>>()

  /**
   * An image's thumbnail, kept as `name` (and the extension of its kind) in the thread's `.thumbnails`, else made and
   * kept there; those kept of an older version of what it's `of` go.
   */
  async function thumbnail(thread: string, name: string, of: string, bytes: () => Promise<Buffer>, mimeType: string): Promise<Read> {
    const dir = join(attachmentsDir(dataDir, thread), '.thumbnails')
    const kept = await readdir(dir).then((names) => names.find((n) => n.startsWith(`${name}.`) && !n.endsWith('.tmp')), () => undefined)
    if (kept) {
      const data = await readFile(join(dir, kept)).catch(() => undefined)
      const kind = data && sniff(data)
      if (data && kind) return { data: data.toString('base64'), mimeType: kind.mimeType, ...size(kind) }
    }
    const key = join(dir, name)
    const already = making.get(key)
    if (already) return already
    const made = (async () => {
      const prepared = await processor.prepare(asOwn(await bytes()), mimeType, THUMBNAIL)
      if (!prepared) throw new RpcError('invalid', 'It can’t be read as an image')
      const out = Buffer.from(prepared.data, 'base64')
      const kind = sniff(out)
      try {
        await writeAtomic(join(dir, `${name}.${kind?.ext ?? 'jpg'}`), out, 0o644)
        if (name !== of) for (const old of await readdir(dir)) if (old.startsWith(`${of}-`) && !old.startsWith(`${name}.`)) await rm(join(dir, old), { force: true })
      } catch (error) {
        // Shown all the same: it's made again next time.
        console.error(`Thread ${thread}: a thumbnail couldn't be kept in ${dir}:`, error)
      }
      return { data: prepared.data, mimeType: prepared.mimeType, ...size(prepared.resized?.to ?? kind ?? {}) }
    })().finally(() => making.delete(key))
    making.set(key, made)
    return made
  }

  return {
    async read(thread, image, wantThumbnail) {
      if ('path' in image) {
        const path = await file(thread, image.path)
        const info = await stat(path).catch(() => undefined)
        if (!info?.isFile()) throw new RpcError('not_found', `No file ${image.path}`)
        if (info.size > READ_LIMIT) throw new RpcError('too_large', `${image.path} is larger than ${READ_LIMIT / 1024 / 1024} MB`)
        const version: FileVersion = { mtimeMs: info.mtimeMs, size: info.size }
        if (wantThumbnail) {
          const head = await readHead(path)
          const kind = sniff(head)
          if (kind && needsThumbnail(kind, info.size)) {
            const of = hash(path)
            return { ...await thumbnail(thread, `${of}-${hash(`${info.mtimeMs}:${info.size}`)}`, of, () => readFile(path), kind.mimeType), version }
          }
        }
        const bytes = await readFile(path)
        const kind = sniff(bytes)
        return { data: bytes.toString('base64'), mimeType: kind?.mimeType ?? typeOf(path), ...size(kind ?? {}), version }
      }
      const found = await block(thread, image.entry, image.message, image.block)
      if (!found) throw new RpcError('not_found', `No image at entry ${image.entry}, message ${image.message}, block ${image.block}`)
      const stub = stubOf(found)
      if (wantThumbnail && needsThumbnail({ mimeType: found.mimeType, ...size(stub) }, stub.bytes)) {
        const of = `entry-${image.entry}-${image.message}-${image.block}`
        return thumbnail(thread, of, of, async () => Buffer.from(found.data, 'base64'), found.mimeType)
      }
      return { data: found.data, mimeType: found.mimeType, ...size(stub) }
    },
  }
}

/** Whether an image is larger than a thumbnail would be: in pixels, or in weight (its size unknown, too). */
function needsThumbnail(kind: { mimeType: string; width?: number; height?: number }, bytes: number) {
  if (!SCALED.has(kind.mimeType)) return false
  if (!kind.width || !kind.height) return true
  return kind.width > THUMBNAIL.maxWidth || kind.height > THUMBNAIL.maxHeight || Math.ceil(bytes / 3) * 4 > THUMBNAIL.maxBytes
}

const size = ({ width, height }: { width?: number; height?: number }) => width && height ? { width, height } : {}
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
/** A Buffer of its own: one off Node's pool can't be moved to the worker. */
const asOwn = (bytes: Buffer) => new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))

async function readHead(path: string) {
  const handle = await open(path)
  try {
    const head = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon' }
const typeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
