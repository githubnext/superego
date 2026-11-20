// A stand-in for the Messages API (api.anthropic.com), for running the user's own `claude` in tests with no model, no
// account and nothing spent: `claude` reaches it through `ANTHROPIC_BASE_URL`. It answers from what the last prompt
// says:
//  - "Read <path>": a `Read` call of that path (once), then an answer;
//  - "Wait": starts answering ("Working on it"), then waits until the request is dropped (a Stop);
//  - anything else: "OK (mock saw N messages)", streamed a few characters at a time, N the messages the request
//    carried (so a resumed session's history shows).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Block = { type: string; text?: string; content?: unknown }
type Message = { role: string; content: string | Block[] }
/** A request the model was asked: its messages and the tools it was offered. */
export type MockRequest = { messages: Message[]; tools: string[]; stream: boolean }

const textOf = (message: Message | undefined) => !message ? '' : typeof message.content === 'string' ? message.content
  : message.content.map((b) => b.type === 'text' ? b.text ?? '' : '').join(' ')
const isToolResult = (message: Message) => Array.isArray(message.content) && message.content.some((b) => b.type === 'tool_result')

export type MockAnthropic = {
  url: string
  /** Every Messages request, in order. */
  requests: MockRequest[]
  /** The next "Wait" answer once it has started: `dropped` resolves when `claude` drops it (stopped). */
  held(): Promise<{ dropped: Promise<void> }>
  close(): Promise<void>
}

export async function mockAnthropic(): Promise<MockAnthropic> {
  const requests: MockRequest[] = []
  let n = 0
  /** "Wait" answers held open, in order, and how many `held()` has handed out. */
  const holds: { dropped: Promise<void> }[] = []
  let taken = 0
  const sse = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const open = new Set<ServerResponse>()

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let body = ''
    for await (const chunk of req) body += chunk
    const path = req.url ?? ''
    if (req.method !== 'POST' || !path.startsWith('/v1/messages') || path.includes('count_tokens')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }))
      return
    }
    const request = JSON.parse(body) as { messages?: Message[]; tools?: { name: string }[]; stream?: boolean; model?: string }
    const messages = request.messages ?? []
    const tools = (request.tools ?? []).map((t) => t.name)
    requests.push({ messages, tools, stream: Boolean(request.stream) })
    const prompt = [...messages].reverse().find((m) => m.role === 'user' && !isToolResult(m))
    const since = messages.slice(prompt ? messages.indexOf(prompt) : 0)
    const said = textOf(prompt)
    const read = /Read (\S+)/.exec(said)?.[1]
    const answered = since.some((m) => m.role === 'assistant')
    const id = `msg_mock_${++n}`
    const reply = read && !answered
      ? { type: 'tool_use', id: `toolu_mock_${n}`, name: 'Read', input: { file_path: read } }
      : { type: 'text', text: /\bWait\b/.test(said) ? 'Working on it' : `OK (mock saw ${messages.length} messages)` }
    const message = { id, type: 'message', role: 'assistant', model: request.model, content: [reply], stop_reason: reply.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }
    if (!request.stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    if (reply.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      for (const piece of (reply.text as string).match(/.{1,6}/g) ?? []) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
        await new Promise((r) => setTimeout(r, 5))
      }
      if (/\bWait\b/.test(said) && !answered) {
        // Hold the answer open until `claude` drops it.
        open.add(res)
        holds.push({ dropped: new Promise<void>((r) => res.on('close', () => { open.delete(res); r() })) })
        return
      }
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { ...reply, input: {} } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('mock Anthropic API:', error)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async held() {
      while (holds.length <= taken) await new Promise((r) => setTimeout(r, 20))
      return holds[taken++]!
    },
    close: () => new Promise<void>((r) => { for (const res of open) res.destroy(); server.close(() => r()) }),
  }
}
