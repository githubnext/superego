// Threads' transcripts from a run's daemon (pi-durable's entries), what they cost, and a condensed text of them for
// the "where it got lost" pass.
import type { ThreadInfo } from '@superego/protocol'
import type { Rpc } from './rpc.ts'

export type Thread = ThreadInfo

/** Every thread on the machine: listed, archived, and hidden ones (Ego's). */
export async function allThreads(rpc: Rpc): Promise<Thread[]> {
  const [listed, archived, hidden] = await Promise.all([
    rpc.call('thread.list', {}), rpc.call('thread.list', { archived: true }), rpc.call('thread.list', { hidden: true }),
  ])
  return [...listed, ...archived, ...hidden.map((t) => ({ ...t, hidden: true }))]
}

export const spent = (threads: Thread[]) => threads.reduce((sum, t) => sum + (t.cost ?? 0), 0)

export async function entriesOf(rpc: Rpc, id: string): Promise<any[]> {
  const all: any[] = []
  let before = Number.MAX_SAFE_INTEGER
  for (let page = 0; page < 200; page++) {
    const { entries, more } = await rpc.call('thread.history', { thread: id, before, limit: 200 }) as { entries: any[]; more: boolean }
    all.unshift(...entries)
    if (!more || !entries.length) break
    before = entries[0].id
  }
  return all
}

export type Metrics = {
  turns: number; toolCalls: number; failedToolCalls: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  cost: number
}

export function metricsOf(entries: any[]): Metrics {
  const m: Metrics = { turns: 0, toolCalls: 0, failedToolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
  for (const entry of entries) for (const message of entry.model ?? []) {
    if (message.role === 'assistant') {
      m.turns++
      for (const block of message.content ?? []) if (block.type === 'toolCall') m.toolCalls++
      const u = message.usage
      if (u) {
        m.tokens.input += u.input ?? 0; m.tokens.output += u.output ?? 0
        m.tokens.cacheRead += u.cacheRead ?? 0; m.tokens.cacheWrite += u.cacheWrite ?? 0
        m.cost += u.cost?.total ?? 0
      }
    }
    if (message.role === 'toolResult' && message.isError) m.failedToolCalls++
  }
  return m
}

export function addMetrics(a: Metrics, b: Metrics): Metrics {
  return {
    turns: a.turns + b.turns, toolCalls: a.toolCalls + b.toolCalls, failedToolCalls: a.failedToolCalls + b.failedToolCalls, cost: a.cost + b.cost,
    tokens: { input: a.tokens.input + b.tokens.input, output: a.tokens.output + b.tokens.output, cacheRead: a.tokens.cacheRead + b.tokens.cacheRead, cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite },
  }
}
export const noMetrics = (): Metrics => ({ turns: 0, toolCalls: 0, failedToolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 })

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max * 0.7)}\n…[${text.length - max} chars cut]…\n${text.slice(-max * 0.3)}`
const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b: any) => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').join('') : ''

/** A thread as text: messages, tool calls with their arguments, results (cut), errors marked. No system prompt. */
export function condensed(thread: Thread, entries: any[], { result = 1500 } = {}): string {
  const lines = [`### Thread ${thread.id} "${thread.title}"${thread.hidden ? ' (Ego, hidden)' : ''} in ${thread.cwd}${thread.profile ? `, profile ${thread.profile.name}` : ''}`]
  for (const entry of entries) for (const message of entry.model ?? []) {
    if (message.role === 'user') lines.push(`\n[user] ${clip(textOf(message.content), 4000)}`)
    else if (message.role === 'assistant') {
      for (const block of message.content ?? []) {
        if (block.type === 'text' && block.text.trim()) lines.push(`\n[assistant] ${clip(block.text, 3000)}`)
        else if (block.type === 'toolCall') lines.push(`\n[call ${block.name}] ${clip(JSON.stringify(block.arguments), 2500)}`)
      }
      if (message.stopReason === 'error') lines.push(`\n[model error] ${message.errorMessage ?? ''}`)
    } else if (message.role === 'toolResult') lines.push(`[${message.isError ? 'ERROR ' : ''}result ${message.toolName}] ${clip(textOf(message.content), result)}`)
  }
  return lines.join('\n')
}

/** Every tool call in the entries, with its result. */
export function toolCalls(entries: any[]): { id: string; name: string; args: any; result?: string; isError?: boolean }[] {
  const calls = new Map<string, { id: string; name: string; args: any; result?: string; isError?: boolean }>()
  for (const entry of entries) for (const message of entry.model ?? []) {
    if (message.role === 'assistant') for (const b of message.content ?? []) if (b.type === 'toolCall') calls.set(b.id, { id: b.id, name: b.name, args: b.arguments })
    if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId)
      if (call) Object.assign(call, { result: textOf(message.content), isError: Boolean(message.isError) })
    }
  }
  return [...calls.values()]
}
