// The composer's own commands, typed to open a message: `/clear` (or `/new`) starts the thread over, a new one like it
// with what follows the command as its first message, and this one archived; `/compact` summarizes its conversation so
// far, what follows saying what to keep. Completed as they're typed, beside the skills a `/` opening the message also
// names; ⏎ on one runs it (see ComposerBox).
import type { ThreadInfo } from '@superego/protocol'
import type { Completion, CompletionProvider } from './composer.ts'

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

/** Whether `thread` takes the command `name`. */
export const takes = (name: CommandName, thread: ThreadInfo | undefined) => Boolean(thread && COMMANDS.find((c) => c.name === name)!.takes(thread))

/** The commands a thread takes; none for no thread (the New thread dialog). */
export const commandsOf = (thread: ThreadInfo | undefined) => thread ? COMMANDS.filter((c) => c.takes(thread)) : []

/** The command a message is, by any of its names, any case, and what follows it (`/clear fix the tests`), if `thread` takes it. */
export function commandIn(text: string, thread: ThreadInfo | undefined): { command: CommandName; rest: string } | undefined {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const name = match?.[1]!.toLowerCase()
  const command = commandsOf(thread).find((c) => c.name === name || c.aliases.includes(name!))
  return command && { command: command.name, rest: (match![2] ?? '').trim() }
}

/** The commands of `commands` a query names, by the start of a name: an alias only where it's that the query names. */
export function commandsFor(query: string, commands: readonly Command[] = COMMANDS): Completion[] {
  const q = query.toLowerCase()
  return commands.flatMap(({ name, aliases, detail }) => {
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

/** The commands, completed in a thread's composer as that thread takes them; none in the New thread dialog's. */
export const commandCompletions: CompletionProvider = {
  title: 'Commands',
  word: commandAt,
  items: (word, where) => commandsFor(word.query, commandsOf(where.thread)),
}
