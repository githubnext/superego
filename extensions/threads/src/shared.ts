// threads: what it is.
import type { ExtensionAbout } from '@superego/protocol'

/**
 * Required. The sidebar is how the window goes between projects and threads, for every thread on every
 * machine at once, and a thread's rows and links name other threads whatever its agent can do, so neither a machine's
 * switch nor a profile's `without` could mean anything for it.
 */
export const about = {
  name: 'threads', version: '1.0.0', api: '^3', title: 'Threads', description: 'Projects and their threads in the sidebar, sorted, as a list or dots in the rail, with thread details.', required: true,
} satisfies ExtensionAbout
