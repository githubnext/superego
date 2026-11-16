// The sidebar's width, as its edge is dragged (see sidebar-edge.tsx): kept as an app setting, so it's the same in every
// window and after a restart. Dragged past its least, it hides: the open space shows in the rail alone.

/** The app setting the width is kept in, in pixels. */
export const SIDEBAR_WIDTH = 'app.sidebar.width'
/** Its width until it's dragged (`--superego-sidebar` in @superego/ui's styles). */
export const DEFAULT_WIDTH = 232
/** No narrower than this while it shows: dragged further, it holds here and shows it will hide. */
export const MIN_WIDTH = 180
export const MAX_WIDTH = 420
/** Nor wider than this share of the window, while that's at least MIN_WIDTH: what's kept comes back as it widens. */
export const MAX_SHARE = 0.4
/** Let go with its edge short of this and it hides; dragged out from the rail past it, it shows. */
export const HIDE_AT = 140

/** The most it shows in a window `windowWidth` wide (none given: MAX_WIDTH). */
export const widest = (windowWidth = Infinity) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(windowWidth * MAX_SHARE)))

const clamp = (width: number, windowWidth?: number) => Math.min(widest(windowWidth), Math.max(MIN_WIDTH, Math.round(width)))

/**
 * The width as kept: anything but a number (nothing kept yet) is the default; a number out of bounds is brought in. With
 * the window's width, as it shows there.
 */
export const sidebarWidth = (kept: unknown, windowWidth?: number) =>
  clamp(typeof kept === 'number' && Number.isFinite(kept) ? kept : DEFAULT_WIDTH, windowWidth)

/**
 * Its edge dragged to `width` from the sidebar's start, in a window `windowWidth` wide: how wide it shows (never past its
 * bounds), and whether letting go there hides it. Dragged out from the rail, `hides` is it staying hidden.
 */
export function dragSidebar(width: number, windowWidth?: number): { width: number; hides: boolean } {
  return { width: clamp(width, windowWidth), hides: width < HIDE_AT }
}

/**
 * Let go after dragging to `last` (none: it never came out of the rail): hide, keep a width other than the one `kept`
 * (as kept, not as shown: let go at the window's cap, that's kept), or neither.
 */
export function release(last: { width: number; hides: boolean } | undefined, kept: number): 'hide' | number | undefined {
  if (!last) return undefined
  if (last.hides) return 'hide'
  return last.width === kept ? undefined : last.width
}
