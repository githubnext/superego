// What both halves agree on: the tools' names, the pane kind, the live values (what each thread's agent waits on, and
// its panes' UI), the answer action, and the shapes they carry.
import type { Block, ExtensionAbout, Reply } from '@superego/protocol'

/** A question in words, with options to pick from. */
export const ASK_USER = 'ask_user'
/** Blocks in the transcript, pressed later as a message. */
export const SHOW = 'show_ui'
/** Blocks above the composer, waiting for an answer. */
export const ASK = 'ask_ui'
/** Blocks in a pane beside the thread, and redrawn there. */
export const OPEN = 'open_ui'
export const UPDATE = 'update_ui'
export const KIND = 'ui'
/** The prompt section with the blocks guide, which the tools' descriptions point to. */
export const GUIDE_SECTION = 'ui_blocks'

/** What each thread's agent waits on, oldest first: a scoped value by thread (`Waiting[]`). */
export const WAITING = 'agent-ui.waiting'
/**
 * Each thread's panes' UI, a scoped value by thread (`ThreadPanes`), published from the thread's state: null until
 * read from the thread (as a pane first watches it), or for a thread with none; then what the agent last drew in each
 * of its panes.
 */
export const PANES = 'agent-ui.panes'
/** Answer what an agent waits on, by its id: words (`text`), or for blocks, their values and the button pressed. */
export const ANSWER = 'agent-ui.answer'

/** An answer offered to a question: what picking it answers, and a line about it where the label needs one. */
export type Option = { label: string; description?: string }

/** What the agent drew: a title, its blocks, and (ask_ui) the submit button's label. */
export type Spec = { title?: string; blocks: Block[]; submit?: string }

/** ask_user's: the question (Markdown, the question itself its last paragraph) and its options. */
export type Question = { question: string; options: Option[] }

/** Something an agent waits on: a question (ask_user) or blocks (ask_ui). `id` is the tool call's. */
export type Waiting = { id: string; thread: string; at: number } & (({ tool: typeof ASK_USER } & Question) | ({ tool: typeof ASK } & Spec))

/** ask_user's details: the question while it waits, and the answer once given. */
export type QuestionDetails = Question & { id: string; answer?: string }

/** ask_ui's details: the UI while it waits, and the answer once given. */
export type AskDetails = Spec & { id: string; answer?: Reply }

/** A pane's UI, as the agent last drew it. Its pane is opened with params `{ id }`. */
export type PaneSpec = { id: string; title: string; blocks: Block[]; at: number }

/** A thread's panes' UI, by the agent's id for each. */
export type ThreadPanes = Record<string, PaneSpec>

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = {
  name: 'agent-ui', version: '1.0.0', api: '^5', title: 'Agent UI',
  description: 'Let the agent ask you things, and show you UI of its own: in answers, above the message box, and in panes.',
} satisfies ExtensionAbout
