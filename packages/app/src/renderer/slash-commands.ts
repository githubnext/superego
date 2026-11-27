// The composer's commands, typed to open a message: its own, `/clear` (or `/new`) starts the thread over, a new one like
// it with what follows the command as its first message, and this one archived; `/compact` summarizes its conversation
// so far, what follows saying what to keep. And extensions' (`superego.composer.command`: `/schedule in 30m …`), run
// by the extension with what follows. Completed as they're typed, beside the skills a `/` opening the message also
// names; ⏎ on one runs it (see ComposerBox).
import type { ThreadInfo } from '@superego/protocol'
import type { Completion, CompletionProvider, ComposerCommand } from './composer.ts'

export type CommandName = 'clear' | 'compact'

/** A command: its name, others it answers to, what it does (beside it in the menu), and the threads it's for. */
type Command = { name: CommandName; aliases: string[]; detail: string; takes(thread: ThreadInfo): boolean }

/** Not one put away: an archived thread takes nothing until it's back. */
const open = (thread: ThreadInfo) => !thread.archived

export const COMMANDS: readonly Command[] = [
  // Only one the sidebar lists: Ego's (hidden) is never archived, and clears itself.
  { name: 'clear', aliases: ['new'], detail: 'Start over in a new thread like this one, and archive this one', takes: (thread) => open(thread) && !thread.hidden },
  { name: 'compact', aliases: [], detail: 'Summarize the conversation so far, to free its context', takes: open },
]

/** The names the composer's own commands answer to: no extension's command may take one. */
export const OWN_NAMES: ReadonlySet<string> = new Set(COMMANDS.flatMap((c) => [c.name, ...c.aliases]))

/** What an extension's command may be called: lowercase letters, digits and `-`, a letter first. */
export const COMMAND_NAME = /^[a-z][a-z0-9-]*$/

/** Whether `thread` takes the command `name`. */
export const takes = (name: CommandName, thread: ThreadInfo | undefined) => Boolean(thread && COMMANDS.find((c) => c.name === name)!.takes(thread))

/** A command either kind: the composer's own, or an extension's. */
type Any = { name: string; aliases?: readonly string[]; detail: string }

/** The commands a thread takes, the composer's own first, then `more` (the extensions' it takes); none for no thread (the New thread dialog). */
export const commandsOf = (thread: ThreadInfo | undefined, more: readonly ComposerCommand[] = []): Any[] => thread ? [...COMMANDS.filter((c) => c.takes(thread)), ...more] : []

/** A message that's a command: one of the composer's own (by its name), or an extension's (to run), and what follows it. */
export type CommandIn = { command: CommandName; rest: string } | { command: ComposerCommand; rest: string }

/**
 * The command a message is, by any of its names, any case, and what follows it (`/clear fix the tests`), if `thread`
 * takes it: the composer's own, or one of `more` (the extensions' it takes).
 */
export function commandIn(text: string, thread: ThreadInfo | undefined, more: readonly ComposerCommand[] = []): CommandIn | undefined {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match || !thread) return undefined
  const name = match[1]!.toLowerCase()
  const rest = (match[2] ?? '').trim()
  const own = COMMANDS.find((c) => c.takes(thread) && (c.name === name || c.aliases.includes(name)))
  if (own) return { command: own.name, rest }
  const theirs = more.find((c) => c.name === name || c.aliases?.includes(name))
  return theirs && { command: theirs, rest }
}

/** The commands of `commands` a query names, by the start of a name: an alias only where it's that the query names. */
export function commandsFor(query: string, commands: readonly Any[] = COMMANDS): Completion[] {
  const q = query.toLowerCase()
  return commands.flatMap(({ name, aliases = [], detail }) => {
    const named = [name, ...aliases].find((n) => n.startsWith(q))
    return named ? [{ label: `/${named}`, detail, insert: `/${named} `, submit: true }] : []
  })
}

/** `/na` opening the message, at the caret: where it starts (0) and the name so far. */
export function commandAt(text: string, caret: number): { start: number; query: string } | undefined {
  if (/^[\w-]/.test(text.slice(caret))) return undefined
  const match = /^\/([\w-]*)$/.exec(text.slice(0, caret))
  return match ? { start: 0, query: match[1]! } : undefined
}

/**
 * The commands, completed in a thread's composer as that thread takes them, the extensions' too (`theirs`: those a thread
 * on a machine takes, `extensionCommands`); none in the New thread dialog's.
 */
export const commandCompletions = (theirs: (machine: string, thread: ThreadInfo | undefined) => readonly ComposerCommand[]): CompletionProvider => ({
  title: 'Commands',
  word: commandAt,
  items: (word, where) => commandsFor(word.query, commandsOf(where.thread, theirs(where.machine.id, where.thread))),
})
