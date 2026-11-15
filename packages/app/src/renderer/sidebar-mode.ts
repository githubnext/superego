// The sidebar's two modes, wide: full (the open space's view beside the rail) or folded (no sidebar; the open space
// shows in the rail alone, as its slim form if it has one: Threads' status dots). One state, the window's: whatever
// folds or unfolds it (⌘/, the open space's rail button, the sidebar's edge) changes this, and the space only draws it.
// A tight window (TIGHT) folds it by itself; unfolded there, it stays so until the window is wide again.

/** A window wide enough for the rail, too tight for the sidebar beside the thread: folded unless unfolded there. */
export const TIGHT = '(min-width: 600px) and (max-width: 760px)'

/** `open`: kept across reloads, as the window was left. `unfolded`: opened in a tight window, for as long as it's tight. */
export type SidebarMode = { open: boolean; unfolded: boolean }

/** Whether the sidebar is folded, `tight` or not. */
export const isFolded = ({ open, unfolded }: SidebarMode, tight: boolean) => !open || (tight && !unfolded)

/**
 * Shown in full (`show`) or folded; left out, the other way. Tight, folding only takes back the unfolding there: the
 * window as it was kept comes back once it's wide.
 */
export function showSidebar(mode: SidebarMode, tight: boolean, show = isFolded(mode, tight)): SidebarMode {
  if (!tight) return { open: show, unfolded: false }
  return show ? { open: true, unfolded: true } : { open: mode.open, unfolded: false }
}
