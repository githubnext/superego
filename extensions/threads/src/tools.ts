// The thread tools: threads, for the agents in them. Start one of their own (a child, nested under its parent in the
// sidebar), read another (waiting for it, if asked), send one a message, list the threads around, and archive one (or
// their own). A thread is named in a message as a link, [its title](thread:<id>), which the UI half shows as one.
// With `machine`, the same on another machine this daemon reaches (see the daemon's relay.ts): there a thread is named
// in words, since a link names a thread on the reader's machine, and a thread started there isn't anyone's child, since
// its parent isn't in that machine's catalog.
// Plain tools on a host, so Ego's own (`thread_read`, its `thread_start`) are built from the same parts.
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { bool, obj, opt, str, type Json, type MachineEntry, type ThreadInfo } from '@superego/protocol'

type NewChild = { prompt: string; title?: string; cwd?: string; profile?: string; worktree?: boolean }

/** What the tools need of the daemon. Threads are named by id, as strings. */
export type ThreadsHost = {
  /** The thread a conversation is, if it is one. */
  info(id: string): Promise<ThreadInfo | undefined>
  list(): Promise<ThreadInfo[]>
  start(parent: string, params: NewChild): Promise<ThreadInfo>
  send(id: string, text: string): Promise<void>
  /** Its last answer, as text, if it has one. */
  answer(id: string): Promise<string | undefined>
  /** Put it away now, and say what that did: each extension's line (its worktree removed, say), by extension. */
  archive(id: string): Promise<{ notes: Record<string, string> }>
  /** Put it away once its run ends: how a thread archives itself, mid-turn. */
  archiveWhenDone(id: string): Promise<void>
  /** `reader` read `thread` (thread_read), as it stood: so a report of it isn't relayed again (reads.ts). */
  read?(reader: string, thread: ThreadInfo): void
  /** This machine's name, for messages to threads elsewhere. */
  hostname?(): string
  /** The other machines this daemon reaches, and a call to one; absent, the tools stay on this machine. */
  machines?(): MachineEntry[]
  remote?(machine: string, method: string, params: unknown): Promise<unknown>
}

/** The text of the newest assistant answer among `entries` (a conversation's, oldest first). */
export function lastAnswer(entries: { model?: unknown[] }[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const said = (message.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim()
    if (said) return said
  }
  return undefined
}

/** A thread as a link in a message: what the window shows as one, and what the agent is told to write. */
export const linkTo = (thread: Pick<ThreadInfo, 'id' | 'title'>) => `[${thread.title.replace(/[[\]]/g, '')}](thread:${thread.id})`

/** A message from another thread, as thread_send sends it (and thread-reports relays a report): from whom. */
export const fromLine = (thread: Pick<ThreadInfo, 'id' | 'title'>) => `From ${linkTo(thread)}:`
/** The thread a message says it's from (`fromLine`), if it does. */
export const senderOf = (message: string) => /^From \[[^\]]*\]\(thread:([^)\s]+)\):/.exec(message)?.[1]

const text = (value: string) => ({ output: [{ type: 'text' as const, text: value }] })
const LIMIT = 6_000
const clip = (value: string) => value.length > LIMIT ? `${value.slice(0, LIMIT)}\n… (${value.length - LIMIT} more characters)` : value

/** Where a thread stands, in a line: its link, its status, and where it works. */
export const lineOf = (thread: ThreadInfo, name: (thread: ThreadInfo) => string = linkTo) => `${name(thread)}: ${thread.status.state}${thread.status.msg ? ` (${thread.status.msg})` : ''}, in ${thread.cwd}`

/** Where threads are: this machine, or one reached from it. */
type Place = {
  info(id: string): Promise<ThreadInfo | undefined>
  list(): Promise<ThreadInfo[]>
  answer(id: string): Promise<string | undefined>
  send(id: string, text: string): Promise<void>
  /** How a message names one of its threads. */
  name(thread: Pick<ThreadInfo, 'id' | 'title'>): string
  /** The machine's name, for a place elsewhere, and how a thread starts there. */
  away?: string
  start?(params: NewChild): Promise<ThreadInfo>
}

const MACHINE = opt(str({ description: 'Another machine this one reaches, by name or id (thread_machines lists them). Unset: this machine.' }))

/** The place `machine` names: this one when unset (or it names this machine), else one the daemon reaches. */
function placeOf(host: Pick<ThreadsHost, 'info' | 'list' | 'answer' | 'hostname' | 'machines' | 'remote'> & Partial<Pick<ThreadsHost, 'send'>>, machine: string | undefined): Place {
  const local: Place = { info: host.info, list: host.list, answer: host.answer, send: host.send ?? (async () => { throw new Error('Messages are sent with thread_send') }), name: linkTo }
  const wanted = machine?.trim().toLowerCase()
  if (!wanted || wanted === 'local' || wanted === host.hostname?.().toLowerCase()) return local
  const all = host.machines?.() ?? []
  const found = all.find((m) => m.id === machine) ?? all.find((m) => m.label.toLowerCase() === wanted || m.machine?.hostname.toLowerCase() === wanted)
  if (!found || !host.remote) throw new Error(`No machine ${machine} here${all.length ? `: ${all.map((m) => m.label).join(', ')}` : '; this machine reaches no others'}`)
  if (found.state !== 'connected') throw new Error(`${found.label} is ${found.state}${found.error ? ` (${found.error})` : ''}`)
  const call = <T,>(method: string, params: unknown) => host.remote!(found.id, method, params) as Promise<T>
  const list = () => call<ThreadInfo[]>('thread.list', {})
  return {
    away: found.label,
    start: (params) => call<ThreadInfo>('thread.start', params),
    list,
    info: async (id) => (await list()).find((t) => t.id === id),
    async answer(id) {
      const { entries } = await call<{ entries: { model?: unknown[] }[] }>('thread.history', { thread: id, before: Number.MAX_SAFE_INTEGER, limit: 50 })
      return lastAnswer(entries)
    },
    send: async (id, message) => { await call('thread.send', { thread: id, text: message, whenBusy: 'followUp' }) },
    name: (thread) => `"${thread.title}" (thread ${thread.id} on ${found.label})`,
  }
}

/** `thread_read`: where a thread stands, who started it, its threads and its last answer, waiting for it if asked. */
export function readTool(host: Pick<ThreadsHost, 'info' | 'list' | 'answer' | 'read' | 'hostname' | 'machines' | 'remote'>) {
  return defineTool({
    name: 'thread_read',
    description: 'Read another thread: where it stands, its parent and children, and its last answer. wait: true waits until it is ' +
      'no longer working first.',
    parameters: obj({ thread: str(), wait: opt(bool()), machine: MACHINE }),
    async execute({ thread: id, wait, machine }, api, context) {
      const place = placeOf(host, machine)
      if (wait && !place.away && id === String(api.conversationId)) throw new Error('A thread can\'t wait on itself')
      let thread = await place.info(id)
      if (!thread) throw new Error(`No thread ${id}${place.away ? ` on ${place.away}` : ''}`)
      while (wait && thread.status.state === 'working') {
        if (context.abortSignal?.aborted) throw new Error('Stopped waiting')
        await new Promise((resolve) => setTimeout(resolve, place.away ? 1000 : 500))
        thread = (await place.info(id)) ?? thread
      }
      const all = await place.list()
      const parent = thread.parent ? all.find((t) => t.id === thread!.parent) : undefined
      const children = all.filter((t) => t.parent === id)
      const answer = await place.answer(id)
      if (!place.away) host.read?.(String(api.conversationId), thread)
      return text([
        lineOf(thread, place.name),
        parent && `Started by ${place.name(parent)}.`,
        children.length && `Its threads:\n${children.map((c) => `- ${lineOf(c, place.name)}`).join('\n')}`,
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
          'It works on its own; thread_read (wait: true) gets its answer. Defaults to this thread\'s folder. With `machine`, it starts on that ' +
          'machine instead (in the folder given, else that machine\'s default), not nested under this one.',
        parameters: obj({
          prompt: str({ minLength: 1, description: 'Its first message: everything it needs, since it sees nothing of this thread.' }),
          title: opt(str()), cwd: opt(str({ description: 'Its folder, if not this thread\'s (on another machine: a folder there).' })),
          profile: opt(str()), worktree: opt(bool({ description: 'Work in a git worktree of its own.' })),
          machine: MACHINE,
        }),
        async execute({ machine, ...args }, api) {
          const parent = await here(api.conversationId)
          const place = placeOf(host, machine)
          if (place.start) {
            const child = await place.start(args)
            return {
              ...text(`Started ${place.name(child)}. It isn't nested under this thread (threads on other machines aren't); thread_read with machine "${place.away}" and thread ${child.id} reads it.`),
              details: { id: child.id, title: child.title, machine: place.away ?? null } as Json,
            }
          }
          const child = await host.start(parent.id, { ...args, cwd: args.cwd ?? parent.cwd })
          return { ...text(`Started ${linkTo(child)} (id ${child.id}).`), details: { id: child.id, title: child.title } }
        },
      }),
      readTool(host),
      defineTool({
        name: 'thread_send',
        description: 'Send another thread a message, from this one: it goes in when that thread is next free.',
        parameters: obj({ thread: str(), text: str({ minLength: 1 }), machine: MACHINE }),
        async execute({ thread: id, text: message, machine }, api) {
          const from = await here(api.conversationId)
          const place = placeOf(host, machine)
          const to = await place.info(id)
          if (!to) throw new Error(`No thread ${id}${place.away ? ` on ${place.away}` : ''}`)
          // Elsewhere a link would name the wrong thread: this one is named in words, with its machine.
          const signed = place.away ? `From "${from.title}" (thread ${from.id} on ${host.hostname?.() ?? 'another machine'}):` : fromLine(from)
          await place.send(id, `${signed}\n\n${message}`)
          return text(`Sent to ${place.name(to)}.`)
        },
      }),
      defineTool({
        name: 'thread_list',
        description: 'The threads around this one: its parent, its children, and the others in its project. With `machine`, the newest threads there.',
        parameters: obj({ machine: MACHINE }),
        async execute({ machine }, api) {
          const self = await here(api.conversationId)
          const place = placeOf(host, machine)
          const all = await place.list()
          const others = place.away ? all.slice(0, 30) : all.filter((t) => t.project.root === self.project.root && t.id !== self.id)
          const parentOf = (t: ThreadInfo) => all.find((p) => p.id === t.parent)
          return text(others.length ? others.map((t) => `- ${lineOf(t, place.name)}${parentOf(t) ? `, started by ${place.name(parentOf(t)!)}` : ''}`).join('\n') : `No other threads ${place.away ? `on ${place.away}` : 'here'}.`)
        },
      }),
      defineTool({
        name: 'thread_machines',
        description: 'The other machines this one reaches, for the thread tools\' `machine`: name, id, host and whether it is connected.',
        parameters: obj({}),
        async execute() {
          const all = host.machines?.() ?? []
          if (!all.length) return text('This machine reaches no others.')
          return text(all.map((m) => `- ${m.label} (id ${m.id}${m.machine ? `, ${m.machine.hostname}` : ''}): ${m.state}${m.error && m.state !== 'connected' ? `, ${m.error}` : ''}`).join('\n'))
        },
      }),
      defineTool({
        name: 'thread_archive',
        description: 'Archive a thread: out of the thread list, taking no messages until it\'s unarchived. Without a thread, this ' +
          'thread, once this turn ends. Says what archiving did (extensions clean up after it: a worktree removed, say).',
        parameters: obj({ thread: opt(str({ description: "The thread to archive; this one if left out." })) }),
        async execute({ thread: id }, api) {
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
      const others = host.machines?.() ?? []
      return [
        `This thread is ${linkTo(self)}${parent ? `, started by ${linkTo(parent)}` : ''}.`,
        'Name a thread in a message as a link, [its title](thread:<id>): it shows as one, to open.',
        'For separate work that can go on alongside this (another part of a change, a question to look into), start a thread ' +
          'of its own with thread_start, and give it everything it needs; thread_read gets its answer (wait: true waits for it).',
        'thread_archive puts a thread away once it\'s finished with, such as a child of this one whose work is done, or this ' +
          'thread itself when the user asks.',
        others.length ? `The thread tools also work on ${others.map((m) => m.label).join(', ')} (their \`machine\`).` : undefined,
      ].filter(Boolean).join('\n')
    })],
  })
}
