// The composer's own commands, typed to open a message: `/clear` (or `/new`) starts the thread over, a new one like it
// with what follows the command as its first message, and this one archived. Completed as they're typed, beside the
// skills a `/` opening the message also names; ⏎ on one runs it (see ComposerBox).
import type { ThreadInfo } from '@superego/protocol'
import type { Completion, CompletionProvider } from './composer.ts'

/** A command: its name, others it answers to, and what it does, beside it in the menu. */
type Command = { name: string; aliases: string[]; detail: string }

export const COMMANDS: readonly Command[] = [
  { name: 'clear', aliases: ['new'], detail: 'Start over in a new thread like this one, and archive this one' },
]

/** Whether a thread takes commands: one the sidebar lists, still open (not Ego's, which clears itself; not archived). */
export const takesCommands = (thread: ThreadInfo | undefined) => Boolean(thread && !thread.hidden && !thread.archived)

/** The command a message is, by any of its names, any case, and what follows it: `/clear fix the tests`. */
export function commandIn(text: string): { command: string; rest: string } | undefined {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const name = match?.[1]!.toLowerCase()
  const command = COMMANDS.find((c) => c.name === name || c.aliases.includes(name!))
  return command && { command: command.name, rest: (match![2] ?? '').trim() }
}

/** The commands a query names, by the start of a name: the alias only where it's that the query names. */
export function commandsFor(query: string): Completion[] {
  const q = query.toLowerCase()
  return COMMANDS.flatMap(({ name, aliases, detail }) => {
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

/** The commands, completed in a thread's composer that takes them; none in the New thread dialog's. */
export const commandCompletions: CompletionProvider = {
  title: 'Commands',
  word: commandAt,
  items: (word, where) => takesCommands(where.thread) ? commandsFor(word.query) : [],
}
