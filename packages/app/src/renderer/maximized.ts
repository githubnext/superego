// A column maximized, the thread's or a pane's: grown over the thread's other columns for a while, the rail and the
// sidebar left as they are (see panes.tsx). It's this window's alone, never kept or synced, and it ends at the first
// sign it's no longer wanted: Esc, Restore, the pane closing, another opening, another thread shown, another column
// focused, the window going narrow.
import { createStore } from './local-state.ts'

/** The thread's own column, by the key panes.tsx keeps it under (a pane's is its id). */
export const THREAD_COLUMN = 'thread'

export type Maximized = {
  /** The thread's key: `<machine>/<thread>`. */
  thread: string
  /** The column: `THREAD_COLUMN`, or a pane's id. */
  column: string
  /** The thread's panes as it was maximized: one opened since ends it. */
  panes: string[]
}

export const maximizedStore = createStore<Maximized | undefined>('pane.maximized', undefined)

/**
 * The column maximized in `thread` (by key), its panes `panes` now: none once that pane closed, another opened, or
 * another thread is shown.
 */
export function maximizedColumn(maximized: Maximized | undefined, thread: string, panes: string[]): string | undefined {
  if (!maximized || maximized.thread !== thread || !isColumn(maximized.column, panes)) return undefined
  return panes.every((id) => maximized.panes.includes(id)) ? maximized.column : undefined
}

/**
 * Maximize `column` of `thread`, or restore it if it is already. None given: restore whichever is maximized there, else
 * maximize `focused`. A thread without panes has nothing to be maximized over.
 */
export function toggleMaximized(current: Maximized | undefined, thread: string, panes: string[], column: string | undefined, focused: string): Maximized | undefined {
  const now = maximizedColumn(current, thread, panes)
  const target = column ?? (now ? undefined : focused)
  if (!target || target === now || !panes.length || !isColumn(target, panes)) return undefined
  return { thread, column: target, panes }
}

const isColumn = (column: string, panes: string[]) => column === THREAD_COLUMN || panes.includes(column)

/**
 * Whether a key press restores the layout: a bare Esc that nothing else took (an editor's search, a terminal, a menu),
 * pressed in the thread's area (not in a dialog over it).
 */
export function restoresOn(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, inMain: boolean): boolean {
  return event.key === 'Escape' && !event.defaultPrevented && inMain && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
}
