// The thread tools: threads, for the agents in them. Start one of their own (a child, nested under its parent in the
// sidebar), read another (waiting for it, if asked), send one a message, list the threads around, and archive one (or
// their own). A thread is named in a message as a link, [its title](thread:<id>), which the UI half shows as one.
// Plain tools on a host, so Ego's own (`thread_read`, its `thread_start`) are built from the same parts.
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { bool, obj, opt, str, type ThreadInfo } from '@superego/protocol'

/** What the tools need of the daemon. Threads are named by id, as strings. */
export type ThreadsHost = {
  /** The thread a conversation is, if it is one. */
  info(id: string): Promise<ThreadInfo | undefined>
  list(): Promise<ThreadInfo[]>
  start(parent: string, params: { prompt: string; title?: string; cwd?: string; profile?: string; worktree?: boolean }): Promise<ThreadInfo>
  send(id: string, text: string): Promise<void>
  /** Its last answer, as text, if it has one. */
  answer(id: string): Promise<string | undefined>
  /** Put it away now, and say what that did: each extension's line (its worktree removed, say), by extension. */
  archive(id: string): Promise<{ notes: Record<string, string> }>
  /** Put it away once its run ends: how a thread archives itself, mid-turn. */
  archiveWhenDone(id: string): Promise<void>
  /** `reader` read `thread` (thread_read), as it stood: so a report of it isn't relayed again (reads.ts). */
  read?(reader: string, thread: ThreadInfo): void
}

/** A thread as a link in a message: what the window shows as one, and what the agent is told to write. */
export const linkTo = (thread: Pick<ThreadInfo, 'id' | 'title'>) => `[${thread.title.replace(/[[\]]/g, '')}](thread:${thread.id})`

const text = (value: string) => ({ output: [{ type: 'text' as const, text: value }] })
const LIMIT = 6_000
const clip = (value: string) => value.length > LIMIT ? `${value.slice(0, LIMIT)}\n… (${value.length - LIMIT} more characters)` : value

/** Where a thread stands, in a line: its link, its status, and where it works. */
export const lineOf = (thread: ThreadInfo) => `${linkTo(thread)}: ${thread.status.state}${thread.status.msg ? ` (${thread.status.msg})` : ''}, in ${thread.cwd}`

/** `thread_read`: where a thread stands, who started it, its threads and its last answer, waiting for it if asked. */
export function readTool(host: Pick<ThreadsHost, 'info' | 'list' | 'answer' | 'read'>) {
  return defineTool({
    name: 'thread_read',
    description: 'Read another thread: where it stands, its parent and children, and its last answer. wait: true waits until it is ' +
      'no longer working first.',
    parameters: obj({ id: str(), wait: opt(bool()) }),
    async execute({ id, wait }, api, context) {
      if (wait && id === String(api.conversationId)) throw new Error('A thread can\'t wait on itself')
      let thread = await host.info(id)
      if (!thread) throw new Error(`No thread ${id}`)
      while (wait && thread.status.state === 'working') {
        if (context.abortSignal?.aborted) throw new Error('Stopped waiting')
        await new Promise((resolve) => setTimeout(resolve, 500))
        thread = (await host.info(id))!
      }
      const all = await host.list()
      const parent = thread.parent ? all.find((t) => t.id === thread!.parent) : undefined
      const children = all.filter((t) => t.parent === id)
      const answer = await host.answer(id)
      host.read?.(String(api.conversationId), thread)
      return text([
        lineOf(thread),
        parent && `Started by ${linkTo(parent)}.`,
        children.length && `Its threads:\n${children.map((c) => `- ${lineOf(c)}`).join('\n')}`,
        answer ? `Its last answer:\n${clip(answer)}` : 'No answer yet.',
      ].filter(Boolean).join('\n\n'))
    },
  })
}

export function threadTools(host: ThreadsHost) {
  const here = async (conversationId: number) => {
    const thread = await host.info(String(conversationId))
    if (!thread) throw new Error('Only a thread can do this')
    return thread
  }

  return defineExtension({
    name: 'thread-tools',
    tools: [
      defineTool({
        name: 'thread_start',
        description: 'Start a thread of its own for separate work, as a child of this one: another agent, with the prompt as its first message. ' +
          'It works on its own; thread_read (wait: true) gets its answer. Defaults to this thread\'s folder.',
        parameters: obj({
          prompt: str({ minLength: 1, description: 'Its first message: everything it needs, since it sees nothing of this thread.' }),
          title: opt(str()), cwd: opt(str({ description: 'Its folder, if not this thread\'s.' })),
          profile: opt(str()), worktree: opt(bool({ description: 'Work in a git worktree of its own.' })),
        }),
        async execute(args, api) {
          const parent = await here(api.conversationId)
          const child = await host.start(parent.id, { ...args, cwd: args.cwd ?? parent.cwd })
          return { ...text(`Started ${linkTo(child)} (id ${child.id}).`), details: { id: child.id, title: child.title } }
        },
      }),
      readTool(host),
      defineTool({
        name: 'thread_send',
        description: 'Send another thread a message, from this one: it goes in when that thread is next free.',
        parameters: obj({ id: str(), text: str({ minLength: 1 }) }),
        async execute({ id, text: message }, api) {
          const from = await here(api.conversationId)
          const to = await host.info(id)
          if (!to) throw new Error(`No thread ${id}`)
          await host.send(id, `From ${linkTo(from)}:\n\n${message}`)
          return text(`Sent to ${linkTo(to)}.`)
        },
      }),
      defineTool({
        name: 'thread_list',
        description: 'The threads around this one: its parent, its children, and the others in its project.',
        parameters: obj({}),
        async execute(_args, api) {
          const self = await here(api.conversationId)
          const all = await host.list()
          const others = all.filter((t) => t.session.root === self.session.root && t.id !== self.id)
          const parentOf = (t: ThreadInfo) => all.find((p) => p.id === t.parent)
          return text(others.length ? others.map((t) => `- ${lineOf(t)}${parentOf(t) ? `, started by ${linkTo(parentOf(t)!)}` : ''}`).join('\n') : 'No other threads here.')
        },
      }),
      defineTool({
        name: 'thread_archive',
        description: 'Archive a thread: out of the thread list, taking no messages until it\'s unarchived. Its worktree is removed ' +
          'if nothing in it is uncommitted; its branch stays. Without an id, this thread, once this turn ends. Says what archiving did.',
        parameters: obj({ id: opt(str({ description: 'The thread to archive; this one if left out.' })) }),
        async execute({ id }, api) {
          const self = await here(api.conversationId)
          const thread = id === undefined || id === self.id ? self : await host.info(id)
          if (!thread) throw new Error(`No thread ${id}`)
          if (thread.archived) throw new Error(`${linkTo(thread)} is already archived`)
          // This turn is still going: the thread is archived as it ends, not under it.
          if (thread === self) {
            await host.archiveWhenDone(self.id)
            return text('This thread will be archived when this turn ends.')
          }
          // Another's turn isn't cut short, nor its worktree taken from under it.
          if (thread.status.state === 'working' || thread.status.state === 'blocked') {
            throw new Error(`${linkTo(thread)} is working: wait for it with thread_read (wait: true), then archive it`)
          }
          const { notes } = await host.archive(thread.id)
          return text([`Archived ${linkTo(thread)}.`, ...Object.values(notes)].join(' '))
        },
      }),
    ],
    sections: [section('threads', async ({ conversationId }) => {
      const self = await host.info(String(conversationId))
      if (!self) return undefined
      const parent = self.parent ? await host.info(self.parent) : undefined
      return [
        `This thread is ${linkTo(self)}${parent ? `, started by ${linkTo(parent)}` : ''}.`,
        'Name a thread in a message as a link, [its title](thread:<id>): it shows as one, to open.',
        'For separate work that can go on alongside this (another part of a change, a question to look into), start a thread ' +
          'of its own with thread_start, and give it everything it needs; thread_read gets its answer (wait: true waits for it).',
        'thread_archive puts a thread away once it\'s finished with, such as a child of this one whose work is done, or this ' +
          'thread itself when the user asks.',
      ].join('\n')
    })],
  })
}
