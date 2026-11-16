// What unread is. All its work is in the window, so it has a UI half only: the window declares it to each machine.
import type { ExtensionAbout } from '@superego/protocol'

/** What this extension is: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'unread', version: '1.0.0', api: '^2', title: 'Unread', description: 'What agents have for you that you haven\'t seen: a bell with a count, and ⌘. to go to the next.' } satisfies ExtensionAbout
