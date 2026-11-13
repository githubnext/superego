// What both halves of links agree on: what it is. All its work is in the window; the daemon half only declares it,
// so a machine knows it (Settings lists it) and a profile can do without it.
import type { ExtensionAbout } from '@superego/protocol'

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'links', title: 'Links', description: '⌃O: the links in a thread, newest first, to follow from the keyboard.' } satisfies ExtensionAbout
