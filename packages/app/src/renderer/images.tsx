// Images of a thread's, wherever they show: a message's Markdown, a rendered file, the images an agent showed. A file's
// bytes reach the window the way any of the thread's files do: `file.read` on its machine (over the socket on the
// desktop, the WebSocket in a browser), then a blob URL, shared by all that show it (and the lightbox) and swapped for
// a newer one when the file changes (image-cache.ts). A web image is used as its address. Each is read only as it
// nears the screen, shimmers until drawn, and says quietly when it can't be.
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { ImageBrokenIcon } from '@superego/ui'
import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import { fileImage, onImageChange, recheckImages } from './image-cache.ts'
export { onImageChange, recheckImages }
import './images.css'

/** An image as shown: a file of the thread's on its machine (`path`, read with `file.read`), or an address (`url`). */
export type ImageItem = {
  /** Where it came from, as it was named: a path or an address. */
  name: string
  path?: string
  url?: string
  /** Why it can't be read, when that's known before trying (a path outside the thread's folder). */
  problem?: string
  mimeType?: string
  /** Its size in pixels, when known, so its place is kept before it loads. */
  width?: number
  height?: number
  caption?: string
  alt?: string
}

export const imageFileName = (name: string) => name.replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1) ?? name

/** What an image is called, to someone who can't see it and in a tooltip: its alt text, else its caption, else its name. */
export const describeImage = (image: ImageItem) => image.alt || image.caption || imageFileName(image.name)

/** Why a read failed, as a tooltip says it. */
const why = (error: unknown) => {
  const { kind, message } = (error ?? {}) as { kind?: string; message?: string }
  if (kind === 'invalid' && /outside/.test(message ?? '')) return "outside the thread's folder"
  if (kind === 'not_found') return 'not found'
  return message || 'can’t be read'
}

/** Where the window can load `image` from: its address, or its file read from `machine` into a blob URL. */
export function imageSourceOf(machine: string, thread: string, image: ImageItem): Promise<string> {
  if (image.url) return Promise.resolve(image.url)
  if (!image.path) return Promise.reject(new Error(image.problem ?? 'Nothing to show'))
  return fileImage(machine, thread, image.path, image.mimeType)
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

export type LoadedImage = { src?: string; broken: boolean; problem?: string }

/** `image`'s address once `wanted` (in view, or about to be), or broken (and why) when it can't be read. */
export function useImageSource(machine: MachineEntry, thread: string, image: ImageItem | undefined, wanted: boolean): LoadedImage {
  const [loaded, setLoaded] = useState<LoadedImage & { for?: string }>({ broken: false })
  const connected = machine.state === 'connected'
  const key = image && (image.url ?? image.path ?? `\u0000${image.problem}`)
  useEffect(() => {
    if (!image || !wanted) return
    if (!image.url && !image.path) return setLoaded({ broken: true, problem: image.problem, for: key })
    if (!connected && !image.url) return
    let alive = true
    const load = () => imageSourceOf(machine.id, thread, image).then(
      (src) => { if (alive) setLoaded({ src, broken: false, for: key }) },
      (error) => { if (alive) setLoaded({ broken: true, problem: why(error), for: key }) },
    )
    void load()
    // A file's: swapped for the newer one when it changes, and checked now, as it comes (back) into view.
    const off = image.path && !image.url ? onImageChange(machine.id, thread, image.path, load) : undefined
    if (image.path && !image.url) void recheckImages({ machine: machine.id, thread, path: image.path })
    return () => { alive = false; off?.() }
  }, [machine.id, connected, thread, key, wanted])
  return loaded.for === key ? loaded : { broken: false }
}

/**
 * Whether `ref` has come near the screen yet (within a screenful of where what scrolls it is scrolled); once it has, it
 * stays true. `from` is where to look for what scrolls it (past a carousel's own strip, say).
 */
export function useNear(ref: RefObject<Element | null>, from?: (element: Element) => Element | null | undefined): boolean {
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
 * broken state (`brokenLabel`, why on hover) when it can't be.
 */
export function ImageFrame({ machine, thread, image, onOpen, className = '', imgClassName = '', style, wanted = true, tabIndex, near: nearFrom, srcSet, width, height, brokenLabel = 'Image not found' }: {
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
}) {
  const frame = useRef<HTMLButtonElement>(null)
  const near = useNear(frame, nearFrom)
  const { src, broken: unread, problem } = useImageSource(machine, thread, image, near && wanted)
  useRecheckInView(frame, machine.id, thread, near && !image.url ? image.path : undefined)
  // Which image was drawn (any version of it): a newer version of the same file takes the old one's place without the
  // shimmer between.
  const [drawn, setDrawn] = useState<string>()
  const [failed, setFailed] = useState<string>()
  const which = image.url ?? image.path
  const broken = unread || (src !== undefined && failed === src)
  const name = describeImage(image)
  const reason = problem ?? (broken ? 'can’t be shown' : undefined)
  return (
    <button
      ref={frame}
      type="button"
      className={`image-frame ${className} ${broken ? 'is-broken' : drawn === which && src ? 'is-ready' : 'is-loading'}`}
      style={style}
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
          className={`image-frame__img ${imgClassName}`} onLoad={() => setDrawn(which)} onError={() => setFailed(src)} />
      )}
    </button>
  )
}
