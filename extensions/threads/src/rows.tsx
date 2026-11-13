// The thread tools in the window: their rows in a transcript, and threads named in Markdown as links,
// [title](thread:<id>). Both are the required UI half's, so a thread whose agent goes without the tools (Ego, with a
// thread_read and a thread_start of its own) still shows them, and a message naming a thread still links to it.
import { ThreadRef, type ToolRowCall, type UiApi } from '@superego/app/ui'
import { ArchiveIcon, ArrowElbowDownRightIcon, ChatCircleIcon, ChatsCircleIcon } from '@superego/ui'

const THREAD = 'thread:'
const n = (k: number, one: string, many: string) => k === 1 ? one : `${k} ${many}`

export function registerRows(superego: UiApi) {
  // A thread the call is about (the one it started, read or messaged) is named as itself. A thread started or messaged
  // is named in the row, so what the call said back would only repeat it.
  const other = ({ call, result }: ToolRowCall) => call.name === 'thread_start'
    ? (result?.details as { id?: string } | undefined)?.id
    : typeof call.arguments.id === 'string' ? call.arguments.id : undefined
  const thread = (c: ToolRowCall) => { const id = other(c); return id ? <ThreadRef machine={c.machine.id} id={id} className="row__thread" /> : undefined }
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

export function registerLinks(superego: UiApi) {
  superego.link({
    match: (href, kind, where) => kind === 'link' && Boolean(where.machine) && href.startsWith(THREAD),
    render: ({ href, children, where }) => <ThreadRef machine={where.machine!} id={href.slice(THREAD.length)}>{children}</ThreadRef>,
    // Shown; or, beside, in a pane beside the thread it's named in.
    open(href, { machine, thread, beside }) {
      const id = href.slice(THREAD.length)
      return beside && thread && thread.id !== id
        ? superego.dispatch('pane.open', { id: thread.id, kind: 'thread', params: { thread: id } }, { machine: machine!, source: 'thread link' }).then(() => {})
        : superego.dispatch('thread.select', { machine: machine!, thread: id }, { source: 'thread link' }).then(() => {})
    },
  })
}
