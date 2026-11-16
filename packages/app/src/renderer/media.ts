// The window's widths that change how it's laid out, as media queries, and a hook to follow one.
import { useSyncExternalStore } from 'react'

/** A window as narrow as a phone's: no rail, the space a drawer, one column at a time (and nothing to maximize). */
export const NARROW = '(max-width: 599px)'

/** A window wide enough for the rail, too tight for the sidebar beside the thread: hidden unless shown there (sidebar-mode.ts). */
export const TIGHT = '(min-width: 600px) and (max-width: 760px)'

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
