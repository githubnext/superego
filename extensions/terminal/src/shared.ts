// What both halves of terminal agree on: what it is, its pane, the channel a pane's bytes go on, and what a terminal says
// of itself.
import type { ExtensionAbout, Status } from '@superego/protocol'

/** The kind of pane: a shell in the thread's folder. Given no params (the thread's terminal) or `{ n }` (another one). */
export const TERMINAL = 'terminal'
/**
 * The channel a pane's terminal speaks on, opened with `{ thread, pane, cols, rows }`: the daemon sends a header line
 * (the decimal length of the output it replays, then `\n`), that much of what the terminal printed before, then what it
 * prints from then on; the window sends keystrokes. Opening it starts the shell if it isn't running.
 */
export const IO = 'terminal.io'
/** A terminal's size changed in a window: `{ thread, pane, cols, rows }`. The last window to say so wins. */
export const RESIZE = 'terminal.resize'
/** What each thread's terminals report of themselves (OSC 7501), scoped by thread: by pane id. */
export const STATUS = 'terminal.status'
export type TerminalStatus = Status & { app?: string }
export type TerminalStatuses = Record<string, TerminalStatus>

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = {
  name: 'terminal', version: '1.0.0', api: '^1.5', title: 'Terminal',
  description: 'A shell beside a thread (⌃`), run by the machine so it outlives the window.',
} satisfies ExtensionAbout
