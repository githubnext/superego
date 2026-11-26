// What mermaid is. All its work is in the window, so it has a UI half only: the app's daemon lists this `about` among
// its extensions, so the machine knows it (Settings lists it, and a profile can do without it).
import type { ExtensionAbout } from '@superego/protocol'

export const about = {
  name: 'mermaid', version: '1.0.0', api: '^5.14', title: 'Mermaid',
  description: 'Renders ```mermaid fenced blocks as diagrams in threads and Markdown files.',
} satisfies ExtensionAbout
