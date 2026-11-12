// Threads, for the agents in them: start one of their own (a child, nested under its parent in the sidebar), read
// another (waiting for it, if asked), send one a message, and list the threads around. A thread is named in a message
// as a link, [its title](thread:<id>), which the window shows as one. With `machine`, the same on another machine this
// daemon reaches (see relay.ts): there a thread is named in words, since a link names a thread on the reader's machine,
// and a thread started there isn't anyone's child, since its parent isn't in that machine's catalog.
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
  /** This machine's name, for messages to threads elsewhere. */
  hostname?(): string
  /** The other machines this daemon reaches, and a call to one; absent, the tools stay on this machine. */
  machines?(): MachineEntry[]
  remote?(machine: string, method: string, params: unknown): Promise<unknown>
}

/** A thread as a link in a message: what the window shows as one, and what the agent is told to write. */
export const linkTo = (thread: Pick<ThreadInfo, 'id' | 'title'>) => `[${thread.title.replace(/[[\]]/g, '')}](thread:${thread.id})`

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

const text = (value: string) => ({ output: [{ type: 'text' as const, text: value }] })
const LIMIT = 6_000
const clip = (value: string) => value.length > LIMIT ? `${value.slice(0, LIMIT)}\n… (${value.length - LIMIT} more characters)` : value

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

export function threadTools(host: ThreadsHost) {
  const here = async (conversationId: number) => {
    const thread = await host.info(String(conversationId))
    if (!thread) throw new Error('Only a thread can do this')
    return thread
  }
  const local: Place = { info: host.info, list: host.list, answer: host.answer, send: host.send, name: linkTo }
  /** The place `machine` names: this one when unset (or it names this machine), else one the daemon reaches. */
  const placeOf = (machine: string | undefined): Place => {
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
      start: (params) => call<ThreadInfo>('thread.create', params),
      list,
      info: async (id) => (await list()).find((t) => t.id === id),
      async answer(id) {
        const { entries } = await call<{ entries: { model?: unknown[] }[] }>('thread.history', { id, before: Number.MAX_SAFE_INTEGER, limit: 50 })
        return lastAnswer(entries)
      },
      send: async (id, message) => { await call('thread.submit', { id, text: message, whenBusy: 'followUp' }) },
      name: (thread) => `"${thread.title}" (thread ${thread.id} on ${found.label})`,
    }
  }
  /** Where a thread stands, in a line: its name, its status, and where it works. */
  const line = (place: Place, thread: ThreadInfo) => `${place.name(thread)}: ${thread.status.state}${thread.status.msg ? ` (${thread.status.msg})` : ''}, in ${thread.cwd}`
  /** How this thread signs a message to a thread elsewhere, where its link would name the wrong one. */
  const signed = (place: Place, from: ThreadInfo) => place.away ? `"${from.title}" (thread ${from.id} on ${host.hostname?.() ?? 'another machine'})` : linkTo(from)

  return defineExtension({
    name: 'threads',
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
          const place = placeOf(machine)
          if (place.start) {
            const child = await place.start(args)
            return {
              ...text(`Started ${place.name(child)}. It isn't nested under this thread (threads on other machines aren't); thread_read with machine "${place.away}" and id ${child.id} reads it.`),
              details: { id: child.id, title: child.title, machine: place.away ?? null } as Json,
            }
          }
          const child = await host.start(parent.id, { ...args, cwd: args.cwd ?? parent.cwd })
          return { ...text(`Started ${linkTo(child)} (id ${child.id}).`), details: { id: child.id, title: child.title } }
        },
      }),
      defineTool({
        name: 'thread_read',
        description: 'Read another thread: where it stands, its parent and children, and its last answer. wait: true waits until it is ' +
          'no longer working first.',
        parameters: obj({ id: str(), wait: opt(bool()), machine: MACHINE }),
        async execute({ id, wait, machine }, api, context) {
          const place = placeOf(machine)
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
          return text([
            line(place, thread),
            parent && `Started by ${place.name(parent)}.`,
            children.length && `Its threads:\n${children.map((c) => `- ${line(place, c)}`).join('\n')}`,
            answer ? `Its last answer:\n${clip(answer)}` : 'No answer yet.',
          ].filter(Boolean).join('\n\n'))
        },
      }),
      defineTool({
        name: 'thread_send',
        description: 'Send another thread a message, from this one: it goes in when that thread is next free.',
        parameters: obj({ id: str(), text: str({ minLength: 1 }), machine: MACHINE }),
        async execute({ id, text: message, machine }, api) {
          const from = await here(api.conversationId)
          const place = placeOf(machine)
          const to = await place.info(id)
          if (!to) throw new Error(`No thread ${id}${place.away ? ` on ${place.away}` : ''}`)
          await place.send(id, `From ${signed(place, from)}:\n\n${message}`)
          return text(`Sent to ${place.name(to)}.`)
        },
      }),
      defineTool({
        name: 'thread_list',
        description: 'The threads around this one: its parent, its children, and the others in its project. With `machine`, the newest threads there.',
        parameters: obj({ machine: MACHINE }),
        async execute({ machine }, api) {
          const self = await here(api.conversationId)
          const place = placeOf(machine)
          const all = await place.list()
          const others = place.away ? all.slice(0, 30) : all.filter((t) => t.session.root === self.session.root && t.id !== self.id)
          const parentOf = (t: ThreadInfo) => all.find((p) => p.id === t.parent)
          return text(others.length ? others.map((t) => `- ${line(place, t)}${parentOf(t) ? `, started by ${place.name(parentOf(t)!)}` : ''}`).join('\n') : `No other threads ${place.away ? `on ${place.away}` : 'here'}.`)
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
          'of its own with thread_start, and give it everything it needs; thread_read with wait: true gets its answer.',
        others.length ? `The thread tools also work on ${others.map((m) => m.label).join(', ')} (their \`machine\`).` : undefined,
      ].filter(Boolean).join('\n')
    })],
  })
}
