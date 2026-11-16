// What both halves agree on: what it is, and the live value of suggestions, by thread.
import type { ExtensionAbout } from '@superego/protocol'

/** What each thread's user might send next: a scoped value by thread (`Suggested`, null for none). */
export const NEXT = 'suggestions.next'

/** What a thread's user might send next, after its last answer. */
export type Suggested = { prompts: string[] }

export const about = { name: 'suggestions', version: '1.1.0', api: '^3', title: 'Prompt suggestions', description: 'After each answer, suggest what you might send next.' } satisfies ExtensionAbout
