// Whether the window is dark: for what draws itself and can't follow the page's light-dark() (a <picture>'s sources,
// CodeMirror's own light and dark styles).
import { useSyncExternalStore } from 'react'

/** Whether the app is dark: its own color-scheme if it sets just one, else the system's. */
export function appDark() {
  const scheme = getComputedStyle(document.documentElement).colorScheme
  const dark = /\bdark\b/.test(scheme), light = /\blight\b/.test(scheme)
  return dark !== light ? dark : matchMedia('(prefers-color-scheme: dark)').matches
}

function watchTheme(changed: () => void) {
  const query = matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', changed)
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  return () => { query.removeEventListener('change', changed); observer.disconnect() }
}

/** Whether the app is dark, followed as it changes. */
export const useAppDark = () => useSyncExternalStore(watchTheme, appDark, () => false)
