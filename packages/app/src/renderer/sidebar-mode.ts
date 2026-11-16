// The sidebar, wide, is shown (the open space's view beside the rail) or hidden (no sidebar; the open space shows in
// the rail alone, as what it draws there while hidden if anything: Threads' status dots). One state, the window's:
// whatever shows or hides it (⌘/, the open space's rail button, the sidebar's edge) changes this, and the space only
// draws it. A tight window (TIGHT) hides it by itself; shown there, it stays so until the window is wide again.

/** A window wide enough for the rail, too tight for the sidebar beside the thread: hidden unless shown there. */
export const TIGHT = '(min-width: 600px) and (max-width: 760px)'

/** `open`: kept across reloads, as the window was left. `shownTight`: shown in a tight window, for as long as it's tight. */
export type SidebarMode = { open: boolean; shownTight: boolean }

/** Whether the sidebar is hidden, `tight` or not. */
export const sidebarIsHidden = ({ open, shownTight }: SidebarMode, tight: boolean) => !open || (tight && !shownTight)

/**
 * Shown (`show`) or hidden; left out, the other way. Tight, hiding only takes back showing it there: the window as it
 * was kept comes back once it's wide.
 */
export function showSidebar(mode: SidebarMode, tight: boolean, show = sidebarIsHidden(mode, tight)): SidebarMode {
  if (!tight) return { open: show, shownTight: false }
  return show ? { open: true, shownTight: true } : { open: mode.open, shownTight: false }
}
