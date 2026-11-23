// The window's width as a phone's, and a hook to follow a media query. The app's layout widths (its media.ts) start
// from here: the phone's is the one this package draws differently too (a dialog is a sheet from the foot there).
import { useSyncExternalStore } from 'react'

/**
 * A window as narrow as a phone's: the app's narrow layout (no rail, the space a drawer, one column at a time), and a
 * dialog is iOS's sheet, up from the foot, swiped down to close. The stylesheets repeat this width.
 */
export const NARROW = '(max-width: 599px)'

/** Whether the window matches a media query, as it's resized. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore((change) => {
    const list = matchMedia(query)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, () => matchMedia(query).matches)
}

/** Whether the window is phone-narrow. */
export const useNarrow = () => useMedia(NARROW)
