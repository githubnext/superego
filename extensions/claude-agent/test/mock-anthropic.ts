// A stand-in for the Messages API (api.anthropic.com), for running the user's own `claude` in tests with no model, no
// account and nothing spent: `claude` reaches it through `ANTHROPIC_BASE_URL`. It answers from what the last prompt
// says, calling tools first where the prompt asks for them, one per request, then answering with the last tool's
// result ("Done: …"):
//  - "Read <path>": a `Read` of that path; "Skill <name>": a `Skill` call of that skill (after the Read, given both);
//    "… then Run <command>" after them: a `Bash` of that command;
//  - "Run <command>": a `Bash` of that command (to the end of the line);
//  - "Ask": an `AskUserQuestion` (which colour, Red or Blue);
//  - "Plan": an `ExitPlanMode` with a plan;
//  - "Use <tool> <json>": Superego's tool (`mcp__superego__<tool>`) with those arguments;
//  - "Delegate <prompt>": an `Agent` (a subagent) given that prompt, which this mock then answers as any other;
//  - "Wait": starts answering ("Working on it"), then waits until the request is dropped (a Stop);
//  - anything else: "OK (mock saw N messages)", streamed a few characters at a time, N the messages the request
//    carried (so a resumed session's history shows).
// A tool the request doesn't offer (a deferred one: Superego's, say) is loaded with ToolSearch first, as a model would.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Block = { type: string; text?: string; content?: unknown; name?: string; tool_use_id?: string }
type Message = { role: string; content: string | Block[] }
/** A request the model was asked: its messages, the tools it was offered, its system prompt and the model asked for. */
export type MockRequest = { messages: Message[]; tools: string[]; stream: boolean; system: string; model?: string }

const textOf = (message: Message | undefined) => !message ? '' : typeof message.content === 'string' ? message.content
  // What Claude Code adds to a prompt (its reminders) isn't what was said.
  : message.content.map((b) => b.type === 'text' && !b.text?.trimStart().startsWith('<system-reminder>') ? b.text ?? '' : '').join(' ')
const isToolResult = (message: Message) => Array.isArray(message.content) && message.content.some((b) => b.type === 'tool_result')
const resultText = (block: Block) => typeof block.content === 'string' ? block.content
  : Array.isArray(block.content) ? (block.content as Block[]).map((b) => b.text ?? '').join('') : ''

type Call = { name: string; input: Record<string, unknown> }

/** The tools a prompt asks for, in order. */
function planOf(said: string, everything: string): Call[] {
  const delegate = /\bDelegate (.+)$/m.exec(said)?.[1]
  if (delegate) return [{ name: 'Agent', input: { description: 'Look into it', prompt: delegate.trim(), subagent_type: 'general-purpose' } }]
  const use = /\bUse (\w+) (\{.*\})/.exec(said)
  if (use) return [{ name: `mcp__superego__${use[1]}`, input: JSON.parse(use[2]!) as Record<string, unknown> }]
  const read = /\bRead (\S+)/.exec(said)?.[1]
  const skill = /\bSkill (\S+)/.exec(said)?.[1]
  const then = /\bthen Run (.+)$/m.exec(said)?.[1]
  if (read || skill) {
    return [
      ...read ? [{ name: 'Read', input: { file_path: read } }] : [],
      ...skill ? [{ name: 'Skill', input: { skill } }] : [],
      ...then ? [{ name: 'Bash', input: { command: then.trim(), description: 'Runs what was asked' } }] : [],
    ]
  }
  const run = /\bRun (.+)$/m.exec(said)?.[1]
  if (run) return [{ name: 'Bash', input: { command: run.trim(), description: 'Runs what was asked' } }]
  if (/\bAsk\b/.test(said)) {
    return [{ name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] } }]
  }
  if (/\bPlan\b/.test(said)) {
    // As Claude Code's plan mode has it: the plan written to the file its reminder names, then ExitPlanMode.
    const file = /create your plan at (\S+?) using/.exec(everything)?.[1]
    const plan = '# Tidy up\n\n1. Remove the old file\n2. Run the tests'
    return [...file ? [{ name: 'Write', input: { file_path: file, content: plan } }] : [], { name: 'ExitPlanMode', input: {} }]
  }
  return []
}

export type MockAnthropic = {
  url: string
  /** Every Messages request, in order. */
  requests: MockRequest[]
  /** The next "Wait" answer once it has started: `dropped` resolves when `claude` drops it (stopped). */
  held(): Promise<{ dropped: Promise<void> }>
  /** Headers every answer carries from now on: the plan's rate limits, as Anthropic's API reports them. */
  headers: Record<string, string>
  /** Refuse every request from now on, as the API does once a plan's limit is reached (a 429 with these headers). */
  refuse: false | Record<string, string>
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
  const mock = { requests, headers: {}, refuse: false } as unknown as MockAnthropic

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let body = ''
    for await (const chunk of req) body += chunk
    const path = req.url ?? ''
    if (req.method !== 'POST' || !path.startsWith('/v1/messages') || path.includes('count_tokens')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }))
      return
    }
    if (mock.refuse) {
      res.writeHead(429, { 'content-type': 'application/json', ...mock.headers, ...mock.refuse })
        .end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }))
      return
    }
    const request = JSON.parse(body) as { messages?: Message[]; tools?: { name: string }[]; stream?: boolean; model?: string; system?: string | { text?: string }[] }
    const messages = request.messages ?? []
    const tools = (request.tools ?? []).map((t) => t.name)
    const system = typeof request.system === 'string' ? request.system : (request.system ?? []).map((b) => b.text ?? '').join('\n')
    requests.push({ messages, tools, stream: Boolean(request.stream), system, ...(request.model ? { model: request.model } : {}) })
    const prompt = [...messages].reverse().find((m) => m.role === 'user' && !isToolResult(m))
    const since = messages.slice(prompt ? messages.indexOf(prompt) : 0)
    const said = textOf(prompt)
    const made = since.flatMap((m) => m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use') : [])
    const everything = JSON.stringify(messages)
    const next = planOf(said, everything)[made.filter((b) => b.name !== 'ToolSearch').length]
    const searched = made.at(-1)?.name === 'ToolSearch'
    const results = since.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : [])
    const id = `msg_mock_${++n}`
    const tool = next && !tools.includes(next.name) && !searched
      ? { name: 'ToolSearch', input: { query: `select:${next.name}`, max_results: 1 } }
      : next
    const wait = /\bWait\b/.test(said) && !made.length
    const reply = tool
      ? { type: 'tool_use', id: `toolu_mock_${n}`, name: tool.name, input: tool.input }
      : { type: 'text', text: wait ? 'Working on it' : results.length ? `Done: ${resultText(results.at(-1)!)}` : `OK (mock saw ${messages.length} messages)` }
    const message = { id, type: 'message', role: 'assistant', model: request.model, content: [reply], stop_reason: reply.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }
    if (!request.stream) {
      res.writeHead(200, { 'content-type': 'application/json', ...mock.headers }).end(JSON.stringify(message))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...mock.headers })
    sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    if (reply.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      for (const piece of (reply.text as string).match(/[\s\S]{1,6}/g) ?? []) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
        await new Promise((r) => setTimeout(r, 5))
      }
      if (wait) {
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
  Object.assign(mock, {
    url: `http://127.0.0.1:${port}`,
    requests,
    async held() {
      while (holds.length <= taken) await new Promise((r) => setTimeout(r, 20))
      return holds[taken++]!
    },
    close: () => new Promise<void>((r) => { for (const res of open) res.destroy(); server.close(() => r()) }),
  })
  return mock
}
