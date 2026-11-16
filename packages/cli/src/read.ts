// Reading a thread from outside: where it stands and its last answer, waiting while it works if asked. `superego read`
// and the MCP server's `thread_read` both read with it.
import { RpcError, type ThreadInfo } from '@superego/protocol'

/** A daemon method, called by name. */
export type Call = <T>(method: string, params: unknown) => Promise<T>

/** What a thread is, for an agent elsewhere: no panes, no session internals. */
export const brief = (t: ThreadInfo) => ({
  id: t.id, title: t.title, state: t.status.state, ...(t.status.msg ? { status: t.status.msg } : {}), cwd: t.cwd,
  ...(t.parent ? { parent: t.parent } : {}), ...(t.profile ? { profile: t.profile.name } : {}), ...(t.model ? { model: t.model } : {}),
  ...(t.archived ? { archived: true } : {}), activeAt: new Date(t.activeAt).toISOString(),
})

export type Read = { thread: ReturnType<typeof brief>; answer?: string }

type Entry = { model?: unknown[] }
const messageOf = (entry: Entry) => entry.model?.[0] as { role?: string; content?: unknown } | undefined

/** The text of the newest assistant answer among a conversation's entries, oldest first. */
export function lastAnswer(entries: Entry[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    const message = messageOf(entry)
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const said = (message.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim()
    if (said) return said
  }
  return undefined
}

/** Whether the newest message is the user's, with no reply begun: one just sent, before its run starts. */
const unanswered = (entries: Entry[]) => {
  const last = [...entries].reverse().map(messageOf).find((message) => message?.role)
  return last?.role === 'user'
}

/** How long a message just sent may wait for its run to start before `wait` stops waiting for it. */
const STARTING = 10_000
const POLL = 500

/**
 * A thread (listed, archived, or hidden: Ego's) and its last answer. `wait`: once it has stopped working, and has
 * answered a message just sent (unless it doesn't start on it within ten seconds).
 */
export async function readThread(call: Call, id: string, { wait = false, signal, label }: { wait?: boolean; signal?: AbortSignal; label: string }): Promise<Read> {
  const find = async () => {
    for (const which of [{}, { archived: true }, { hidden: true }]) {
      const found = (await call<ThreadInfo[]>('thread.list', which)).find((t) => t.id === id)
      if (found) return found
    }
    return undefined
  }
  const history = async () => (await call<{ entries: Entry[] }>('thread.history', { id, before: Number.MAX_SAFE_INTEGER, limit: 50 })).entries
  let thread = await find()
  if (!thread) throw new RpcError('not_found', `No thread ${id} on ${label}`)
  const since = Date.now()
  let entries: Entry[]
  for (;;) {
    if (!wait || thread.status.state !== 'working') {
      entries = await history()
      // Done, unless a message just sent hasn't started its run yet.
      const settled = thread.status.state === 'blocked' || thread.status.state === 'error' || !unanswered(entries) || Date.now() - since > STARTING
      if (!wait || settled) break
    }
    if (signal?.aborted) throw new Error('Stopped waiting')
    await new Promise((resolve) => setTimeout(resolve, POLL))
    thread = (await find()) ?? thread
  }
  const answer = lastAnswer(entries)
  return { thread: brief(thread), ...(answer ? { answer } : {}) }
}
