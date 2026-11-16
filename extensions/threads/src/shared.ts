// What both halves agree on: the two extensions this package is.
import type { ExtensionAbout } from '@superego/protocol'

/**
 * The UI half: required. The sidebar is how the window goes between projects and threads, for every thread on every
 * machine at once, and a thread's rows and links name other threads whatever its agent can do, so neither a machine's
 * switch nor a profile's `without` could mean anything for it.
 */
export const about = {
  name: 'threads', version: '1.0.0', api: '^2', title: 'Threads', description: 'Projects and their threads in the sidebar, sorted, as a list or dots in the rail, with thread details.', required: true,
} satisfies ExtensionAbout

/** The daemon half: the agent's thread tools, optional. */
export const toolsAbout = {
  name: 'thread-tools', version: '1.1.0', api: '^2', title: 'Thread tools', description: 'Start threads of their own, read, message and archive others, on this machine and those it reaches.',
} satisfies ExtensionAbout

/**
 * Report-back, optional: a thread started by another tells it when a run ends or it waits on a question. Its own
 * extension, so a profile turns it off (`without: ['thread-reports']`: its threads neither report nor are reported to)
 * while keeping the tools, and a thread without the tools still reports.
 */
export const reportsAbout = {
  name: 'thread-reports', version: '1.0.0', api: '^2', title: 'Thread reports', description: 'Tell the thread that started one when it finishes, fails or waits on a question.',
} satisfies ExtensionAbout

/** What clients are told of a child working for its parent (`facts['thread-reports']`): its runs are reported to it. */
export const REPORTED = { toParent: true }
