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
