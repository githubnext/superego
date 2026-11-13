// An image's bytes reach the window the way any file of a thread's does: `file.read` on its machine, over the socket
// on the desktop or the WebSocket in a browser, then a blob URL. Each is read once per window and shared by the
// thread and the lightbox; a web image is used as its address.
import { useEffect, useState, type RefObject } from 'react'
import { call, type MachineEntry } from '@superego/app/ui'
import type { Shown } from './shared.ts'

const cache = new Map<string, Promise<string>>()

const decode = (base64: string): Uint8Array<ArrayBuffer> => {
  const typed = Uint8Array as unknown as { fromBase64?(s: string): Uint8Array<ArrayBuffer> }
  return typed.fromBase64 ? typed.fromBase64(base64) : Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

/** Where the window can load `image` from. */
export function sourceOf(machine: string, thread: string, image: Shown): Promise<string> {
  if (image.url) return Promise.resolve(image.url)
  if (!image.path) return Promise.reject(new Error('Nothing to show'))
  const key = `${machine}\u0000${thread}\u0000${image.path}`
  let source = cache.get(key)
  if (!source) {
    source = call<{ content: string }>(machine, 'file.read', { id: thread, path: image.path, base64: true })
      .then(({ content }) => URL.createObjectURL(new Blob([decode(content)], { type: image.mimeType ?? '' })))
    // A failed read is tried again next time it's wanted (once the machine is back, say).
    source.catch((error) => {
      console.warn(`images: couldn’t read ${image.path}:`, error instanceof Error ? error.message : error)
      if (cache.get(key) === source) cache.delete(key) })
    cache.set(key, source)
  }
  return source
}

export type Loaded = { src?: string; broken: boolean }

/** `image`'s address once `wanted` (in view, or about to be), or broken when it can't be read. */
export function useSource(machine: MachineEntry, thread: string, image: Shown | undefined, wanted: boolean): Loaded {
  const [loaded, setLoaded] = useState<Loaded & { for?: string }>({ broken: false })
  const connected = machine.state === 'connected'
  const key = image && (image.url ?? image.path)
  useEffect(() => {
    if (!image || !wanted || (!connected && !image.url)) return
    let alive = true
    sourceOf(machine.id, thread, image).then(
      (src) => { if (alive) setLoaded({ src, broken: false, for: key }) },
      () => { if (alive) setLoaded({ broken: true, for: key }) },
    )
    return () => { alive = false }
  }, [machine.id, connected, thread, key, wanted])
  return loaded.for === key ? loaded : { broken: false }
}

/** Whether `ref` has come near the screen yet (within a screenful of where its thread is scrolled); once it has, it stays true. */
export function useNear(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (near || !element) return
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return }
    // Measured against what scrolls the thread, so the margin reaches past its edges (a carousel's own strip doesn't count).
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setNear(true) },
      { root: scroller(element.closest('.images')?.parentElement ?? element.parentElement), rootMargin: '100% 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, near])
  return near
}

function scroller(from: Element | null): Element | null {
  for (let element = from; element && element !== document.body; element = element.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) return element
  }
  return null
}
