// What both halves agree on: the live value of suggestions, by thread.
import type { ExtensionAbout } from '@superego/protocol'

export const NEXT = 'suggestions.next'

/** What a thread's user might send next, after the answer `after` (an entry id). */
export type Suggested = { after: number; prompts: string[] }

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'suggestions', version: '1.0.0', api: '^1.1', title: 'Prompt suggestions', description: 'After each answer, suggest what you might send next.' } satisfies ExtensionAbout
