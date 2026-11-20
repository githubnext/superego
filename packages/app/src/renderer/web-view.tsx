// A web page in a pane, as a browser tab shows it. On the desktop it's a page of its own laid over the pane
// (main/web-views.ts): top-level, so its cookies are first-party and a page that refuses frames loads. In a browser
// (Web access) there is none: the page is framed, and the pane says what that can't do.
//
// A view over the window draws above everything in it, the window's own menus and dialogs too. So the pane places it,
// following its box as the pane moves, resizes, scrolls or is hidden (behind a stack, under a maximized pane), and
// whenever anything of the window's is over it (a menu, a popover, a tooltip, a dialog: OVERLAYS), or the pane is
// partly out of view (a view can't be cut short), the pane shows a still of the page in its place and hides the view
// until it's clear again. A still is taken just before the view is hidden, and again each second while it's shown.
//
// A pane's page is kept for the pane, not for the component drawing it (kept-web-views.ts): leaving its thread hides
// it, as it was, and coming back shows it again; it only goes somewhere else when the pane points it there (`src`).
//
// The pane takes the focus as other panes do (⌃Tab, a click on its tab or bar), and keeps it: Return passes it into the
// page, as a click into the page does. The window's shortcuts (⌃Tab, ⌘W) still work from inside it, and take it out.
import { createContext, useContext, useEffect, useImperativeHandle, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent, type Ref } from 'react'
import type { BridgeWebView, WebViewEvent, WebViewPartition, WebViewRect, WebViewState } from '../shared/bridge.ts'
import { holdWebView, type HeldWebView, type PaneRef, type WebViewAsk } from './kept-web-views.ts'

/**
 * What the window draws over its panes: menus, popovers and tooltips (`.superego-layer`), dialogs, the lightbox, the
 * narrow sidebar's scrim and sheet, the pairing gate. An extension's own overlay is one with `data-superego-overlay`.
 */
export const OVERLAYS = '.superego-layer, .superego-dialog__backdrop, .superego-dialog, .lightbox, .app__scrim, .thread-sheet, .pair-gate, [data-superego-overlay]'

/**
 * What a pane does to its page: take it somewhere (where it is already: again), go back and forward, reload it, stop
 * its loading, give it the keyboard, show a file it saved, answer what it asks (its state's `ask`).
 */
export type WebViewHandle = {
  load(url: string): void; go(by: -1 | 1): void; reload(): void; stop(): void; focus(): void; reveal(path: string): void; answer(allow: boolean): void
  /**
   * Run `fn` in the page, given its window and `args` (JSON), and what it returns (awaited; structured data). Its source
   * alone goes there (a `function` or an arrow, not a method), so it may use nothing from outside it. On the desktop it
   * runs in a world of the app's own beside the page's: the page's DOM, not its scripts' globals. Framed, in the frame's
   * page itself, and only when that's of this window's origin: else it rejects.
   */
  run<A extends unknown[], R>(fn: (window: Window, ...args: A) => R, ...args: A): Promise<Awaited<R>>
  /** A part of the page as it's drawn now (`rect`, in its CSS pixels), as a PNG; none framed, or when nothing's drawn there. */
  capture(rect: { x: number; y: number; width: number; height: number }): Promise<Blob | undefined>
}

/** Where `run` can't reach: a framed page of another origin. */
const UNREACHABLE = "The page is another site's: the window can't reach into it"

/** `fn` called with the page's window and `args`, as a script's source. */
export const scriptOf = (fn: (...args: never[]) => unknown, args: unknown[]) => `(${fn.toString()})(window, ...${JSON.stringify(args)})`

/** A page to show: its address, and whose cookies it keeps (`partition`). */
export type WebViewProps = {
  src: string
  /** Its cookies and storage: kept between launches, or only while the app runs. */
  partition: WebViewPartition
  /** A version of what it shows (a file's): when it changes, the page reloads. None (yet) says nothing. */
  revision?: string | undefined
  /** The page's accessible name. */
  title: string
  /** Framed (in a browser): what the frame may do, as its `sandbox`. */
  sandbox: string
  /**
   * Where the page is now, and what it did. Framed, only whether it's loading (its `state`, at `src`): a frame's page
   * doesn't say where it went, nor anything else.
   */
  onEvent?(event: WebViewEvent): void
  /** Whether the pane has the keyboard and its page doesn't, as that changes: Return passes it in (a hint can say so). */
  onWaiting?(waiting: boolean): void
  /**
   * The page is laid out at its box's own size (a Browser pane's page at a set width), in the window's CSS pixels,
   * whatever the window's zoom; a CSS transform on the box (scaled to fit) draws it smaller, as it does the box.
   */
  sized?: boolean
  ref?: Ref<WebViewHandle>
}

/**
 * The pane a WebView is drawn in (set by the window for each pane): on the desktop its page is kept for that pane, not
 * for the component, so the pane drawn again (its thread shown again, Settings closed) shows it as it was.
 */
export const WebViewPane = createContext<PaneRef | undefined>(undefined)

/** Whether pages show in views of their own here (the desktop), with their history to go along, or framed (a browser). */
export const hasWebViews = () => Boolean(window.superego?.webView)

/**
 * A web page in a pane, as a browser tab shows it: on the desktop a view of its own over the pane (its own cookies,
 * framing allowed, back and forward), in a browser an iframe. The window's overlays (`OVERLAYS`) stay above it.
 *
 * ```tsx
 * <WebView src="http://localhost:5173" partition="browser" title="Browser" sandbox="allow-scripts allow-forms" />
 * ```
 */
export function WebView(props: WebViewProps) {
  return hasWebViews() ? <NativeWebView {...props} /> : <FramedWebView {...props} />
}

/** Return, pressed on the pane's own box (not a link or button in it): `enter` passes the keyboard into the page. */
const onReturn = (enter: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.target !== event.currentTarget || event.key !== 'Enter' || event.nativeEvent.isComposing) return
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  event.preventDefault()
  enter()
}

/** Tell `onWaiting` whether the pane is waiting for Return, as that changes. */
function useWaiting(waiting: boolean, onWaiting: WebViewProps['onWaiting']) {
  const listener = useRef(onWaiting)
  listener.current = onWaiting
  useEffect(() => { listener.current?.(waiting) }, [waiting])
  useEffect(() => () => listener.current?.(false), [])
}

function FramedWebView({ src, partition, title, sandbox, revision, onEvent, onWaiting, ref }: WebViewProps) {
  const [key, setKey] = useState(0)
  // What it shows changed: loaded again.
  const shown = useRef(revision)
  useEffect(() => {
    if (revision === undefined || shown.current === revision) return
    if (shown.current !== undefined) setKey((k) => k + 1)
    shown.current = revision
  }, [revision])
  const frame = useRef<HTMLIFrameElement>(null)
  // The box itself has the focus (the page has it once the frame does).
  const [held, setHeld] = useState(false)
  useWaiting(held, onWaiting)
  // Loading from when it's put there until its frame says it loaded.
  const listener = useRef(onEvent)
  listener.current = onEvent
  const loading = (loading: boolean) => listener.current?.({ type: 'state', state: { url: src, title: '', loading, canGoBack: false, canGoForward: false } })
  useEffect(() => { loading(true) }, [src, key])
  // A framed page's own moves aren't seen: going somewhere is going to `src`, as the pane points it there. Nor can its
  // loading be stopped, its document being another origin's: the pane stops waiting for it.
  useImperativeHandle(ref, () => ({
    load: () => setKey((k) => k + 1), go: () => {}, reload: () => setKey((k) => k + 1), stop: () => loading(false), focus: () => frame.current?.focus(), reveal: () => {}, answer: () => {},
    // A framed page of this origin is reached directly; another's (or one sandboxed to no origin) throws on its document.
    run: async (fn, ...args) => {
      const page = frame.current?.contentWindow
      try { if (!page?.document) throw new Error(UNREACHABLE) } catch { throw new Error(UNREACHABLE) }
      return await fn(page as Window & typeof globalThis, ...args) as never
    },
    capture: async () => undefined,
  }), [src])
  return (
    <div className="web-view web-view--framed" tabIndex={-1} data-focus onKeyDown={onReturn(() => frame.current?.focus())}
      onFocus={(event) => setHeld(event.target === event.currentTarget)} onBlur={(event) => { if (event.target === event.currentTarget) setHeld(false) }}>
      <iframe ref={frame} key={key} src={src} title={title} sandbox={sandbox} onLoad={() => loading(false)} />
      {partition === 'browser' && (
        <p className="web-view__framed">
          Framed here, where many sites refuse to show or to sign in. <a href={src} target="_blank" rel="noreferrer">Open in a new tab</a>
        </p>
      )}
    </div>
  )
}

type Still = { url: string; width: number }

function NativeWebView({ src, partition, revision, onEvent, onWaiting, sized = false, ref }: WebViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const held = useRef<HeldWebView>(undefined)
  const view = () => held.current?.view
  const placer = useRef<Placer>(undefined)
  const [still, setStill] = useState<Still>()
  const [error, setError] = useState<WebViewState['error']>()
  const listener = useRef(onEvent)
  listener.current = onEvent
  // The box has the window's focus (the pane's), and the page has the keyboard: the pane waits for Return while it has
  // the one and not the other.
  const [hasFocus, setHasFocus] = useState(false)
  const [inPage, setInPage] = useState(false)
  useWaiting(hasFocus && !inPage, onWaiting)
  // The pane it's in: its page is kept for it (kept-web-views.ts), so drawing it anew shows the page as it was.
  const pane = useContext(WebViewPane)
  const paneKey = pane && JSON.stringify([pane.machine, pane.thread, pane.pane])
  const ask: WebViewAsk = { src, partition, revision }
  const asked = useRef(ask)
  asked.current = ask
  const sizedRef = useRef(sized)
  sizedRef.current = sized

  useEffect(() => {
    const el = host.current!
    // Kept, it tells its last state at once: whether it failed is kept for the placer, made once there's a view to place.
    let failed = false
    const holding = holdWebView(pane, asked.current, (event) => {
      if (event.type === 'state') {
        failed = Boolean(event.state.error)
        setError(event.state.error)
        placer.current?.block(failed)
      }
      // The page has the keyboard (Return, a click into it). Clicked, the pane takes the focus as well, as it would for a
      // frame in it. The window's page doesn't have the keyboard then (the view does), so it doesn't hear its own focus
      // move: it's told, as a frame's would.
      if (event.type === 'focus') {
        setInPage(true)
        if (document.activeElement !== el) {
          el.focus({ preventScroll: true })
          el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        }
      }
      listener.current?.(event)
    })
    held.current = holding
    // The window's page has the keyboard again (a click on it, a shortcut from the page): the page hasn't.
    const regained = (event: Event) => { if (event.target === window) setInPage(false) }
    window.addEventListener('focus', regained, true)
    const placing = placeView(el, holding.view, setStill, () => sizedRef.current)
    placing.block(failed)
    placer.current = placing
    return () => {
      window.removeEventListener('focus', regained, true)
      placing.stop()
      placer.current = undefined
      holding.release()
      held.current = undefined
    }
    // The pane by its key: a new object for the same pane is the same pane.
  }, [paneKey, partition])
  useEffect(() => { held.current?.ask(asked.current) }, [src, revision])
  useImperativeHandle(ref, () => ({
    load: (url) => view()?.load(url), go: (by) => view()?.go(by), reload: () => view()?.reload(), stop: () => view()?.stop(), focus: () => enterRef.current(),
    reveal: (path) => view()?.reveal(path), answer: (allow) => view()?.answer(allow),
    run: async (fn, ...args) => {
      const page = view()
      if (!page) throw new Error('The page is gone')
      return await page.run(scriptOf(fn, args)) as never
    },
    capture: async (rect) => {
      const bytes = await view()?.capture(rect)
      return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }) : undefined
    },
  }), [])

  // Return gives the page the keyboard; the focus moving on to something else in the window takes it back. The window
  // losing the focus (to the page itself, or another app) isn't that.
  const enter = () => {
    host.current?.focus({ preventScroll: true })
    setInPage(true)
    view()?.focus(true)
  }
  const enterRef = useRef(enter)
  enterRef.current = enter
  const blur = (event: ReactFocusEvent) => {
    setHasFocus(false)
    if (!event.relatedTarget) return
    setInPage(false)
    view()?.focus(false)
  }
  return (
    <div ref={host} className="web-view" tabIndex={-1} data-focus onFocus={() => setHasFocus(true)} onBlur={blur} onKeyDown={onReturn(enter)}>
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
function placeView(host: HTMLElement, view: BridgeWebView, setStill: (still: Still | undefined) => void, sized: () => boolean): Placer {
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
        next = { url, width: image.naturalWidth / devicePixelRatio * (rect.layout ? rect.layout.width / rect.width : 1) }
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
    const at = blocked ? null : placeOf(host, sized())
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
export function placeOf(host: HTMLElement, sized = false): { rect: WebViewRect; whole: boolean } | null {
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
  return { rect: { x: box.left, y: box.top, width: box.width, height: box.height, ...(sized ? { layout: { width: host.offsetWidth, height: host.offsetHeight } } : {}) }, whole }
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
