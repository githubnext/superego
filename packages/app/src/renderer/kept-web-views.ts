// The window's web views, kept by the pane they belong to (its machine, thread and id), not by the component that shows
// them. A pane's page outlives its being drawn: leaving its thread (or Settings, or anything else that takes the pane
// off the window for a while) hides it, with its page, its scroll, its script's state and its connections as they were;
// drawn again, it's shown as it was. Only the KEPT_WEB_VIEWS most recently shown are kept; the rest are closed, and
// open again on the address they were last at. A view goes as its pane closes or its thread is archived (`prune`).
//
// A view belongs to the window that opened it (this module is the window's own): the same pane in two windows has a
// view in each.
import type { BridgeWebView, WebViewEvent, WebViewPartition } from '../shared/bridge.ts'

/** How many views a window keeps, the ones shown now among them. */
export const KEPT_WEB_VIEWS = 8

/** Whose a view is: a pane of a thread on a machine. */
export type PaneRef = { machine: string; thread: string; pane: string }

/** A page to show, as its pane asks for it now. */
export type WebViewAsk = {
  /** Where the pane points it. Changed, it goes there; the same, it stays where the user took it. */
  src: string
  partition: WebViewPartition
  /** A change to this (a file's version) reloads the page; none yet says nothing. */
  revision?: string | undefined
}

/** A view as a pane holds it while it's drawn: let go of it (`release`) as the pane goes. */
export type HeldWebView = { view: BridgeWebView; ask(ask: WebViewAsk): void; release(): void }

type Kept = PaneRef & {
  key: string
  view: BridgeWebView
  partition: WebViewPartition
  src: string
  revision?: string | undefined
  /** Its last state, told again to the next pane that shows it (its address, history, error). */
  state?: Extract<WebViewEvent, { type: 'state' }>
  listener?: ((event: WebViewEvent) => void) | undefined
  /** Drawn by a pane now. */
  shown: boolean
  /** When it was last shown, in the order shown. */
  shownAt: number
}

/** Of the views kept, those to close (by key): the least recently shown beyond `cap`, never one shown now. */
export function overCap(views: readonly { key: string; shown: boolean; shownAt: number }[], cap = KEPT_WEB_VIEWS): string[] {
  const over = views.length - cap
  if (over <= 0) return []
  return views.filter((v) => !v.shown).sort((a, b) => a.shownAt - b.shownAt).slice(0, over).map((v) => v.key)
}

const keyOf = ({ machine, thread, pane }: PaneRef) => JSON.stringify([machine, thread, pane])

const kept = new Map<string, Kept>()
/** The views closed for room, by key: where each was (`url`), for as long as its pane points where it did (`src`). */
const closed = new Map<string, PaneRef & { src: string; url: string }>()
let clock = 0

/**
 * The view for `pane` (none: one of its own, closed as it's let go), showing `ask`: the pane's kept one, as it was, if
 * there is one; else a new one, at the address it was last at if it was closed for room. `listener` hears what it does,
 * starting with its last state.
 */
export function holdWebView(pane: PaneRef | undefined, ask: WebViewAsk, listener: (event: WebViewEvent) => void): HeldWebView {
  const open = (url: string) => window.superego.webView!({ url, partition: ask.partition })
  const key = pane && keyOf(pane)
  const found = key === undefined ? undefined : kept.get(key)
  // Drawn twice at once (two windows' worth in one, or a pane's two pages): the second goes without.
  if (!pane || key === undefined || found?.shown) {
    const view = open(ask.src)
    view.onEvent(listener)
    return { view, ask: (next) => { if (next.src !== ask.src) view.load(next.src); ask = next }, release: () => view.close() }
  }
  let entry = found
  if (entry && entry.partition !== ask.partition) {
    entry.view.close()
    kept.delete(key)
    entry = undefined
  }
  if (!entry) {
    const was = closed.get(key)
    closed.delete(key)
    const made: Kept = { ...pane, key, view: open(was?.src === ask.src ? was.url : ask.src), partition: ask.partition, src: ask.src, revision: ask.revision, shown: true, shownAt: 0 }
    made.view.onEvent((event) => {
      if (event.type === 'state') made.state = event
      made.listener?.(event)
    })
    kept.set(key, made)
    entry = made
  }
  const held = entry
  held.shown = true
  held.shownAt = ++clock
  held.listener = listener
  if (held.state) listener(held.state)
  const request = (next: WebViewAsk) => {
    if (next.src !== held.src) {
      held.src = next.src
      held.view.load(next.src)
    } else if (next.revision !== undefined && held.revision !== undefined && next.revision !== held.revision) held.view.reload()
    if (next.revision !== undefined) held.revision = next.revision
  }
  request(ask)
  trim()
  return {
    view: held.view,
    ask: request,
    release() {
      held.shown = false
      held.shownAt = ++clock
      held.listener = undefined
      // Out of sight, and without the keyboard (the window has it back, if the page had it).
      held.view.focus(false)
      held.view.place(null, false)
      trim()
    },
  }
}

/** Close the views beyond the cap, keeping where each was. */
function trim() {
  for (const key of overCap([...kept.values()])) {
    const entry = kept.get(key)!
    kept.delete(key)
    entry.view.close()
    const url = entry.state?.state.url
    if (url && !entry.state?.state.error) closed.set(key, { machine: entry.machine, thread: entry.thread, pane: entry.pane, src: entry.src, url })
  }
}

/**
 * Close the views of panes that are gone (closed, their thread archived): `open` says whether a pane still is, or
 * (undefined) that it isn't known yet (its machine's threads aren't).
 */
export function pruneWebViews(open: (pane: PaneRef) => boolean | undefined) {
  for (const [key, entry] of kept) {
    if (entry.shown || open(entry) !== false) continue
    kept.delete(key)
    entry.view.close()
  }
  for (const [key, entry] of closed) if (open(entry) === false) closed.delete(key)
}

/** Close every view kept: the window's page is going (a test's window unmounting; the main process closes them as a real one reloads). */
export function closeWebViews() {
  for (const entry of kept.values()) entry.view.close()
  kept.clear()
  closed.clear()
}
