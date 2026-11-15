// `superego mcp`: an MCP server over stdio, made from a machine's actions. Every action exposed to `mcp` is a tool
// (`thread.create` as `thread_create`, its params schema as the tool's), run through the daemon's `action.run` with
// `exposure: 'mcp'`, so it is refused if it isn't exposed there and logged with the source `mcp` like any other
// dispatch. Reads aren't actions (they stay plain methods), so two tools of the server's own read on them: `thread_list`
// and `thread_read`. One server serves one machine (`-m`); its tools change as that machine's extensions do.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { PROTOCOL_VERSION, RpcError, type ActionInfo, type AppConfig, type Hello, type ThreadInfo } from '@superego/protocol'
import type { Transport } from '@superego/client'

export type McpOptions = {
  app: AppConfig
  /** Which machine it serves, for people: "This computer", a machine's name. */
  label: string
  /** A connection to that machine's daemon, said hello to as `label` (the MCP client's name, once it gave one). */
  connect(label: string): Promise<{ transport: Transport; hello: Hello }>
}

/** An action's tool name: MCP clients take `[A-Za-z0-9_-]`, and action ids have no `_`, so it maps back. */
export const toolName = (id: string) => id.replaceAll('.', '_')

const OBJECT = { type: 'object' as const, properties: {} }

/** The tool an action is. */
export function toolOf(action: ActionInfo): Tool {
  const schema = (action.params ?? OBJECT) as Tool['inputSchema']
  return { name: toolName(action.id), title: action.title, description: action.description ?? action.title, inputSchema: { ...schema, type: 'object' } }
}

/** What a thread is, for an agent elsewhere: no panes, no session internals. */
const brief = (t: ThreadInfo) => ({
  id: t.id, title: t.title, state: t.status.state, ...(t.status.msg ? { status: t.status.msg } : {}), cwd: t.cwd,
  ...(t.parent ? { parent: t.parent } : {}), ...(t.profile ? { profile: t.profile.name } : {}), ...(t.model ? { model: t.model } : {}),
  ...(t.archived ? { archived: true } : {}), activeAt: new Date(t.activeAt).toISOString(),
})

/** The text of the newest assistant answer among a conversation's entries, oldest first. */
function lastAnswer(entries: { model?: unknown[] }[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const said = (message.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim()
    if (said) return said
  }
  return undefined
}

const READS: Tool[] = [
  {
    name: 'thread_list', title: 'List threads', annotations: { readOnlyHint: true },
    description: 'The threads on this machine, newest first: id, title, state (idle, working, done, blocked, error) and folder.',
    inputSchema: { type: 'object', properties: { archived: { type: 'boolean', description: 'The archived ones instead.' } }, additionalProperties: false },
  },
  {
    name: 'thread_read', title: 'Read a thread', annotations: { readOnlyHint: true },
    description: 'Where a thread stands and its last answer. wait: true waits while it is working first.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, wait: { type: 'boolean' } }, required: ['id'], additionalProperties: false },
  },
]

const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const failed = (error: unknown): CallToolResult => {
  const hint = error instanceof RpcError && error.hint ? `\n${error.hint}` : ''
  return { isError: true, content: [{ type: 'text', text: `${error instanceof Error ? error.message : String(error)}${hint}` }] }
}

/** Serve MCP on stdio until the client goes. The daemon is reached on the first request, and again after it went away. */
export async function serveMcp({ app, label, connect }: McpOptions): Promise<void> {
  const server = new Server({ name: app.id, title: app.name, version: String(PROTOCOL_VERSION) }, {
    capabilities: { tools: { listChanged: true } },
    instructions: `${app.name} runs coding agents in threads on ${label}. thread_create starts one, thread_submit sends it a message, ` +
      'thread_read (wait: true) gets its answer, thread_list lists them. Every other tool is an action of that machine.',
  })

  let link: Promise<{ transport: Transport; hello: Hello }> | undefined
  let reconnected = false
  const daemon = () => link ??= (async () => {
    const client = server.getClientVersion()
    const opened = await connect(client ? `${client.title ?? client.name} (MCP)` : 'MCP')
    // Its extensions changed what it takes; after a reconnect (a restart) it may have too.
    opened.transport.peer.on('features.changed', () => void server.sendToolListChanged().catch(() => {}))
    if (reconnected) void server.sendToolListChanged().catch(() => {})
    void opened.transport.closed.then(() => { link = undefined; reconnected = true })
    return opened
  })().catch((error: unknown) => { link = undefined; throw error })
  const call = async <T,>(method: string, params: unknown) => (await daemon()).transport.peer.call<T>(method, params)

  const actions = async () => (await call<ActionInfo[]>('action.list', {})).filter((a) => a.expose.includes('mcp'))

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = new Map(READS.map((t) => [t.name, t]))
    for (const action of await actions()) tools.set(toolName(action.id), toolOf(action))
    return { tools: [...tools.values()] }
  })

  server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }, { signal }) => {
    try {
      const action = (await actions()).find((a) => toolName(a.id) === name)
      if (action) return text(await call('action.run', { id: action.id, params: args, exposure: 'mcp' }) ?? { ok: true })
      if (name === 'thread_list') return text((await call<ThreadInfo[]>('thread.list', { archived: Boolean(args.archived) })).map(brief))
      if (name === 'thread_read') {
        const id = String(args.id ?? '')
        const find = async () => (await call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id) ?? (await call<ThreadInfo[]>('thread.list', { archived: true })).find((t) => t.id === id)
        let thread = await find()
        if (!thread) throw new RpcError('not_found', `No thread ${id} on ${label}`)
        while (args.wait && thread.status.state === 'working') {
          if (signal.aborted) throw new Error('Stopped waiting')
          await new Promise((resolve) => setTimeout(resolve, 500))
          thread = (await find()) ?? thread
        }
        const { entries } = await call<{ entries: { model?: unknown[] }[] }>('thread.history', { id, before: Number.MAX_SAFE_INTEGER, limit: 50 })
        const answer = lastAnswer(entries)
        return text({ thread: brief(thread), ...(answer ? { answer } : {}) })
      }
      throw new RpcError('unknown_action', `No tool ${name} here`)
    } catch (error) {
      return failed(error)
    }
  })

  const transport = new StdioServerTransport()
  const done = new Promise<void>((resolve) => { server.onclose = resolve })
  // The client hung up: stdio ends, and so does the server (the SDK's transport doesn't watch for it).
  process.stdin.once('end', () => void server.close())
  await server.connect(transport)
  await done
  if (link) (await link.catch(() => undefined))?.transport.close()
}
