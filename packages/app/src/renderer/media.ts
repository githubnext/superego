// The window's widths that change how it's laid out, as media queries, and a hook to follow one. Layout is the width
// alone: whether a finger, a mouse or a keyboard is in use is @superego/ui's touch.ts. The stylesheets (app.css,
// images.css) repeat these widths.
import { useSyncExternalStore } from 'react'

/**
 * A window as narrow as a phone's: no rail, the space a drawer, one column at a time (and nothing to maximize). On a
 * phone (this, under a finger) text also reads 15% bigger: app.css.
 */
export const NARROW = '(max-width: 599px)'

/** A window wide enough for the rail, too tight for the sidebar beside the thread: hidden unless shown there (sidebar-mode.ts). */
export const TIGHT = '(min-width: 600px) and (max-width: 760px)'

/** A window too small to hold a dialog or Settings' list down the side: a dialog fills it, the list goes across the top. */
export const COMPACT = '(max-width: 760px)'

/** Whether the window matches a media query, as it's resized. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore((change) => {
    const list = matchMedia(query)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, () => matchMedia(query).matches)
}

/** Whether the window is phone-narrow: no rail, the space a drawer, the narrow layout. */
export const useNarrow = () => useMedia(NARROW)
