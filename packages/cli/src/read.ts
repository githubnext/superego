// Reading a thread from outside: where it stands and its last answer (the daemon's `thread.read`), waiting while it
// works if asked. `superego read` and the MCP server's `thread_read` both read with it.
import { offers, RpcError, type Hello, type ThreadInfo } from '@superego/protocol'

/** A daemon method, called by name. */
export type Call = <T>(method: string, params: unknown) => Promise<T>

/** What a thread is, for an agent elsewhere: no panes, nothing of the window. */
export const brief = (t: ThreadInfo) => ({
  id: t.id, title: t.title, state: t.status.state, ...(t.status.kind ? { kind: t.status.kind } : {}), ...(t.status.msg ? { status: t.status.msg } : {}), cwd: t.cwd,
  ...(t.parent ? { parent: t.parent } : {}), ...(t.profile ? { profile: t.profile.name } : {}), ...(t.model ? { model: t.model } : {}),
  ...(t.archived ? { archived: true } : {}), activeAt: new Date(t.activeAt).toISOString(),
})

export type Read = { thread: ReturnType<typeof brief>; answer?: string }

/**
 * A thread (listed, archived, or hidden: Ego's) and its last answer, on the machine `hello` is from. `wait`: once it
 * has stopped working, and has answered a message just sent. `signal` stops waiting here; the daemon's wait ends with
 * the connection.
 */
export async function readThread(call: Call, hello: Hello, id: string, { wait = false, signal, label }: { wait?: boolean; signal?: AbortSignal; label: string }): Promise<Read> {
  if (!offers(hello, 'thread-read')) throw new RpcError('unsupported', `${label} runs a Superego that can't read threads from outside yet: update it`)
  const reading = call<{ thread: ThreadInfo; answer: string | null }>('thread.read', { thread: id, wait })
  const { thread, answer } = await (signal ? Promise.race([reading, aborted(signal)]) : reading)
  return { thread: brief(thread), ...(answer ? { answer } : {}) }
}

const aborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  const stop = () => reject(new Error('Stopped waiting'))
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })
})
