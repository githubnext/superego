// What both halves agree on: the tool's name, its details, and the live list of questions waiting for an answer.

export const TOOL = 'ask_user'
export const PENDING = 'ask-user.pending'
export const ANSWER = 'ask-user.answer'

/** A question an agent is waiting on. `id` is the tool call's. */
export type Question = { id: string; session: string; question: string; options: string[]; at: number }

/** The tool call's details: the question while it waits, and the answer once given. */
export type AskDetails = { id: string; question: string; options: string[]; answer?: string }
