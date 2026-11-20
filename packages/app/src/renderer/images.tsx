// Images of a thread's, wherever they show: a message's Markdown, a rendered file, the images an agent showed, the files
// sent with a message, a tool's result. One reaches the window from its machine with `image.read` (over the socket on
// the desktop, the WebSocket in a browser), made there as small as the transcript shows it, then a blob URL, shared by
// all that show it and swapped for a newer one when its file changes (image-cache.ts); the lightbox reads it whole. A web
// image is used as its address, once the user asks for it (`loadWebImages`): until then it shows where it's from, to
// click. Each is read only as it nears the screen, its place kept while it loads when its size is known, shimmers until
// drawn, and says quietly when it can't be. One much taller than wide (a whole page's screenshot) shows its top, fading
// out, for the lightbox to show whole.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { GlobeIcon, ImageBrokenIcon } from '@superego/ui'
import type { ImageRef, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import { has } from './client.ts'
import { cachedImage, onImageChange as onImageChange_, readAlready, recheckImages, type ImageSize } from './image-cache.ts'
export { recheckImages, type ImageSize }
import './images.css'

/**
 * An image as shown: a file of the thread's on its machine (`path`), an image in its transcript (`entry`: the entry's
 * id, its message's index in it and its block's in that), or an address (`url`).
 */
export type ImageItem = {
  /** Where it came from, as it was named: a path or an address. */
  name: string
  path?: string
  entry?: { id: number; message: number; block: number }
  url?: string
  /** Why it can't be read, when that's known before trying (an address that isn't a file or on the web). */
  problem?: string
  mimeType?: string
  /** Its size in pixels, when known, so its place is kept before it loads. */
  width?: number
  height?: number
  caption?: string
  alt?: string
}

const imageFileName = (name: string) => name.replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1) ?? name

/** What an image is called, to someone who can't see it and in a tooltip: its alt text, else its caption, else its name. */
export const describeImage = (image: ImageItem) => image.alt || image.caption || imageFileName(image.name)

/** Why a read failed, as a tooltip says it. */
const why = (error: unknown) => {
  const { kind, message } = (error ?? {}) as { kind?: string; message?: string }
  if (kind === 'not_found') return 'not found'
  return message || 'can’t be read'
}

/** The width over which an image is shown cropped: one this many times taller than wide. */
export const TALL = 3

/**
 * Whether `image` is on the web: an address the window would fetch from wherever it says. What names one is often an
 * agent's (its message, a file it wrote, an image it showed), and an address can carry what the agent read
 * (`https://evil/?d=…`): fetched as it shows, that would go out with no tool call to see. So one isn't fetched until the
 * user asks for it (`loadWebImages`).
 */
export const onWeb = (image: ImageItem) => Boolean(image.url && /^https?:/i.test(image.url))

// The web images the user asked for, by address, for as long as the window is open; and who's told when that changes.
const asked = new Set<string>()
const askedListeners = new Set<() => void>()
const onAsked = (listener: () => void) => { askedListeners.add(listener); return () => { askedListeners.delete(listener) } }

/** Load these web images (the user asked to), wherever they show. */
export function loadWebImages(urls: Iterable<string>) {
  const before = asked.size
  for (const url of urls) asked.add(url)
  if (asked.size !== before) for (const listener of askedListeners) listener()
}

/** Whether `image` waits for the user to load it: one on the web they haven't asked for. */
export const isHeld = (image: ImageItem) => onWeb(image) && !asked.has(image.url!)
/** Whether `image` waits for the user to load it, kept current. */
export const useHeld = (image: ImageItem | undefined) => useSyncExternalStore(onAsked, () => Boolean(image && isHeld(image)))
/** Changes as the user loads web images: for what reads some of its own to read them again. */
export const useWebImagesAsked = () => useSyncExternalStore(onAsked, () => asked.size)

/** The host a web image is from, as the user knows it. */
export const hostOf = (url: string) => URL.parse(url)?.host || url

/** What a web image shows until it's loaded: that it's one, and where it's from. */
function HeldLabel({ url }: { url: string }) {
  return <span className="image-frame__broken"><GlobeIcon size={16} aria-hidden /><span>Load image</span><span className="image-frame__host">{hostOf(url)}</span></span>
}

/**
 * An image shown as it is (an `<img>`'s, a block's): on the web, where it's from until it's clicked to load; then, or
 * any other, itself (`children`).
 */
export function WebImage({ url, alt, children }: { url: string; alt?: string | undefined; children: ReactNode }) {
  const held = useHeld({ name: url, url })
  if (!held) return <>{children}</>
  return (
    <button type="button" className="image-frame image-frame--inline is-held" title={url} aria-label={`Load ${alt || 'image'} from ${hostOf(url)}`}
      onClick={() => loadWebImages([url])}>
      <HeldLabel url={url} />
    </button>
  )
}

/** Where `image` is read from on its machine, when it's there and not on the web. */
const refOf = (image: ImageItem): ImageRef | undefined =>
  image.url ? undefined : image.entry ? { entry: image.entry.id, message: image.entry.message, block: image.entry.block } : image.path ? { path: image.path } : undefined
/** A key for `image`, by where it's read from. */
const keyOf = (image: ImageItem) => image.url ?? (image.entry ? `\u0000${image.entry.id}:${image.entry.message}:${image.entry.block}` : image.path ?? `\u0000${image.problem}`)
/** Whether `machine`'s daemon reads only whole files: one from before `image.read`. */
const filesOnly = (machine: MachineEntry) => !has(machine, 'image-read')

/**
 * Where the window can load `image` from: its address (a web one once the user's asked for it), or `size` of it read
 * from `machine` into a blob URL.
 */
export function imageSourceOf(machine: MachineEntry, thread: string, image: ImageItem, size: ImageSize = 'thumbnail'): Promise<string> {
  if (isHeld(image)) return Promise.reject(new Error('Not loaded: it’s on the web'))
  if (image.url) return Promise.resolve(image.url)
  const ref = refOf(image)
  if (!ref) return Promise.reject(new Error(image.problem ?? 'Nothing to show'))
  return cachedImage(machine.id, thread, ref, size, filesOnly(machine))
}

/** `size` of `image` as read already, if it has been: what the lightbox shows while it reads the whole of it. */
export function imageReadAlready(machine: MachineEntry, thread: string, image: ImageItem, size: ImageSize): string | undefined {
  if (image.url) return isHeld(image) ? undefined : image.url
  const ref = refOf(image)
  return ref && readAlready(machine.id, thread, ref, filesOnly(machine) ? 'whole' : size)
}

/** Hear when `image`'s file changes (read it again with imageSourceOf), once it's been asked for. */
export function onImageChange(machine: MachineEntry, thread: string, image: ImageItem, size: ImageSize, listener: () => void): () => void {
  const ref = refOf(image)
  return ref && 'path' in ref ? onImageChange_(machine.id, thread, ref, size, listener, filesOnly(machine)) : () => {}
}

/** Check a thread's images that show now against their files, once its run ends: agents rewrite files as they work. */
export function useImageRechecks(threads: Record<string, ThreadInfo[] | undefined>) {
  const working = useRef(new Set<string>())
  useEffect(() => {
    const now = new Set<string>()
    for (const [machine, list] of Object.entries(threads)) {
      for (const thread of list ?? []) {
        const key = `${machine}\u0000${thread.id}`
        if (thread.status.state === 'working') now.add(key)
        else if (working.current.has(key)) void recheckImages({ machine, thread: thread.id, force: true })
      }
    }
    working.current = now
  }, [threads])
}

/** `held`: a web image, not loaded until the user asks for it (`loadWebImages`). */
export type LoadedImage = { src?: string; broken: boolean; problem?: string; held?: boolean }

/**
 * `image`'s address once `wanted` (in view, or about to be), or broken (and why) when it can't be read: as a thumbnail,
 * or `whole`. A web image is held until the user asks for it.
 */
export function useImageSource(machine: MachineEntry, thread: string, image: ImageItem | undefined, wanted: boolean, size: ImageSize = 'thumbnail'): LoadedImage {
  const [loaded, setLoaded] = useState<LoadedImage & { for?: string }>({ broken: false })
  const connected = machine.state === 'connected'
  const key = image && `${keyOf(image)}\u0000${size}`
  const held = useHeld(image)
  useEffect(() => {
    if (!image || !wanted || held) return
    if (!image.url && !refOf(image)) return setLoaded({ broken: true, problem: image.problem, for: key })
    if (!connected && !image.url) return
    let alive = true
    const load = () => imageSourceOf(machine, thread, image, size).then(
      (src) => { if (alive) setLoaded({ src, broken: false, for: key }) },
      (error) => { if (alive) setLoaded({ broken: true, problem: why(error), for: key }) },
    )
    void load()
    // A file's: swapped for the newer one when it changes, and checked now, as it comes (back) into view.
    const off = onImageChange(machine, thread, image, size, load)
    if (image.path && !image.url) void recheckImages({ machine: machine.id, thread, path: image.path })
    return () => { alive = false; off() }
  }, [machine.id, connected, thread, key, wanted, held])
  if (held) return { broken: false, held: true }
  return loaded.for === key ? loaded : { broken: false }
}

/**
 * Whether `ref` has come near the screen yet (within a screenful of where what scrolls it is scrolled); once it has, it
 * stays true. `from` is where to look for what scrolls it (past a carousel's own strip, say).
 */
function useNear(ref: RefObject<Element | null>, from?: (element: Element) => Element | null | undefined): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (near || !element) return
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return }
    // Measured against what scrolls it, so the margin reaches past its edges.
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setNear(true) },
      { root: scroller(from?.(element) ?? element.parentElement), rootMargin: '100% 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, near])
  return near
}

/** Check the file at `path` again each time `ref` comes back into view (scrolled to, or shown again). */
function useRecheckInView(ref: RefObject<Element | null>, machine: string, thread: string, path: string | undefined) {
  useEffect(() => {
    const element = ref.current
    if (!element || !path || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void recheckImages({ machine, thread, path })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, machine, thread, path])
}

function scroller(from: Element | null): Element | null {
  for (let element = from; element && element !== document.body; element = element.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) return element
  }
  return null
}

/**
 * An image as a button that opens it (in the lightbox): a shimmer in its place until it's read and drawn, a quiet
 * broken state (`brokenLabel`, why on hover) when it can't be. One on the web says where it's from until it's pressed,
 * which loads it (and, given `onLoadWeb`, what else that says). Its size, when known (`image`'s, else once drawn), is
 * `--image-width` (px) and `--image-ratio` on it, for its place to be kept before it loads; `is-tall` when it's much
 * taller than wide, and with `cropTall`, its top shows, fading out, saying it opens.
 */
export function ImageFrame({ machine, thread, image, onOpen, className = '', imgClassName = '', style, wanted = true, tabIndex, near: nearFrom, srcSet, width, height, brokenLabel = 'Image not found', cropTall = false, onLoadWeb }: {
  machine: MachineEntry
  thread: string
  image: ImageItem
  onOpen(): void
  className?: string
  imgClassName?: string
  style?: CSSProperties
  /** Besides being near the screen: whether to read it yet (a carousel's far slides wait). */
  wanted?: boolean
  tabIndex?: number
  /** Where to look for what scrolls it (useNear). */
  near?: (element: Element) => Element | null | undefined
  /** Other sizes of it, already as the window can load them. */
  srcSet?: string
  width?: number | string
  height?: number | string
  brokenLabel?: string
  /** Show a very tall image's top, fading out (where it's laid out to be cropped). */
  cropTall?: boolean
  /** Pressed while it's held on the web: load it, and whatever else goes with it (a message's other web images). */
  onLoadWeb?(): void
}) {
  const frame = useRef<HTMLButtonElement>(null)
  const near = useNear(frame, nearFrom)
  // Read once it's near the screen (and wanted): until then it waits, still, in its place.
  const asked = near && wanted
  const { src, broken: unread, problem, held } = useImageSource(machine, thread, image, asked)
  useRecheckInView(frame, machine.id, thread, near && !image.url ? image.path : undefined)
  // Which image was drawn (any version of it): a newer version of the same file takes the old one's place without the
  // shimmer between.
  const [drawn, setDrawn] = useState<string>()
  const [failed, setFailed] = useState<string>()
  const [natural, setNatural] = useState<{ width: number; height: number }>()
  const which = keyOf(image)
  const broken = unread || (src !== undefined && failed === src)
  const name = describeImage(image)
  const reason = problem ?? (broken ? 'can’t be shown' : undefined)
  const size = image.width && image.height ? { width: image.width, height: image.height } : natural
  const tall = Boolean(size && size.height / size.width > TALL)
  const sized = size && !broken ? { '--image-width': `${size.width}px`, '--image-ratio': `${size.width} / ${size.height}` } as CSSProperties : undefined
  const cropped = cropTall && tall && !broken
  if (held) {
    return (
      <button ref={frame} type="button" className={`image-frame is-held ${className}`} style={style} title={image.url}
        aria-label={`Load ${name} from ${hostOf(image.url!)}`} tabIndex={tabIndex} onClick={onLoadWeb ?? (() => loadWebImages([image.url!]))}>
        <HeldLabel url={image.url!} />
      </button>
    )
  }
  return (
    <button
      ref={frame}
      type="button"
      className={`image-frame ${className} ${broken ? 'is-broken' : drawn === which && src ? 'is-ready' : 'is-loading'} ${asked ? 'is-asked' : ''} ${sized ? 'has-size' : ''} ${tall ? 'is-tall' : ''}`}
      style={sized ? { ...sized, ...style } : style}
      title={broken ? `${image.name}: ${reason}` : image.caption ?? imageFileName(image.name)}
      aria-label={broken ? `${name}: ${reason}` : `Open ${name}`}
      disabled={broken}
      tabIndex={tabIndex}
      onClick={onOpen}
    >
      {broken ? (
        <span className="image-frame__broken"><ImageBrokenIcon size={16} aria-hidden /><span>{brokenLabel}</span></span>
      ) : src && (
        <img src={src} srcSet={srcSet} width={width} height={height} alt={image.alt ?? image.caption ?? ''} decoding="async" draggable={false}
          className={`image-frame__img ${imgClassName}`} onError={() => setFailed(src)}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            if (naturalWidth && naturalHeight) setNatural({ width: naturalWidth, height: naturalHeight })
            setDrawn(which)
          }} />
      )}
      {cropped && <span className="image-frame__more" aria-hidden><span className="image-frame__open">Open</span></span>}
    </button>
  )
}
