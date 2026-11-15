// A pane maximized: grown over the thread and the thread's other panes for a while, the rail and the sidebar left as
// they are (see panes.tsx). It's this window's alone, never kept or synced, and it ends at the first sign it's no
// longer wanted: Esc, Restore, the pane closing, another opening, another thread shown, the window going narrow.
import { createStore } from './local-state.ts'

/** A window as narrow as a phone's: no rail, the space a drawer, one column at a time (and nothing to maximize). */
export const NARROW = '(max-width: 599px)'

export type Maximized = {
  /** The thread's key: `<machine>/<thread>`. */
  thread: string
  pane: string
  /** The thread's panes as it was maximized: one opened since ends it. */
  panes: string[]
}

export const maximizedStore = createStore<Maximized | undefined>('pane.maximized', undefined)

/** The pane maximized in `thread` (by key), its panes `panes` now: none once it closed, another opened, or another thread. */
export function maximizedPane(maximized: Maximized | undefined, thread: string, panes: string[]): string | undefined {
  if (!maximized || maximized.thread !== thread || !panes.includes(maximized.pane)) return undefined
  return panes.every((id) => maximized.panes.includes(id)) ? maximized.pane : undefined
}

/**
 * Maximize `pane` of `thread`, or restore it if it is already. No pane given: restore whichever is maximized there, else
 * maximize `focused` (none, or the thread's own column: nothing to maximize).
 */
export function toggleMaximized(current: Maximized | undefined, thread: string, panes: string[], pane: string | undefined, focused: string | undefined): Maximized | undefined {
  const now = maximizedPane(current, thread, panes)
  const target = pane ?? (now ? undefined : focused)
  if (!target || target === now || !panes.includes(target)) return undefined
  return { thread, pane: target, panes }
}

/**
 * Whether a key press restores the layout: a bare Esc that nothing else took (an editor's search, a terminal, a menu),
 * pressed in the thread's area (not in a dialog over it).
 */
export function restoresOn(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, inMain: boolean): boolean {
  return event.key === 'Escape' && !event.defaultPrevented && inMain && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
}
