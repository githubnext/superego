// What links is. All its work is in the window, so it has a UI half only: the window declares it to each machine, which
// then knows it (Settings lists it, and a profile can do without it).
import type { ExtensionAbout } from '@superego/protocol'

/** What this extension is: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'links', version: '1.0.0', api: '^2', title: 'Links', description: '⌃O: the links in a thread, newest first, to follow from the keyboard.' } satisfies ExtensionAbout
