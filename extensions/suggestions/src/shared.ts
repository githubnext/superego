// What both halves agree on: what it is, and the live value of suggestions, by thread.
import type { ExtensionAbout } from '@superego/protocol'

/** What each thread's user might send next: a scoped value by thread (`Suggested`, null for none). */
export const NEXT = 'suggestions.next'

/** A message the user might send next, as they'd type it; `skill`: the skill it runs (it opens with `$name`). */
export type Suggestion = { text: string; skill?: { name: string; description: string } }

/** What a thread's user might send next, after its last answer. */
export type Suggested = { prompts: Suggestion[] }

export const about = { name: 'suggestions', version: '2.0.0', api: '^5.2', title: 'Prompt suggestions', group: 'agent', description: 'After each answer, suggest what you might send next, a skill when one fits.' } satisfies ExtensionAbout
