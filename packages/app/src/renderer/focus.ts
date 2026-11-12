// Focus, after Tremolo: always visible (one ring, see @superego/ui's styles), and in one place the app and the keyboard
// agree on. The window is a row of regions, left to right: the sidebar, the thread, each pane beside it. ⌘⌥← and ⌘⌥→
// move between them, ⌃I goes to the prompt; going to a region focuses what's used there (the selected thread in the
// sidebar, the prompt, an editor's text, a page, else the first control). Focus moving into a pane makes it the thread's
// focused pane; a pane brought forward from the keyboard (⌃Tab, the navigator) takes the focus with it.

/** The regions, left to right, as the window shows them now. */
function regions(): HTMLElement[] {
  const sidebar = document.querySelector<HTMLElement>('.app__sidebar')
  const columns = [...document.querySelectorAll<HTMLElement>('.app__main .panes > [data-column]')]
  const thread = columns.length ? [] : [document.querySelector<HTMLElement>('.app__main .thread')].filter((e): e is HTMLElement => Boolean(e))
  return [...(sidebar ? [sidebar] : []), ...thread, ...columns]
}

/** What to focus in a region: what's used there. */
function target(region: HTMLElement): HTMLElement | null {
  return region.querySelector<HTMLElement>('.superego-list-item.is-selected[tabindex]')
    ?? region.querySelector<HTMLElement>('.composer textarea:not(:disabled)')
    ?? region.querySelector<HTMLElement>('.cm-content')
    ?? region.querySelector<HTMLElement>('.superego-list-item[tabindex]')
    ?? region.querySelector<HTMLElement>('.panes__body iframe')
    ?? region.querySelector<HTMLElement>('.panes__body button, .panes__body input, .panes__body textarea, .panes__body select, .panes__body [tabindex]:not([tabindex="-1"]), .panes__body iframe')
    ?? (region.tabIndex >= 0 || region.hasAttribute('tabindex') ? region : null)
}

export function focusRegion(region: HTMLElement | null | undefined): boolean {
  const el = region && target(region)
  if (!el) return false
  // Focus never scrolls what's read: an editor keeps its place (the browser would bring its caret into view), and
  // the thread its own. A row in a list is scrolled to only if it's out of sight.
  const scrollers = [...new Set([el.closest<HTMLElement>('.file-editor__scroll'), el.closest<HTMLElement>('.thread__scroll')])].filter((s): s is HTMLElement => Boolean(s))
  const kept = scrollers.map((s) => [s, s.scrollTop] as const)
  el.focus({ preventScroll: true })
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

/** ⌃I: the prompt. */
export function focusPrompt() {
  document.querySelector<HTMLElement>('.app__main .composer textarea:not(:disabled)')?.focus()
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
