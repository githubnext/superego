// Superego's own tools in a Claude Agent thread: the thread's own agent tools (thread-tools', panes', agent-ui's,
// images', tasks'), the same ones a Superego thread has, run for its Claude Code over an in-process MCP server bound to
// the thread, so `thread_start` starts a child of this thread, `pane_open` opens beside it, `ask_user` waits in its
// question card. And what Superego says of itself in a thread's prompt, appended to Claude Code's own.
//
// Pi-only, for now: the coding tools (Claude Code has its own), skills (Claude Code reads its own `.claude/skills`, and
// gets Superego's `superego` skill as a plugin: plugin.ts), AGENTS.md (it reads `CLAUDE.md`), the MCP servers of
// Settings and profiles (passing them on is a later wave), Ego's setup tools (Ego's thread isn't a Claude Agent one),
// and every other extension's agent parts: their tools may need more of pi-durable's tool runtime than this gives
// (nested calls, tasks of their own), and their hooks don't run in Claude Code's loop.
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import type { Agent, TaskRuntime, ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import { PLUGIN } from './plugin.ts'
import { SERVER } from './shared.ts'

/** The tools a Claude Agent thread gets over MCP, by name, from its own agent's (those its extensions give it). */
export const OFFERED = new Set([
  'thread_start', 'thread_read', 'thread_send', 'thread_list', 'thread_machines', 'thread_archive',
  'pane_open',
  'ask_user', 'ask_ui', 'show_ui', 'open_ui', 'update_ui',
  'show_images',
  'task_start', 'task_finish',
])

/**
 * The sections of a thread's prompt appended to Claude Code's: how the thread shows messages and where it runs, what
 * the tools above need said (the panes there are, the threads around, the blocks UI is drawn with, images, tasks),
 * and the profile's own instructions, last.
 */
export const SECTIONS = ['markdown', 'where', 'panes', 'threads', 'ui_blocks', 'images', 'task_reporting', 'instructions']

/** A tool's name in Claude Code: on the `superego` server. */
export const mcpName = (name: string) => `mcp__${SERVER}__${name}`

/** The thread's tools it gets over MCP: those of its agent's tools that are offered, as its agent has them now. */
export function offeredTools(agent: Agent): ToolRegistration[] {
  const seen = new Set<string>()
  return [...agent.tools, ...agent.deferred].filter((tool) => OFFERED.has(tool.name) && !seen.has(tool.name) && seen.add(tool.name))
}

type Runtime = TaskRuntime<any, any, any, any>

/** A tool's first sentence: its line in the prompt. */
const firstSentence = (text: string) => (/^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text.trim()).replace(/\s+/g, ' ')

/**
 * What Superego appends to Claude Code's system prompt: its tools, a line each (MCP tools reach the model through
 * ToolSearch, so it has to know to load them), then the thread's sections, rendered as a Superego thread's are.
 */
export async function appendedPrompt(runtime: Runtime, agent: Agent, tools: readonly ToolRegistration[], context: Context, { skill = false }: {
  /** Claude Code has Superego's skill (its plugin's): the command line is worth a line. */
  skill?: boolean
} = {}): Promise<string> {
  const parts = [
    'You are working in a Superego thread: Superego is the app showing this conversation to the user, beside others, '
      + 'with panes it can open beside it. What follows is Superego\'s, about the thread and its tools.',
  ]
  if (tools.length) {
    parts.push([
      '<superego_tools>',
      `Superego's tools are MCP tools on the "${SERVER}" server: ${mcpName('<name>')}. They are deferred: load one with ToolSearch `
        + `("select:${mcpName('<name>')}") before its first use. Where these instructions name one by its short name, they mean it.`,
      ...tools.map((tool) => `- ${tool.name}: ${firstSentence(tool.description)}`),
      '</superego_tools>',
    ].join('\n'))
  }
  if (skill) {
    parts.push([
      '<superego_cli>',
      `The \`superego\` command line works from Bash here, for scripting Superego (threads, actions, profiles, extensions); what it starts or sends is signed as this thread's. The ${PLUGIN}:superego skill says how. For the user (questions, panes, UI), use the tools above.`,
      '</superego_cli>',
    ].join('\n'))
  }
  const env = await runtime.env(context).catch((error: unknown) => { runtime.report(error); return undefined })
  for (const key of SECTIONS) {
    const section = agent.sections.find((s) => s.key === key)
    if (!section) continue
    try {
      const text = await section.render({ conversationId: runtime.conversationId, agent, env, shown: {}, read: runtime }, context)
      if (text !== undefined) parts.push(section.tag === false ? text : `<${key}>\n${text}\n</${key}>`)
    } catch (error) {
      // As Superego's own threads do: a section that fails is left out, and said.
      console.error(`Claude Agent: the prompt section ${key} failed:`, error)
    }
  }
  return parts.join('\n\n')
}

/** What a tool call gave back: for Claude Code (its content), and for the transcript (its details). */
export type ToolRun = { content: ToolResultMessage['content']; isError: boolean; details?: JsonValue }

const unsupported = (what: string) => () => { throw new Error(`${what} isn't available to tools in a Claude Agent thread`) }

/**
 * Run one of the thread's tools as its agent would: its arguments checked against its schema, then `execute` with a
 * tool API made of the turn's (the conversation, the call's id, its details as it reports them), cut short when
 * `signal` aborts. The parts of pi-durable's tool API a model's tool round alone has (nested calls, tasks, memos,
 * parking until woken) are refused, saying so: the offered tools don't use them.
 */
export async function runTool(tool: ToolRegistration, args: Record<string, unknown>, { runtime, callId, signal, context, details }: {
  runtime: Runtime; callId: string; signal: AbortSignal; context: Context
  /** What the call reports as it goes (`api.details`): the latest. */
  details(value: JsonValue): void
}): Promise<ToolRun> {
  const output: string[] = []
  let reported: JsonValue | undefined
  const call = withAbortSignal(signal, context)
  try {
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args
    const valid = validateToolArguments(tool, { type: 'toolCall', id: callId, name: tool.name, arguments: prepared as Record<string, any> })
    const env = await runtime.env(call)
    const api: ToolExecutionApi = {
      taskId: runtime.taskId,
      conversationId: runtime.conversationId,
      callId,
      // Never parked, so never woken: every call is a first run.
      wake: undefined,
      checkpoint: undefined,
      readSignal: (token, key, c) => runtime.readSignal(token, key, c),
      registry: runtime.registry,
      agent: (c) => runtime.agent(c),
      get models() { return runtime.models },
      env,
      now: () => runtime.now(),
      output(chunk) { output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)) },
      outputWindow: undefined,
      retainedOutput: () => ({ text: output.join(''), truncated: false }),
      diagnostic(diagnostic) { if (diagnostic.severity === 'error') output.push(`\n${diagnostic.message}`) },
      async details(value) { reported = value; details(value) },
      async commit(change, c, options) {
        let out: Awaited<ReturnType<typeof change>> | undefined
        await runtime.commit(async (tx) => { out = await change(tx); return undefined }, c, options)
        return out as Awaited<ReturnType<typeof change>>
      },
      memo: unsupported('A memo') as ToolExecutionApi['memo'],
      createTask: unsupported('Starting a task'),
      getTask: (id, c) => runtime.getTask(id, c),
      waitForTask: (id, c) => runtime.waitForTask(id, c),
      conversation: (id, c) => runtime.conversation(id, c),
      executeTool: unsupported('Calling another tool'),
      snapshot: runtime.snapshot.bind(runtime) as ToolExecutionApi['snapshot'],
      snapshotAsOf: runtime.snapshotAsOf.bind(runtime) as ToolExecutionApi['snapshotAsOf'],
      watchDoc: runtime.watchDoc.bind(runtime) as ToolExecutionApi['watchDoc'],
    }
    const result = await tool.execute(valid, api, call)
    if (result.sleep !== undefined || result.wait !== undefined) throw new Error(`Parking isn't available to tools in a Claude Agent thread`)
    const content = result.output ?? [{ type: 'text' as const, text: output.join('') }]
    const final = result.details ?? reported
    return { content, isError: Boolean(result.isError), ...(final !== undefined ? { details: final } : {}) }
  } catch (error) {
    const message = signal.aborted ? 'Stopped' : error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text', text: message }], isError: true, ...(reported !== undefined ? { details: reported } : {}) }
  }
}

/** A tool's result as MCP has it. */
function mcpResult({ content, isError }: ToolRun): CallToolResult {
  return {
    content: content.map((c) => c.type === 'image' ? { type: 'image' as const, data: c.data, mimeType: c.mimeType } : { type: 'text' as const, text: c.text }),
    ...(isError ? { isError: true } : {}),
  }
}

/**
 * The in-process MCP server Claude Code gets Superego's tools from, for one turn: `run` runs a call, by the tool's
 * name, as the tool call `callId` of Claude Code's (its `tool_use` id, so its row in the transcript is that call's).
 */
export function superegoServer(tools: readonly ToolRegistration[], run: (tool: ToolRegistration, args: Record<string, unknown>, callId: string, signal: AbortSignal) => Promise<ToolRun>): McpSdkServerConfigWithInstance {
  const instance = new McpServer({ name: SERVER, version: '1.0.0' }, { capabilities: { tools: {} } })
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: { ...(tool.parameters as object), type: 'object' as const } })),
  }))
  instance.server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const tool = tools.find((t) => t.name === params.name)
    if (!tool) return { isError: true, content: [{ type: 'text', text: `No tool ${params.name} here` }] }
    // Claude Code says which of its calls this is.
    const said = params._meta?.['claudecode/toolUseId']
    return mcpResult(await run(tool, params.arguments ?? {}, typeof said === 'string' ? said : randomUUID(), signal))
  })
  return { type: 'sdk', name: SERVER, instance }
}
