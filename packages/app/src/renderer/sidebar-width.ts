// The sidebar's width, as its edge is dragged (see sidebar-edge.tsx): kept as an app setting, so it's the same in every
// window and after a restart. Dragged past its least, it folds: the open space goes to its slim form in the rail.

/** The app setting the width is kept in, in pixels. */
export const SIDEBAR_WIDTH = 'app.sidebar.width'
/** Its width until it's dragged (`--superego-sidebar` in @superego/ui's styles). */
export const DEFAULT_WIDTH = 232
/** No narrower than this while it shows: dragged further, it holds here and shows it will fold. */
export const MIN_WIDTH = 180
export const MAX_WIDTH = 420
/** Let go with its edge short of this and it folds; dragged out from the rail past it, it unfolds. */
export const FOLD_AT = 140

const clamp = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))

/** The width as kept: anything but a number (nothing kept yet) is the default; a number out of bounds is brought in. */
export const sidebarWidth = (kept: unknown) => typeof kept === 'number' && Number.isFinite(kept) ? clamp(kept) : DEFAULT_WIDTH

/**
 * Its edge dragged to `width` from the sidebar's start: how wide it shows (never past its bounds), and whether letting
 * go there folds it. Dragged out from the rail, `folds` is it staying folded.
 */
export function dragSidebar(width: number): { width: number; folds: boolean } {
  return { width: clamp(width), folds: width < FOLD_AT }
}

/**
 * Let go after dragging to `last` (none: it never came out of the rail): fold, keep a width other than the one `kept`,
 * or neither.
 */
export function release(last: { width: number; folds: boolean } | undefined, kept: number): 'fold' | number | undefined {
  if (!last) return undefined
  if (last.folds) return 'fold'
  return last.width === kept ? undefined : last.width
}
