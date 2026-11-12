// What both halves agree on: the live value of suggestions, by thread.

export const NEXT = 'suggestions.next'

/** What a thread's user might send next, after the answer `after` (an entry id). */
export type Suggested = { after: number; prompts: string[] }
