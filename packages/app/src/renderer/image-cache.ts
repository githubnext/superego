// The window's copies of a thread's image files: each read once with `file.read` into a blob URL, shared by all that
// show it, and kept as long as the file is the same version (its mtime and size, as the daemon says). It's checked again
// with `file.stat` (no bytes, many paths at once) when it comes into view again, when the window comes back to the
// front, and when the thread's run ends; never on a timer. A changed file is read again and swapped in once it's
// decoded, so what shows it goes from the old picture to the new one without a gap; the old blob is let go of.
import type { FileVersion, Result } from '@superego/protocol'
import { imageType } from './markdown-html.ts'

type Entry = {
  machine: string
  thread: string
  path: string
  type: string
  /** The blob URL to show, once read. */
  src: Promise<string>
  url?: string
  /** The file's version as read, once it's read. */
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

const keyOf = (machine: string, thread: string, path: string) => `${machine}\u0000${thread}\u0000${path}`
const now = () => Date.now()
const rpc = <R,>(machine: string, method: string, params: unknown) => window.superego.call(machine, method, params) as Promise<R>

const decode = (base64: string): Uint8Array<ArrayBuffer> => {
  const typed = Uint8Array as unknown as { fromBase64?(s: string): Uint8Array<ArrayBuffer> }
  return typed.fromBase64 ? typed.fromBase64(base64) : Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

async function read(entry: Pick<Entry, 'machine' | 'thread' | 'path' | 'type'>) {
  const { content, mtimeMs, size } = await rpc<Result<'file.read'>>(entry.machine, 'file.read', { thread: entry.thread, path: entry.path, base64: true })
  const url = URL.createObjectURL(new Blob([decode(content)], { type: entry.type }))
  return { url, version: { mtimeMs, size } }
}

/** The blob URL of a thread's image file on `machine`, read once and kept while the file stays the same. */
export function fileImage(machine: string, thread: string, path: string, mimeType?: string): Promise<string> {
  const key = keyOf(machine, thread, path)
  const existing = entries.get(key)
  if (existing) return existing.src
  watchWindow()
  const entry: Entry = { machine, thread, path, type: mimeType ?? imageType(path), src: undefined!, checkedAt: now(), listeners: new Set() }
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

/** Hear when the image at `path` is swapped for a newer version (read the new one with fileImage). */
export function onImageChange(machine: string, thread: string, path: string, listener: () => void): () => void {
  const key = keyOf(machine, thread, path)
  let entry = entries.get(key)
  // Listening before it's read: it's read now, so there's something to listen to.
  if (!entry) { void fileImage(machine, thread, path).catch(() => {}); entry = entries.get(key) }
  if (!entry) return () => {}
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
  const due = [...entries.values()].filter((entry) => entry.version && entry.url && !entry.checking
    && entry.listeners.size > 0
    && (!which.machine || entry.machine === which.machine) && (!which.thread || entry.thread === which.thread)
    && (!which.path || entry.path === which.path) && (which.force || now() - entry.checkedAt >= RECHECK_AFTER))
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
    const { files } = await rpc<Result<'file.stat'>>(machine, 'file.stat', { thread: thread, paths: group.map((e) => e.path) })
    await Promise.all(group.map((entry, index) => {
      const version = files[index]
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
