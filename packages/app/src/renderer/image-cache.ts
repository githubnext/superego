// The window's copies of a thread's image files: each read once with `file.read` into a blob URL, shared by all that
// show it, and kept as long as the file is the same version (its mtime and size, as the daemon says). It's checked again
// with `file.stat` (no bytes, many paths at once) when it comes into view again, when the window comes back to the
// front, and when the thread's run ends; never on a timer. A changed file is read again and swapped in once it's
// decoded, so what shows it goes from the old picture to the new one without a gap; the old blob is let go of.
// The window's copies of a thread's images: each read once with `image.read` (as a thumbnail, or whole for the
// lightbox) into a blob URL, shared by all that show it, and kept as long as it's the same version. An image of the
// transcript never changes; a file's version is its mtime and size, as the daemon says, checked again with `file.stat`
// (no bytes, many paths at once) when it comes into view again, when the window comes back to the front, and when the
// thread's run ends; never on a timer. A changed file is read again and swapped in once it's decoded, so what shows it
// goes from the old picture to the new one without a gap; the old blob is let go of. A daemon from before `image.read`
// (no `image-read` feature) is read files whole with `file.read`.
import type { FileVersion, ImageRef, Result } from '@superego/protocol'
import { imageType } from './markdown-html.ts'

/** How much of an image is read: a thumbnail, as small as a transcript shows it, or the whole of it. */
export type ImageSize = 'thumbnail' | 'whole'

type Entry = {
  machine: string
  thread: string
  image: ImageRef
  size: ImageSize
  /** Its daemon reads only whole files (`file.read`): one from before `image.read`. */
  filesOnly: boolean
  /** The blob URL to show, once read. */
  src: Promise<string>
  url?: string
  /** A file's version as read, once it's read. */
  version?: FileVersion
  checkedAt: number
  checking?: Promise<void>
  /** Those showing it now, told when it's swapped for a newer one. */
  listeners: Set<() => void>
}

/** How soon an image coming into view again is checked again; a focus or a run's end checks regardless. */
const RECHECK_AFTER = 2000
/** How long a replaced blob URL is kept, for anything still drawing it to move to the new one. */
const REVOKE_AFTER = 5000

const entries = new Map<string, Entry>()

const nameOf = (image: ImageRef) => 'path' in image ? image.path : `\u0000${image.entry}:${image.message}:${image.block}`
const keyOf = (machine: string, thread: string, image: ImageRef, size: ImageSize) => `${machine}\u0000${thread}\u0000${nameOf(image)}\u0000${size}`
const pathOf = (entry: Entry) => 'path' in entry.image ? entry.image.path : undefined
const now = () => Date.now()
const rpc = <R,>(machine: string, method: string, params: unknown) => window.superego.call(machine, method, params) as Promise<R>

const decode = (base64: string): Uint8Array<ArrayBuffer> => {
  const typed = Uint8Array as unknown as { fromBase64?(s: string): Uint8Array<ArrayBuffer> }
  return typed.fromBase64 ? typed.fromBase64(base64) : Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

async function read(entry: Entry): Promise<{ url: string; version?: FileVersion }> {
  const { machine, thread, image } = entry
  if (entry.filesOnly) {
    if (!('path' in image)) throw new Error('Its machine runs an older Superego, which can’t show it')
    const { content, mtimeMs, size } = await rpc<Result<'file.read'>>(machine, 'file.read', { thread, path: image.path, base64: true })
    return { url: URL.createObjectURL(new Blob([decode(content)], { type: imageType(image.path) })), version: { mtimeMs, size } }
  }
  const { data, mimeType, version } = await rpc<Result<'image.read'>>(machine, 'image.read', { thread, image, ...(entry.size === 'thumbnail' ? { thumbnail: true } : {}) })
  return { url: URL.createObjectURL(new Blob([decode(data)], { type: mimeType })), ...(version ? { version } : {}) }
}

/**
 * The blob URL of a thread's image on `machine` (`size` of it), read once and kept while it stays the same.
 * `filesOnly`: its daemon has no `image.read` (it reads files whole).
 */
export function cachedImage(machine: string, thread: string, image: ImageRef, size: ImageSize, filesOnly = false): Promise<string> {
  // Without thumbnails, there's only the whole of it.
  const wanted = filesOnly ? 'whole' : size
  const key = keyOf(machine, thread, image, wanted)
  const existing = entries.get(key)
  if (existing) return existing.src
  watchWindow()
  const entry: Entry = { machine, thread, image, size: wanted, filesOnly, src: undefined!, checkedAt: now(), listeners: new Set() }
  entry.src = read(entry).then(({ url, version }) => {
    entry.url = url
    entry.version = version
    entry.checkedAt = now()
    return url
  })
  // A failed read is tried again next time it's wanted (once the machine is back, say).
  entry.src.catch(() => { if (entries.get(key) === entry) entries.delete(key) })
  entries.set(key, entry)
  return entry.src
}

/** The blob URL of an image already read (`size` of it), if it has been: to show while a larger one is read. */
export function readAlready(machine: string, thread: string, image: ImageRef, size: ImageSize): string | undefined {
  return entries.get(keyOf(machine, thread, image, size))?.url
}

/**
 * Hear when a file's image (`size` of it) is swapped for a newer version (read the new one with cachedImage). Only
 * after cachedImage has asked for it: listening, it's checked, and a transcript's images never change.
 */
export function onImageChange(machine: string, thread: string, image: ImageRef, size: ImageSize, listener: () => void, filesOnly = false): () => void {
  const entry = entries.get(keyOf(machine, thread, image, filesOnly ? 'whole' : size))
  if (!entry || !pathOf(entry)) return () => {}
  const held = entry
  held.listeners.add(listener)
  return () => { held.listeners.delete(listener) }
}

type Which = { machine?: string; thread?: string; path?: string; force?: boolean }

/**
 * Check images against their files, and swap in those that changed: those `which` names (by machine, thread, path)
 * that something shows now. Without `force`, one checked in the last moment isn't checked again.
 */
export function recheckImages(which: Which = {}): Promise<void> {
  const due = [...entries.values()].filter((entry) => pathOf(entry) !== undefined && entry.version && entry.url && !entry.checking
    && entry.listeners.size > 0
    && (!which.machine || entry.machine === which.machine) && (!which.thread || entry.thread === which.thread)
    && (!which.path || pathOf(entry) === which.path) && (which.force || now() - entry.checkedAt >= RECHECK_AFTER))
  const groups = new Map<string, Entry[]>()
  for (const entry of due) {
    const group = `${entry.machine}\u0000${entry.thread}`
    groups.set(group, [...groups.get(group) ?? [], entry])
  }
  return Promise.all([...groups.values()].map((group) => check(group))).then(() => {})
}

async function check(group: Entry[]) {
  const { machine, thread } = group[0]!
  let done!: () => void
  const checking = new Promise<void>((resolve) => { done = resolve })
  for (const entry of group) { entry.checking = checking; entry.checkedAt = now() }
  try {
    // A file read as a thumbnail and whole is checked the once.
    const paths = [...new Set(group.map((e) => pathOf(e)!))]
    const { files } = await rpc<Result<'file.stat'>>(machine, 'file.stat', { thread, paths })
    const versions = new Map(paths.map((path, index) => [path, files[index]]))
    await Promise.all(group.map((entry) => {
      const version = versions.get(pathOf(entry)!)
      // Gone (or unreadable now): what was shown stays.
      if (!version || (version.mtimeMs === entry.version!.mtimeMs && version.size === entry.version!.size)) return
      return swap(entry)
    }))
  } catch {
    // Not answered just now (the machine away): what was shown stays, and it's checked again next time.
  } finally {
    for (const entry of group) entry.checking = undefined
    done()
  }
}

async function swap(entry: Entry) {
  try {
    const { url, version } = await read(entry)
    await decoded(url)
    const old = entry.url
    entry.url = url
    entry.version = version
    entry.src = Promise.resolve(url)
    for (const listener of [...entry.listeners]) listener()
    if (old) setTimeout(() => URL.revokeObjectURL(old), REVOKE_AFTER)
  } catch {
    // Unreadable just now: the old one stays, and it's tried again next time.
  }
}

/** Once `url` is decoded and ready to draw, so swapping it in shows no gap. */
function decoded(url: string): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve()
  const image = new Image()
  image.src = url
  return image.decode().catch(() => {})
}

let watching = false
/** The window coming back to the front: what it shows may have changed while it was away. */
function watchWindow() {
  if (watching || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  watching = true
  const again = () => { void recheckImages({ force: true }) }
  window.addEventListener('focus', again)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') again() })
}
