// What both halves agree on: the tool's name, its details, and the live list of questions waiting for an answer.

export const TOOL = 'ask_user'
export const PENDING = 'ask-user.pending'
export const ANSWER = 'ask-user.answer'

/** An answer offered: what picking it answers, and a line about it where the label needs one. */
export type Option = { label: string; description?: string }

/** A question an agent is waiting on. `id` is the tool call's. */
export type Question = { id: string; thread: string; question: string; options: Option[]; at: number }

/** The tool call's details: the question while it waits, and the answer once given. */
export type AskDetails = { id: string; question: string; options: Option[]; answer?: string }
