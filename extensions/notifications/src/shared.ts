// What notifications is. All its work is in the window, so it has a UI half only: the window declares it to each machine.
import type { ExtensionAbout } from '@superego/protocol'

/** What this extension is: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'notifications', title: 'Notifications', description: 'A notification when a thread finishes, fails or needs you while the window is in the background.' } satisfies ExtensionAbout
