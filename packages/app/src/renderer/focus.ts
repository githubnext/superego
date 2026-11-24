// Focus, after Tremolo: always visible (the region holding it wears the ring, see app.css), and in one place the app
// and the keyboard agree on. The window is a row of regions, left to right: the sidebar, the thread, each pane beside
// it, the column beside. ⌘⌥← and ⌘⌥→ move between them, ⌃I goes to the prompt (esc leaves it for the thread); going to a region focuses
// what's used there (the selected thread in the sidebar, the thread's transcript, an editor's text, what a pane marks
// `data-focus` (a terminal, a web page's box: Return takes it into the page), else the pane itself). Focus moving into a pane makes it the thread's focused pane; a pane brought forward from the keyboard
// (⌃Tab, the navigator) takes the focus with it. A pane at the back of a stack (see panes.tsx) is a region too: going
// there brings it to the front. Those under a maximized pane aren't, until it's restored (going to one restores it).

import { autoFocusOnOpen } from '@superego/ui'

/** Sent to a pane's column at the back of a stack, as the focus goes there: brought to the front, it can take it. */
export const BRING_FORWARD = 'superego:bring-forward'

/** Typed in: focused, it brings up the on-screen keyboard under a finger. */
const TYPED = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/** The regions, left to right, as the window shows them now. */
function regions(): HTMLElement[] {
  const sidebar = document.querySelector<HTMLElement>('.app__sidebar')
  // Laid out in the thread's order, whatever theirs in the page (see panes.tsx).
  const columns = [...document.querySelectorAll<HTMLElement>('.app__main .panes > [data-column]:not(.is-covered)')]
    .sort((a, b) => (Number(getComputedStyle(a).order) || 0) - (Number(getComputedStyle(b).order) || 0))
  const thread = columns.length ? [] : [document.querySelector<HTMLElement>('.app__main .thread')].filter((e): e is HTMLElement => Boolean(e))
  const beside = [...document.querySelectorAll<HTMLElement>('.app__beside')].filter((e) => getComputedStyle(e).display !== 'none')
  return [...(sidebar ? [sidebar] : []), ...thread, ...columns, ...beside]
}

/**
 * What to focus in a region: what's used there. A thread is its transcript (to read and scroll; typing goes on to the
 * prompt), an editor its text (rendered, the text to read), what a pane marks `data-focus`; any other pane takes the focus itself; a
 * sidebar or a column beside of other views (a data view's), the first thing in it to use, past the views' ··· buttons.
 */
function target(region: HTMLElement): HTMLElement | null {
  return region.querySelector<HTMLElement>('.superego-list-item.is-selected[tabindex]')
    ?? region.querySelector<HTMLElement>('.thread__scroll')
    ?? region.querySelector<HTMLElement>('.file-editor__rendered')
    ?? region.querySelector<HTMLElement>('.cm-content')
    ?? region.querySelector<HTMLElement>('[data-focus]')
    ?? region.querySelector<HTMLElement>('.superego-list-item[tabindex]')
    ?? region.querySelector<HTMLElement>('.panes__body iframe')
    ?? (region.tabIndex >= 0 || region.hasAttribute('tabindex') ? region : null)
    ?? region.querySelector<HTMLElement>(':is(a[href], button, input, select, textarea, [tabindex]):not(:disabled, [tabindex="-1"], .view-menu__button)')
}

/**
 * Focus what's used in a region. Moved there by a command (a key, the navigator), a row it lands on wears its keyboard
 * ring, wherever the key was pressed: the browser's own guess goes by the last input the window saw, and a key pressed
 * in a page, or a click before it, leaves that wrong. Moved there by a click (`visible: false`), it doesn't.
 */
export function focusRegion(region: HTMLElement | null | undefined, { visible = true }: { visible?: boolean } = {}): boolean {
  if (!region) return false
  if (region.inert && region.matches('[data-column]')) region.dispatchEvent(new Event(BRING_FORWARD, { bubbles: true }))
  const found = target(region)
  // Under a finger, a region opened or tapped on (a pane, its tab) doesn't bring up the keyboard for what's typed in
  // there (an editor's text, a blank page's address bar): the region itself takes the focus, if it can; the field is a
  // tap away.
  const el = found?.matches(TYPED) && !autoFocusOnOpen() ? (region.hasAttribute('tabindex') ? region : null) : found
  if (!el) return false
  // Focus never scrolls what's read: an editor keeps its place (the browser would bring its caret into view), and
  // the thread its own. A row in a list is scrolled to only if it's out of sight.
  const scrollers = [...new Set([el.closest<HTMLElement>('.file-editor__scroll'), el.closest<HTMLElement>('.thread__scroll')])].filter((s): s is HTMLElement => Boolean(s))
  const kept = scrollers.map((s) => [s, s.scrollTop] as const)
  el.focus({ preventScroll: true, focusVisible: visible })
  if (el.matches('.superego-list-item')) el.scrollIntoView({ block: 'nearest' })
  const restore = () => { for (const [s, top] of kept) if (s.scrollTop !== top) s.scrollTop = top }
  restore()
  requestAnimationFrame(restore)
  return true
}

/** ⌘⌥← / ⌘⌥→: the region beside the one holding focus (none: the thread's). */
export function focusBeside(by: -1 | 1) {
  const all = regions()
  const at = all.findIndex((r) => r.contains(document.activeElement))
  const from = at < 0 ? all.findIndex((r) => r.matches('.thread, [data-column="thread"]')) : at
  for (let i = from + by; i >= 0 && i < all.length; i += by) if (focusRegion(all[i])) return
}

/** The thread shown: its transcript, from its prompt (esc) or a command. */
export function focusThread() {
  focusRegion(document.querySelector<HTMLElement>('.app__main [data-column="thread"]') ?? document.querySelector<HTMLElement>('.app__main .thread'))
}

/** ⌃I: the prompt; the New thread dialog's, while it's open. */
export function focusPrompt() {
  const prompt = (where: string) => document.querySelector<HTMLElement>(`${where} .composer textarea:not(:disabled)`)
  const shown = prompt('.new-thread') ?? prompt('.app__main')
  shown?.focus()
}

/** A thread's column (a pane's id, or the thread's own), once it's drawn: after a pane was brought forward. */
export function focusColumn(id: string | undefined) {
  let tries = 0
  const attempt = () => {
    const column = document.querySelector<HTMLElement>(`.app__main [data-column="${id ?? 'thread'}"]`)
      ?? (id ? null : document.querySelector<HTMLElement>('.app__main .thread'))
    if (column && focusRegion(column)) return
    if (++tries < 20) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/** The sidebar `id`, once it's drawn: what's used there (its selected row, else its first). */
export function focusSidebar(id: string) {
  let tries = 0
  const attempt = () => {
    if (focusRegion(document.querySelector<HTMLElement>(`.app__sidebar[data-sidebar="${CSS.escape(id)}"]`))) return
    if (++tries < 20) requestAnimationFrame(attempt)
    else console.error(`The ${id} sidebar didn't show to take the focus`)
  }
  requestAnimationFrame(attempt)
}
