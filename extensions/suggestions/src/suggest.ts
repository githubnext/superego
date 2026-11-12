// Asking a model what the user might send next: the end of the conversation in, a few short messages out.

type Message = { role: string; content: string | { type: string; text?: string }[] }

export const SYSTEM = `You suggest what the user might send next to a coding agent.
You get the end of their conversation. Reply with a JSON array of at most 3 messages the user is likely to send next, in their own voice, as they would type them: "Run the tests", "Commit this", "Yes, write the migration".
Lead with the most likely next step. When the agent asked the user something, answer it. Each message under 60 characters.
Reply [] when nothing is likely. Reply with the JSON array only.`

/** The conversation's text as a model reads it: who said what, tool calls left out, at most `limit` characters from the end. */
export function transcriptOf(messages: Message[], limit = 12_000): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = (typeof message.content === 'string' ? message.content : message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')).trim()
    if (text) lines.push(`${message.role === 'user' ? 'User' : 'Agent'}: ${text}`)
  }
  const all = lines.join('\n\n')
  return all.length > limit ? `…${all.slice(-limit)}` : all
}

/** The prompts in a model's reply: its last JSON array of strings (in a code fence, even), else none. */
export function promptsOf(reply: string): string[] {
  for (const [json] of [...reply.matchAll(/\[[^[\]]*\]/g)].reverse()) {
    try {
      const list = JSON.parse(json) as unknown
      if (!Array.isArray(list)) continue
      return [...new Set(list.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter((p) => p && p.length <= 120))].slice(0, 3)
    } catch { /* not JSON: an earlier one may be */ }
  }
  return []
}
