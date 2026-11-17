// The thread tools in the window: their rows in a transcript, and threads named in Markdown as links,
// [title](thread:<id>), or [title](thread:<machine>/<id>) for one on another machine. Both are the required UI half's,
// so a thread whose agent goes without the tools (Ego, with a thread_read and a thread_start of its own) still shows
// them, and a message naming a thread still links to it.
import { ThreadRef, useMachines, type MachineEntry, type ToolRowCall, type UiApi } from '@superego/app/ui'
import { machineNamed } from '@superego/protocol'
import { ArchiveIcon, ArrowElbowDownRightIcon, ChatCircleIcon, ChatsCircleIcon } from '@superego/ui'

const THREAD = 'thread:'
const n = (k: number, one: string, many: string) => k === 1 ? one : `${k} ${many}`

export function registerRows(superego: UiApi) {
  // A thread the call is about (the one it started, read or messaged) is named as itself. A thread started or messaged
  // is named in the row, so what the call said back would only repeat it.
  const other = ({ call, result }: ToolRowCall) => call.name === 'thread_start'
    ? (result?.details as { id?: string } | undefined)?.id
    : typeof call.arguments.thread === 'string' ? call.arguments.thread : undefined
  const thread = (c: ToolRowCall) => { const id = other(c); return id ? <ThreadRef machine={c.machine.id} id={id} className="threads-row-ref" /> : undefined }
  const quiet = (c: ToolRowCall) => other(c) && c.state === 'done' ? null : undefined
  superego.tool('thread_start', {
    icon: ArrowElbowDownRightIcon, verbs: ['Started', 'Starting', 'Couldn’t start a thread'], phrase: (k) => `started ${n(k, 'a thread', 'threads')}`,
    subject: (c) => thread(c) ?? String(c.call.arguments.title ?? 'a thread'), body: quiet,
  })
  superego.tool('thread_read', { icon: ChatCircleIcon, verbs: ['Read', 'Waiting on', 'Couldn’t read'], phrase: (k) => `read ${n(k, 'a thread', 'threads')}`, subject: thread })
  superego.tool('thread_send', { icon: ChatCircleIcon, verbs: ['Messaged', 'Messaging', 'Couldn’t message'], phrase: (k) => `messaged ${n(k, 'a thread', 'threads')}`, subject: thread, body: quiet })
  superego.tool('thread_list', { icon: ChatsCircleIcon, verbs: ['Listed threads', 'Listing threads', 'Couldn’t list threads'], phrase: () => 'listed threads', subject: () => null })
  superego.tool('thread_archive', {
    icon: ArchiveIcon, verbs: ['Archived', 'Archiving', 'Couldn’t archive'], phrase: (k) => `archived ${n(k, 'a thread', 'threads')}`,
    subject: (c) => thread(c) ?? 'this thread', body: quiet,
  })
}

/**
 * Where a `thread:` link goes: `thread:<id>`, a thread on the machine it's named on; `thread:<machine>/<id>`, one on
 * another the window reaches, by its id, name or hostname. A machine the window doesn't know, undefined.
 */
export function linkedThread(href: string, here: string | undefined, machines: readonly MachineEntry[]): { machine: string; id: string } | undefined {
  const rest = href.slice(THREAD.length)
  const slash = rest.lastIndexOf('/')
  if (slash < 0) return here ? { machine: here, id: rest } : undefined
  const machine = machineNamed(machines, rest.slice(0, slash))
  return machine && { machine: machine.id, id: rest.slice(slash + 1) }
}

export function registerLinks(superego: UiApi) {
  superego.link({
    scheme: 'thread',
    match: (href, kind, where) => kind === 'link' && Boolean(where.machine) && href.startsWith(THREAD),
    // Followed as `open` below says, so a click and ⌃O's list agree: beside the thread the link is in.
    render: function ThreadLink({ href, children, where, open }) {
      const to = linkedThread(href, where.machine, useMachines())
      return to ? <ThreadRef machine={to.machine} id={to.id} open={(beside) => void open(beside)}>{children}</ThreadRef> : <span title={`${href}: no such machine here`}>{children}</span>
    },
    // Shown; or, beside, in a pane beside the thread it's named in (one on its machine: a pane shows its own machine's).
    open(href, { machine, thread, beside }) {
      const to = linkedThread(href, machine, superego.window.machines)
      if (!to) return `${href.slice(THREAD.length).split('/')[0]} isn't a machine here`
      return beside && thread && to.machine === machine && thread.id !== to.id
        ? superego.dispatch('pane.open', { thread: thread.id, kind: 'thread', params: { thread: to.id } }, { machine: machine!, source: 'thread link' }).then(() => {})
        : superego.dispatch('thread.select', { machine: to.machine, thread: to.id }, { source: 'thread link' }).then(() => {})
    },
  })
}
