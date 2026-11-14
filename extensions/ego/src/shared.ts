// What both halves of ego agree on: what it is, the actions that open and clear its thread, and the value that follows it.
import type { ExtensionAbout } from '@superego/protocol'

/** Open Ego's thread (made the first time), with a message if given: its ThreadInfo. */
export const ASK = 'ego.ask'
/** Start Ego's conversation over: the same thread, empty again. */
export const CLEAR = 'ego.clear'
/** Ego's thread on this machine, as a live value for older windows: null until it's first opened (see daemon.ts). */
export const THREAD = 'ego.thread'

/**
 * Optional: switched off, a machine has no Ego (its thread stays, hidden and taking no messages, until it's back).
 * Its thread says so in its facts: `ext.ego` is true.
 */
export const about = { name: 'ego', version: '1.0.0', api: '^1', title: 'Ego', description: "Superego's own agent: ask it about the app and how it's set up." } satisfies ExtensionAbout
