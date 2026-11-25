// What focus is, and where it keeps what it knows. All its work is in the window, so it has a UI half only: the app's
// daemon lists this `about` among its extensions.
import type { ExtensionAbout } from '@superego/protocol'

export const about = {
  name: 'focus', version: '1.0.0', api: '^5.13', title: 'Focus',
  description: 'A few threads to focus on: focus mode (⌘⇧F) narrows the sidebar to them and to what needs you.',
} satisfies ExtensionAbout

/** App setting: the threads in focus (`Focused[]`), first focused first. Yours, like pins: the same in every window. */
export const FOCUSED = 'focus.threads'
/** App setting: whether focus mode is on. */
export const ON = 'focus.on'
/** App setting: when focus mode turns itself off (ms since the epoch), for "Focus for 1 hour"; 0, it stays on. */
export const UNTIL = 'focus.until'

/** The mode, on and off (⌘⇧F); for an hour; and the thread shown (or named) in and out of focus (⌘⌥F). */
// (`focus.thread` and the like are the core's: the keyboard's focus.)
export const MODE = 'focus.mode'
export const HOUR = 'focus.mode.hour'
export const THREAD = 'focus.thread.toggle'

/** A thread in focus: its machine and id. */
export type Focused = { machine: string; thread: string }
