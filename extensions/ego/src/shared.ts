// What both halves of ego agree on: what it is, and the actions that open and clear its thread.
import type { ExtensionAbout } from '@superego/protocol'

/** Open Ego's thread (made the first time), with a message if given: its ThreadInfo. */
export const ASK = 'ego.ask'
/** Start Ego's conversation over: the same thread, empty again. */
export const CLEAR = 'ego.clear'

/**
 * What a message to Ego from an outside agent (`superego mcp`) goes with, a block of its own: Ego is told who's asking,
 * the window shows it as a chip, and thread_start finds it in the message it's answering (see daemon.ts).
 */
export const OUTSIDE = '<outside-agent>This message is from an outside agent (an MCP client), not the user.</outside-agent>'
/** The blocks of a sent message that say it came from an outside agent. */
export const outsideBlocks = (blocks: readonly { type: string; text?: string }[]) =>
  blocks.flatMap((block, index) => block.type === 'text' && block.text === OUTSIDE ? [index] : [])

/**
 * Optional: switched off, a machine has no Ego (its thread stays, hidden and taking no messages, until it's back).
 * Its thread says so in its facts: `ext.ego` is true.
 */
export const about = { name: 'ego', version: '2.0.0', api: '^2', title: 'Ego', description: "Superego's own agent: ask it about the app and how it's set up." } satisfies ExtensionAbout
