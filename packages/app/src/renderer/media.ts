// The window's widths that change how it's laid out, as media queries, and a hook to follow one. Layout is the width
// alone: whether a finger, a mouse or a keyboard is in use is @superego/ui's touch.ts. The stylesheets (app.css,
// images.css) repeat these widths.
import { NARROW, useMedia, useNarrow } from '@superego/ui'

/**
 * NARROW, a window as narrow as a phone's (@superego/ui's, where a dialog becomes a sheet at that width): no rail, the
 * space a drawer, one column at a time (and nothing to maximize). On a phone (this, under a finger) text also reads 15%
 * bigger: app.css. `useMedia` follows a query as the window's resized; `useNarrow`, this one.
 */
export { NARROW, useMedia, useNarrow }

/** A window wide enough for the rail, too tight for the sidebar beside the thread: hidden unless shown there (sidebar-mode.ts). */
export const TIGHT = '(min-width: 600px) and (max-width: 760px)'

/** A window too small to hold a dialog or Settings' list down the side: a dialog fills it, the list goes across the top. */
export const COMPACT = '(max-width: 760px)'
