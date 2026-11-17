// A web page in a pane, as a browser tab shows it. On the desktop it's a page of its own laid over the pane
// (main/web-views.ts): top-level, so its cookies are first-party and a page that refuses frames loads. In a browser
// (Web access) there is none: the page is framed, and the pane says what that can't do.
//
// A view over the window draws above everything in it, the window's own menus and dialogs too. So the pane places it,
// following its box as the pane moves, resizes, scrolls or is hidden (behind a stack, under a maximized pane), and
// whenever anything of the window's is over it (a menu, a popover, a tooltip, a dialog: OVERLAYS), or the pane is
// partly out of view (a view can't be cut short), the pane shows a still of the page in its place and hides the view
// until it's clear again. A still is taken just before the view is hidden, and again each second while it's shown.
import { useEffect, useImperativeHandle, useRef, useState, type FocusEvent, type Ref } from 'react'
import type { BridgeWebView, WebViewEvent, WebViewPartition, WebViewRect, WebViewState } from '../shared/bridge.ts'

/**
 * What the window draws over its panes: menus, popovers and tooltips (`.superego-layer`), dialogs, the lightbox, the
 * narrow sidebar's scrim and sheet, the pairing gate. An extension's own overlay is one with `data-superego-overlay`.
 */
export const OVERLAYS = '.superego-layer, .superego-dialog__backdrop, .superego-dialog, .lightbox, .app__scrim, .thread-sheet, .pair-gate, [data-superego-overlay]'

/** What a pane does to its page: go back and forward, reload it, show a file it saved. */
export type WebViewHandle = { go(by: -1 | 1): void; reload(): void; reveal(path: string): void }

/** A page to show: its address, and whose cookies it keeps (`partition`). */
export type WebViewProps = {
  src: string
  /** Its cookies and storage: kept between launches, or only while the app runs. */
  partition: WebViewPartition
  /** The page's accessible name. */
  title: string
  /** Framed (in a browser): what the frame may do, as its `sandbox`. */
  sandbox: string
  /** Where the page is now, and what it did (the desktop's alone). */
  onEvent?(event: WebViewEvent): void
  ref?: Ref<WebViewHandle>
}

/** Whether pages show in views of their own here (the desktop), with their history to go along, or framed (a browser). */
export const hasWebViews = () => Boolean(window.superego?.webView)

/**
 * A web page in a pane, as a browser tab shows it: on the desktop a view of its own over the pane (its own cookies,
 * framing allowed, back and forward), in a browser an iframe. The window's overlays (`OVERLAYS`) stay above it.
 *
 * ```tsx
 * <WebView src="http://localhost:5173" partition="preview" title="Preview" sandbox="allow-scripts allow-forms" />
 * ```
 */
export function WebView(props: WebViewProps) {
  return hasWebViews() ? <NativeWebView {...props} /> : <FramedWebView {...props} />
}

function FramedWebView({ src, title, sandbox, ref }: WebViewProps) {
  const [key, setKey] = useState(0)
  useImperativeHandle(ref, () => ({ go: () => {}, reload: () => setKey((k) => k + 1), reveal: () => {} }), [])
  return (
    <div className="web-view web-view--framed">
      <iframe key={key} src={src} title={title} sandbox={sandbox} />
      <p className="web-view__framed">
        Framed here: a page that refuses frames, or signs in with cookies, may not work. <a href={src} target="_blank" rel="noreferrer">Open in a new tab</a>
      </p>
    </div>
  )
}

type Still = { url: string; width: number }

function NativeWebView({ src, partition, onEvent, ref }: WebViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<BridgeWebView>(undefined)
  const placer = useRef<Placer>(undefined)
  const [still, setStill] = useState<Still>()
  const [error, setError] = useState<WebViewState['error']>()
  const listener = useRef(onEvent)
  listener.current = onEvent
  /**
   * Set while the page takes the focus the view already has, or the window takes the keyboard back (a click on it, from
   * another app or the view): the view isn't given it then.
   */
  const following = useRef(false)
  const opened = useRef(src)

  useEffect(() => {
    const el = host.current!
    const made = window.superego.webView!({ url: opened.current, partition })
    view.current = made
    made.onEvent((event) => {
      if (event.type === 'state') {
        setError(event.state.error)
        placer.current?.block(Boolean(event.state.error))
      }
      // A click into the page: the pane takes the focus as well, as it would for a frame in it. The window's page doesn't
      // have the keyboard then (the view does), so it doesn't hear its own focus move: it's told, as a frame's would.
      if (event.type === 'focus' && document.activeElement !== el) {
        following.current = true
        el.focus({ preventScroll: true })
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        following.current = false
      }
      listener.current?.(event)
    })
    // The window coming back to the front: its page hears focus come to what had it, the pane, but the keyboard stays
    // where the click went.
    const regained = (event: Event) => {
      if (event.target !== window) return
      following.current = true
      setTimeout(() => { following.current = false })
    }
    window.addEventListener('focus', regained, true)
    const placing = placeView(el, made, setStill)
    placer.current = placing
    return () => {
      window.removeEventListener('focus', regained, true)
      placing.stop()
      made.close()
      view.current = undefined
    }
  }, [partition])
  useEffect(() => {
    if (src === opened.current) return
    opened.current = src
    view.current?.load(src)
  }, [src])
  useImperativeHandle(ref, () => ({ go: (by) => view.current?.go(by), reload: () => view.current?.reload(), reveal: (path) => view.current?.reveal(path) }), [])

  // The keyboard goes into the page as the pane is focused (a key, a click on its tab), and back to the window as the
  // focus moves on to something else in it. The window losing the focus (to the page itself, or another app) isn't that.
  const focus = () => { if (!following.current) view.current?.focus(true) }
  const blur = (event: FocusEvent) => { if (event.relatedTarget) view.current?.focus(false) }
  return (
    <div ref={host} className="web-view" tabIndex={-1} data-focus onFocus={focus} onBlur={blur}>
      {still && !error && <img className="web-view__still" src={still.url} style={{ width: still.width }} alt="" draggable={false} />}
      {error && <div className="pane-empty web-view__error">{error.url ? <code>{error.url}</code> : null} didn't load: {error.description}</div>}
    </div>
  )
}

type Placer = { stop(): void; block(blocked: boolean): void }

/** How a view is shown: not at all (its pane is hidden), itself, or as a still while it can't be. */
type Mode = 'none' | 'live' | 'still'

/**
 * Keep `view` over `host`: placed at its box, shown while nothing is over it and it's whole in view, else as a still
 * (`setStill`) in its place. Checked each frame while anything moves (a resize, a scroll, the window's page changing,
 * an animation), until it's been still a while.
 */
function placeView(host: HTMLElement, view: BridgeWebView, setStill: (still: Still | undefined) => void): Placer {
  let mode: Mode = 'none'
  let placed = ''
  let blocked = false
  let frame = 0
  let quiet = 0
  let stopped = false
  let shownStill: Still | undefined
  let capture = 0

  const swapStill = (next: Still | undefined) => {
    if (shownStill) URL.revokeObjectURL(shownStill.url)
    shownStill = next
    setStill(next)
  }
  /** A still of the page, shown in its place; then, if it's still to be one, the view hidden. */
  async function freeze(rect: WebViewRect, tries = 10) {
    const asked = ++capture
    let next: Still | undefined
    try {
      const bytes = await view.snapshot()
      if (bytes) {
        const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
        const image = new Image()
        image.src = url
        await image.decode()
        next = { url, width: image.naturalWidth / devicePixelRatio }
      }
    } catch (error) { console.error('A still of the page:', error) }
    if (stopped || asked !== capture || mode !== 'still') { if (next) URL.revokeObjectURL(next.url); return }
    // Nothing drawn yet (it's only just been placed): again in a moment.
    if (!next && tries > 1) { setTimeout(() => { if (asked === capture) void freeze(rect, tries - 1) }, 100); return }
    if (next) swapStill(next)
    // Drawn before the view goes, so nothing blinks.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!stopped && mode === 'still') view.place(rect, false) }))
  }

  let lastRect: WebViewRect | null = null
  function check(): boolean {
    const at = blocked ? null : placeOf(host)
    const rect = at?.rect ?? null
    const next: Mode = !at ? 'none' : at.whole && !covered(host, at.rect) && !document.documentElement.classList.contains('is-resizing-columns') ? 'live' : 'still'
    const key = `${JSON.stringify(rect)} ${devicePixelRatio}`
    if (key === placed && next === mode) return false
    const was = mode
    placed = key
    mode = next
    if (rect) lastRect = rect
    if (next === 'live') {
      view.place(rect, true)
      if (was !== 'live') { capture++; swapStill(undefined) }
    } else if (next === 'none') {
      view.place(null, false)
      capture++
      swapStill(undefined)
    } else {
      // Over, it keeps its place (and its size, for the still); hidden once the still is shown.
      if (was === 'live') void freeze(rect!)
      else if (was === 'none') { view.place(rect, false); void freeze(rect!) }
      else view.place(rect, false)
    }
    return true
  }

  /** Check each frame until nothing's changed for half a second. */
  const wake = () => {
    quiet = 0
    if (!frame && !stopped) frame = requestAnimationFrame(tick)
  }
  const tick = () => {
    frame = 0
    if (stopped) return
    quiet = check() ? 0 : quiet + 1
    if (quiet < 30) frame = requestAnimationFrame(tick)
  }
  const resize = new ResizeObserver(wake)
  resize.observe(host)
  const mutations = new MutationObserver(wake)
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'inert', 'hidden', 'open', 'data-open', 'data-closed'] })
  const events = ['scroll', 'resize', 'transitionrun', 'animationstart', 'visibilitychange'] as const
  for (const name of events) window.addEventListener(name, wake, true)
  // A still is the page as it was: kept up to date while it's shown.
  const refresh = setInterval(() => { if (mode === 'still' && lastRect) void freeze(lastRect) }, 1000)
  wake()

  return {
    stop() {
      stopped = true
      cancelAnimationFrame(frame)
      clearInterval(refresh)
      resize.disconnect()
      mutations.disconnect()
      for (const name of events) window.removeEventListener(name, wake, true)
      swapStill(undefined)
    },
    block(next) {
      if (blocked === next) return
      blocked = next
      wake()
    },
  }
}

/**
 * Where `host` is in the window, and whether all of it is in view; null when it's not shown at all: hidden (behind a
 * stack, under a maximized pane, closed), or scrolled out of view.
 */
export function placeOf(host: HTMLElement): { rect: WebViewRect; whole: boolean } | null {
  if (host.closest('[inert]') || !host.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return null
  const box = host.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return null
  let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  for (let el = host.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const r = el.getBoundingClientRect()
    clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) }
  }
  if (clip.right - Math.max(clip.left, box.left) < 1 || clip.bottom - Math.max(clip.top, box.top) < 1 || Math.min(clip.right, box.right) <= clip.left || Math.min(clip.bottom, box.bottom) <= clip.top) return null
  const whole = box.left >= clip.left - 0.5 && box.top >= clip.top - 0.5 && box.right <= clip.right + 0.5 && box.bottom <= clip.bottom + 0.5
  return { rect: { x: box.left, y: box.top, width: box.width, height: box.height }, whole }
}

/** Whether anything the window draws over its panes is over `rect` (one the pane itself is in, a dialog's, isn't). */
export function covered(host: HTMLElement, rect: WebViewRect): boolean {
  for (const el of document.querySelectorAll<HTMLElement>(OVERLAYS)) {
    if (el.contains(host)) continue
    const r = el.getBoundingClientRect()
    if (r.right <= rect.x || r.left >= rect.x + rect.width || r.bottom <= rect.y || r.top >= rect.y + rect.height || !r.width || !r.height) continue
    if (el.checkVisibility({ visibilityProperty: true })) return true
  }
  return false
}
