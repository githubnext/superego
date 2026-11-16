// thread-tools: what it is. Optional: a machine can switch the tools off, and a profile go without them, while the
// sidebar (threads) stays.
import type { ExtensionAbout } from '@superego/protocol'

export const about = {
  name: 'thread-tools', version: '1.1.0', api: '^2', title: 'Thread tools', description: 'Start threads of their own, read, message and archive others, on this machine and those it reaches.',
} satisfies ExtensionAbout
