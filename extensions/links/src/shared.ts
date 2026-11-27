// What links is. All its work is in the window, so it has a UI half only: the app's daemon lists this `about` among its
// extensions, so the machine knows it (Settings lists it, and a profile can do without it).
import type { ExtensionAbout } from '@superego/protocol'

export const about = { name: 'links', version: '1.0.0', api: '^5', title: 'Links', group: 'thread', description: '⌃O: the links in a thread, newest first, to follow from the keyboard.' } satisfies ExtensionAbout
