// What both halves of terminal agree on: what it is, its pane, the channel a pane's bytes go on, and what a terminal says
// of itself.
import type { ExtensionAbout, Status } from '@superego/protocol'

/** The kind of pane: a shell in the thread's folder. Given no params (the thread's terminal) or `{ n }` (another one). */
export const TERMINAL = 'terminal'
/**
 * The channel a pane's terminal speaks on, opened with `{ thread, pane, cols, rows }`: the daemon sends a header line
 * (`<length> <cols> <rows>\n`: how much output it replays, and the size the terminal had), that much of what the
 * terminal printed before, then what it prints from then on, at the size asked for; the window sends keystrokes.
 * Opening it starts the shell if it isn't running.
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

/** A window's reading of a terminal's channel: its header, then what's replayed, then what's live. */
export class Framing {
  #header = ''
  #left = -1
  /** The size the terminal had as it was attached to, once the header is read: what's replayed was printed at it. */
  size: { cols: number; rows: number } | undefined
  /** Whether what's replayed has all come. */
  get live() { return this.#left === 0 }
  /** `bytes` as they came, apart: what's replayed and what's live (either may be empty). */
  split(bytes: Uint8Array): { replayed: Uint8Array; live: Uint8Array } {
    let at = 0
    while (this.#left < 0 && at < bytes.length) {
      const c = bytes[at++]!
      if (c === 0x0a) {
        const [length, cols, rows] = this.#header.split(' ').map(Number)
        this.#left = length || 0
        if (cols && rows) this.size = { cols, rows }
      } else this.#header += String.fromCharCode(c)
    }
    const rest = bytes.subarray(at)
    const back = Math.max(0, Math.min(this.#left, rest.length))
    if (this.#left > 0) this.#left -= back
    return { replayed: rest.subarray(0, back), live: rest.subarray(back) }
  }
}
