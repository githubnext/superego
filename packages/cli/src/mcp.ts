// `superego mcp`: an MCP server over stdio, made from a machine's actions. Every action exposed to `outside` is a tool
// (`thread.start` as `thread_start`, its params schema as the tool's), run through the daemon's `action.run` with
// `exposure: 'outside'`, so it is refused if it isn't exposed there and logged with the source `outside` like any other
// dispatch. Reads aren't actions (they stay plain methods), so two tools of the server's own read on them: `thread_list`
// and `thread_read`. One server serves one machine (`-m`); its tools change as that machine's extensions and settings
// do (starting threads is a tool only while the machine lets outside agents: `outside.startThreads`).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { PROTOCOL_VERSION, RpcError, type ActionInfo, type AppConfig, type Hello, type ThreadInfo } from '@superego/protocol'
import type { Transport } from '@superego/client'
import { brief, readThread } from './read.ts'

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

const READS: Tool[] = [
  {
    name: 'thread_list', title: 'List threads', annotations: { readOnlyHint: true },
    description: 'The threads on this machine, newest first: id, title, state (idle, working, done, blocked, error) and folder.',
    inputSchema: { type: 'object', properties: { archived: { type: 'boolean', description: 'The archived ones instead.' } }, additionalProperties: false },
  },
  {
    name: 'thread_read', title: 'Read a thread', annotations: { readOnlyHint: true },
    description: 'Where a thread stands and its last answer. wait: true waits while it is working first.',
    inputSchema: { type: 'object', properties: { thread: { type: 'string' }, wait: { type: 'boolean' } }, required: ['thread'], additionalProperties: false },
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
    instructions: `${app.name} runs coding agents in threads on ${label}. thread_start starts one (where the machine allows it), thread_send sends it a message, ` +
      'thread_read (wait: true) gets its answer, thread_list lists them. Every other tool is an action of that machine.',
  })

  /** Log a failure off any request to stderr, which MCP clients keep as the server's log: nobody waits on it to answer. */
  const said = (what: string) => (error: Error) => console.error(`${app.id} mcp: ${what}: ${error.message}`)
  let link: Promise<{ transport: Transport; hello: Hello }> | undefined
  let reconnected = false
  const daemon = () => link ??= (async () => {
    const client = server.getClientVersion()
    const opened = await connect(client ? `${client.title ?? client.name} (outside agent)` : 'An outside agent')
    // Its extensions changed what it takes; after a reconnect (a restart) it may have too.
    opened.transport.peer.on('features.changed', () => void server.sendToolListChanged().catch(said('telling the tools changed')))
    if (reconnected) void server.sendToolListChanged().catch(said('telling the tools changed'))
    // A setting may have changed what it lets outside agents run: told only when the list did. The settings are
    // watched only to hear that, for as long as this connection lasts (the daemon drops the watch with it).
    let offered = ''
    const ids = async () => (await opened.transport.peer.call<ActionInfo[]>('action.list', { exposure: 'outside' })).map((a) => a.id).join()
    opened.transport.peer.on('settings.changed', () => void ids().then((now) => {
      if (now !== offered) { offered = now; return server.sendToolListChanged() }
    }).catch(said('following the settings')))
    ;[offered] = await Promise.all([ids(), opened.transport.peer.call('settings.watch', {})])
    void opened.transport.closed.then(() => { link = undefined; reconnected = true })
    return opened
  })().catch((error: unknown) => { link = undefined; throw error })
  const call = async <T,>(method: string, params: unknown) => (await daemon()).transport.peer.call<T>(method, params)

  const actions = () => call<ActionInfo[]>('action.list', { exposure: 'outside' })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = new Map(READS.map((t) => [t.name, t]))
    for (const action of await actions()) tools.set(toolName(action.id), toolOf(action))
    return { tools: [...tools.values()] }
  })

  server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }, { signal }) => {
    try {
      if (name === 'thread_list') return text((await call<ThreadInfo[]>('thread.list', { archived: Boolean(args.archived) })).map(brief))
      if (name === 'thread_read') return text(await readThread(call, (await daemon()).hello, String(args.thread ?? ''), { wait: Boolean(args.wait), signal, label }))
      // Any other is an action, by its id: the daemon refuses one that isn't exposed, or isn't allowed now, saying why.
      return text(await call('action.run', { id: name.replaceAll('_', '.'), params: args, exposure: 'outside' }) ?? { ok: true })
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
  // A connection that failed told the request that wanted it; there's nothing to close.
  if (link) (await link.catch(() => undefined))?.transport.close()
}
