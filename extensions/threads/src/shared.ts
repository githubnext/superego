// What both halves agree on: the two extensions this package is.
import type { ExtensionAbout } from '@superego/protocol'

/**
 * The UI half: required. The sidebar is how the window goes between sessions and threads, for every thread on every
 * machine at once, and a thread's rows and links name other threads whatever its agent can do, so neither a machine's
 * switch nor a profile's `without` could mean anything for it.
 */
export const about = {
  name: 'threads', title: 'Sidebar', description: 'Sessions and their threads, sorted, as a list or a rail, with thread details.', required: true,
} satisfies ExtensionAbout

/**
 * The daemon half: the agent's thread tools, optional. A profile's `without: ['threads']`, from when the switch had the
 * sidebar's name, still means these (the daemon's `RENAMED`).
 */
export const toolsAbout = {
  name: 'thread-tools', title: 'Thread tools', description: 'Start threads of their own, read, message and archive others.',
} satisfies ExtensionAbout

/**
 * Report-back, optional: a thread started by another tells it when a run ends or it waits on a question. Its own
 * extension, so a profile turns it off (`without: ['thread-reports']`: its threads neither report nor are reported to)
 * while keeping the tools, and a thread without the tools still reports.
 */
export const reportsAbout = {
  name: 'thread-reports', title: 'Thread reports', description: 'Tell the thread that started one when it finishes, fails or waits on a question.',
} satisfies ExtensionAbout
