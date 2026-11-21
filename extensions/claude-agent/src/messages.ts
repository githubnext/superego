// Claude Code's messages as a thread's transcript has them: its model messages (Messages API blocks) become pi-ai's
// assistant and tool-result messages, its tools named as Superego's own where they're the same (Read, Bash, Edit,
// Write), so the transcript draws their rows as it does for any thread. Its streaming events build the answer as it
// comes in.
import type { JsonValue } from '@earendil-works/chord/json'
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import { SERVER } from './shared.ts'

/** The provider and API a Claude Agent thread's messages name. */
export const PROVIDER = 'claude-agent'

/** Claude Code's tools that are Superego's own, by its name: ours, and how its arguments are called in ours. */
const OURS: Record<string, { name: string; path?: string }> = {
  Read: { name: 'read', path: 'file_path' },
  Bash: { name: 'bash' },
  Edit: { name: 'edit', path: 'file_path' },
  Write: { name: 'write', path: 'file_path' },
}

/** Superego's own tools, as Claude Code calls them (on its MCP server): by their own names in the transcript. */
const MCP = `mcp__${SERVER}__`

/**
 * A tool call as the transcript has it: Superego's name and argument names where the tool is one of ours, so its row
 * is drawn as a Superego thread's (a Read, ask_user's question, show_images' images).
 */
export function toolCall(name: string, input: ToolCall['arguments']): Pick<ToolCall, 'name' | 'arguments'> {
  if (name.startsWith(MCP)) return { name: name.slice(MCP.length), arguments: input }
  const ours = OURS[name]
  if (!ours) return { name, arguments: input }
  const args = { ...input }
  if (ours.path && ours.path in args) {
    args.path = args[ours.path]!
    delete args[ours.path]
  }
  return { name: ours.name, arguments: args }
}

/** A Messages API content block, as much of it as a transcript shows. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown }

type Content = AssistantMessage['content']

/** Claude Code's blocks as pi-ai's assistant content: text, thinking and tool calls; other blocks aren't shown. */
export function contentOf(blocks: readonly Block[]): Content {
  const out: Content = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') out.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking' && typeof block.thinking === 'string') out.push({ type: 'thinking', thinking: block.thinking })
    else if (block.type === 'redacted_thinking') out.push({ type: 'thinking', thinking: '', redacted: true })
    else if (block.type === 'tool_use') {
      const use = block as { id: string; name: string; input: unknown }
      const input = use.input && typeof use.input === 'object' ? use.input as ToolCall['arguments'] : {}
      out.push({ type: 'toolCall', id: use.id, ...toolCall(use.name, input) })
    }
  }
  return out
}

/** Messages API usage, as far as Claude Code reports it. */
export type Usage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

/** An assistant message of Claude Code's. Its cost isn't known per message (a plan isn't billed per token): 0. */
export function assistantMessage(content: Content, model: string, usage: Usage = {}, timestamp = Date.now()): AssistantMessage {
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return {
    role: 'assistant', content, api: PROVIDER as AssistantMessage['api'], provider: PROVIDER, model,
    usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp,
  }
}

/** A `tool_result` block's text (images aren't kept yet). */
export function resultText(block: { content?: unknown }) {
  const parts = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : Array.isArray(block.content) ? block.content as { type: string; text?: string }[] : []
  return parts.flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

/**
 * A `tool_result` block of Claude Code's, for the call `name` it answers: its text, and what the call reported for
 * the transcript to draw it with (`details`: a Superego tool's own, a subagent's steps).
 */
export function toolResultMessage(block: { tool_use_id: string; content?: unknown; is_error?: boolean | null }, name: string, details?: JsonValue, timestamp = Date.now()): ToolResultMessage {
  return {
    role: 'toolResult', toolCallId: block.tool_use_id, toolName: toolCall(name, {}).name, content: [{ type: 'text', text: resultText(block) }],
    ...(details !== undefined ? { details } : {}), isError: Boolean(block.is_error), timestamp,
  }
}

/** A Messages API streaming event, as much of it as the answer coming in needs. */
export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'content_block_start'; index: number; content_block: Block }
  | { type: 'content_block_delta'; index: number; delta: { type: string; text?: string; thinking?: string } }
  | { type: string }

/**
 * The answer as it streams in, from Claude Code's streaming events: its text and thinking, and the tools it's calling.
 * `take()`: what changed since it was last taken, if anything.
 */
export function partialAnswer() {
  let blocks: Block[] = []
  let changed = false
  return {
    see(event: StreamEvent) {
      if (event.type === 'message_start') blocks = []
      else if (event.type === 'content_block_start' && 'content_block' in event) blocks[event.index] = { ...event.content_block }
      else if (event.type === 'content_block_delta' && 'delta' in event) {
        const block = blocks[event.index]
        if (block?.type === 'text' && event.delta.type === 'text_delta') block.text = `${block.text as string}${event.delta.text ?? ''}`
        else if (block?.type === 'thinking' && event.delta.type === 'thinking_delta') block.thinking = `${block.thinking as string}${event.delta.thinking ?? ''}`
        else return
      } else return
      changed = true
    },
    /** The content so far, when it changed since last taken. */
    take(): Content | undefined {
      if (!changed) return undefined
      changed = false
      return contentOf(blocks.filter(Boolean))
    },
    clear() { blocks = []; changed = false },
  }
}
