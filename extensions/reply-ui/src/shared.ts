// What both halves agree on: the tools' names, their details (the whole UI, so the transcript draws it again after a
// reload), and the UI each thread's agent waits on.
import type { Block, Reply } from '@superego/blocks'
import type { ExtensionAbout } from '@superego/protocol'

export const SHOW = 'show_ui'
export const ASK = 'ask_ui'
/** The UI each thread's agent waits on, a scoped value by thread (`Asking[]`). */
export const ASKING = 'reply-ui.asking'
export const ANSWER = 'reply-ui.answer'

/** What the agent drew: a title, its blocks, and (ask_ui) the submit button's label. */
export type Spec = { title?: string; blocks: Block[]; submit?: string }

/** UI an agent waits on. `id` is the tool call's. */
export type Asking = Spec & { id: string; thread: string; at: number }

/** ask_ui's details: the UI while it waits, and the answer once given. */
export type AskDetails = Spec & { id: string; answer?: Reply }

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = {
  name: 'reply-ui', version: '1.0.0', api: '^1.2', title: 'UI in replies',
  description: 'Let the agent reply with buttons, choices, forms, tables and pages of its own, in the transcript.',
} satisfies ExtensionAbout
