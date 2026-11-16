// What unread is, and its setting. All its work is in the window, so it has a UI half only: the app's daemon lists this
// `about` among its extensions.
import type { ExtensionAbout } from '@superego/protocol'

export const about = { name: 'unread', version: '1.0.0', api: '^2', title: 'Unread', description: 'What agents have for you that you haven\'t seen: a bell with a count, and ⌘. to go to the next.' } satisfies ExtensionAbout

/** App setting: where ⌘. looks for the next unread thread (`Scope`). */
export const SCOPE = 'unread.scope'

/** Whether ⌘. looks for the next unread thread in every project, or only in the one you're in. */
export type Scope = 'all' | 'project'
