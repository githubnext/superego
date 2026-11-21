// A Claude Agent thread's turn: a durable task (pi-durable's agent `runner`) that runs the user's own `claude` through
// the Agent SDK, one process for the turn, resuming the thread's Claude Code session. It appends what Claude Code says
// and does to the thread's conversation as it goes, publishes the answer as it streams, and completes with its answer.
// The run around it (working, done, failed, Stop, messages sent meanwhile) is pi-durable's.
//
// Within the turn:
// - each tool call gets its row as soon as Claude Code makes it (its entry, and a live slot while it runs), so what it
//   asks about, or a subagent's work, shows under the call it's for;
// - what Claude Code asks first (`canUseTool`) waits on the user, as the thread's status says: approvals (the host's,
//   with Allow, Deny and Always), its questions (through agent-ui's question card, the thread's own `ask_user`);
// - Superego's own tools reach it over an in-process MCP server bound to this thread (tools.ts);
// - a subagent's messages (under its Agent call) become that call's steps, kept with the thread by the host: a
//   subagent may go on after its call returned (Claude Code runs them in the background).
import { query, type CanUseTool, type Options, type PermissionResult, type Query, type SDKMessage, type SettingSource } from '@anthropic-ai/claude-agent-sdk'
import type { JsonValue } from '@earendil-works/chord/json'
import type { Json } from '@superego/protocol'
import type { Context } from '@earendil-works/chord/context'
import { AssistantEntry, defineDoc, defineTask, LiveDoc, ToolResultEntry, type EntryId, type EntryRecord, type LiveState, type TaskRuntime, type ToolSlot } from '@earendil-works/pi-durable'
import type { Message, ToolCall } from '@earendil-works/pi-ai'
import { approvalOf, askUserArgs, folderRules, questionsOf, resultOf } from './asks.ts'
import { explain, NOT_INSTALLED } from './claude.ts'
import { assistantMessage, contentOf, partialAnswer, resultText, toolCall, toolResultMessage, type Block, type StreamEvent } from './messages.ts'
import { SERVER, SETTING_SOURCES, type Answer, type Approval, type ClaudeAgentOptions, type SubagentSteps } from './shared.ts'
import { appendedPrompt, offeredTools, runTool, superegoServer } from './tools.ts'

/**
 * A thread's Claude Code session: its `session_id`, resumed by every turn after the first, and the context it belongs
 * to (`head`, the reset that began it: a thread started over starts a new session). What Claude Code said of itself
 * at the session's last start, for the thread's facts. Starts empty in a fork: a fork is the thread's, not the session's.
 */
export type Session = {
  id?: string
  head?: number | null
  version?: string
  model?: string
  /** Which credential Claude Code used (`apiKeySource`): `none` when it's the user's plan sign-in. */
  auth?: string
  /** The permission mode it ran in. */
  permissionMode?: string
}
export const SessionDoc = defineDoc<Session>({
  kind: 'claude-agent.session', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({}), checkpointWhen: () => true,
})

/**
 * What a turn runs with: the user's `claude`, its environment, the settings it may load in the thread's folder
 * (`sources`), and the daemon's side of the thread.
 */
export type TurnHost = {
  /** Where the user's `claude` is; undefined when it isn't installed. */
  executable(): Promise<string | undefined>
  /** The environment it gets for `thread`'s turn (without Anthropic credentials; marked with the thread). */
  env(thread: string): Record<string, string>
  /** Superego's plugin (its skills) for Claude Code to load, if it has one: a folder. */
  plugin?: string
  /**
   * The settings Claude Code loads for a turn of the thread whose conversation it is, in `cwd`: the user's own, and the
   * folder's only once the user allowed them as they are now (project.ts).
   */
  sources(conversationId: number, cwd: string): Promise<SettingSource[]>
  /** The thread a conversation is. */
  threadOf(conversationId: number): string | undefined
  /** How the thread's profile has its Claude Agent threads run (`claudeAgent`), as of its last send. */
  options(thread: string): ClaudeAgentOptions
  /** The tool rules the user said to always allow in `cwd` (always.ts). */
  rules(cwd: string): string[]
  /** Always allow `rules` in `cwd` from now on. */
  remember(cwd: string, rules: string[]): Promise<void>
  /** Wait for the user's answer to what Claude Code asks; rejects once `signal` aborts (the ask is withdrawn). */
  ask(approval: Approval, signal: AbortSignal): Promise<Answer>
  /** Keep a subagent's work as it stands, under its Agent call `call` (the thread's own), for the call's row. */
  subagent(thread: string, call: string, work: SubagentSteps): void
  /**
   * A place among the turns running at once on this machine (parallel.ts), once there is one: what gives it back.
   * Rejects once `signal` aborts while it waits.
   */
  place(thread: string, signal: AbortSignal): Promise<() => void>
}

type Checkpoint = { phase: 'run' }
type Result = { entryId: EntryId }
type Runtime = TaskRuntime<Record<string, never>, Checkpoint, Result, object>

/** How often the answer as it streams is published. */
const PARTIAL_MS = 100
/** The last lines of Claude Code's stderr kept, to say why a process that ended without an answer did. */
const STDERR_LINES = 20
/** How long what Claude Code asks about a call waits for the call's row, before it's shown anyway. */
const ROW_WAIT_MS = 5000
/** How much of each subagent step's result its Agent call keeps. */
const STEP_TEXT = 2000

/** The text the user said in this run: its inputs' text (from its first entry on), in order. */
function promptOf(entries: readonly { id: EntryId; model?: readonly unknown[] }[], first: EntryId | undefined) {
  const said: string[] = []
  for (const entry of entries) {
    if (first !== undefined && entry.id < first) continue
    for (const message of (entry.model ?? []) as Message[]) {
      if (message.role !== 'user') continue
      const text = typeof message.content === 'string' ? message.content : message.content.flatMap((c) => c.type === 'text' ? [c.text] : []).join('\n')
      if (text.trim()) said.push(text)
    }
  }
  return said.join('\n\n')
}

/** The tool calls of this run (from its first entry on) that have no result: cut off by a stop or a restart. */
function openCalls(entries: readonly EntryRecord[], first: EntryId | undefined) {
  const open = new Map<string, string>()
  for (const entry of entries) {
    if (first !== undefined && entry.id < first) continue
    for (const message of (entry.model ?? []) as Message[]) {
      if (message.role === 'assistant') for (const c of message.content) if (c.type === 'toolCall') open.set(c.id, c.name)
      if (message.role === 'toolResult') open.delete(message.toolCallId)
    }
  }
  return open
}

/** This run's open calls, to close (`appendClosed`), so none stays drawn as waiting. */
async function openOf(runtime: Runtime, context: Context) {
  const conversationId = runtime.conversationId
  const [view, live] = await Promise.all([runtime.context(conversationId, context), runtime.snapshot(LiveDoc, conversationId, context)])
  return openCalls(view.entries, live?.run?.first)
}

/** The turn task: `name` is its kind (pi-durable's agent `runner` names it). */
export function turnTask(name: string, host: TurnHost) {
  return defineTask<Record<string, never>, Checkpoint, Result>({
    name,
    version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      run: async (_task, runtime, context) => {
        // The daemon stopped during this turn (a crash, or a clean stop), and its `claude` with it: what it did is kept,
        // the rest isn't replayed. What it was waiting on (an approval, a tool) can't be answered by a new process: it
        // ends here, saying so. Known by the memo the turn leaves as it starts.
        if (await runtime.memo<boolean>('ran', context)) return fail(runtime, INTERRUPTED, context, await openOf(runtime, context))
        // Its place among the turns running at once first: a restart while it waits for one just waits again.
        const thread = host.threadOf(runtime.conversationId) ?? String(runtime.conversationId)
        const release = await host.place(thread, runtime.signal)
        try {
          await runtime.memo('ran', true, context)
          const executable = await host.executable()
          if (!executable) return fail(runtime, NOT_INSTALLED, context)
          await runTurn(runtime, executable, host, context)
        } finally {
          release()
        }
      },
    },
    abort: async (_task, runtime, context) => {
      // The running invocation stopped `claude` (its signal); what it streamed is the generation's to keep. Calls it
      // left open (waiting on an approval, say) end as stopped.
      const open = await openOf(runtime, context)
      await runtime.commit(async (tx) => {
        await appendClosed(tx, runtime, open, STOPPED)
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context)
    },
  })
}

const INTERRUPTED = 'Interrupted: Superego stopped during this turn. Send again to go on.'
const STOPPED = 'Stopped'

type Tx = Parameters<Parameters<Runtime['commit']>[0]>[0]

/** A result for each of `open`'s calls, saying `why` it ended. */
async function appendClosed(tx: Tx, runtime: Runtime, open: Map<string, string>, why: string) {
  for (const [id, name] of open) {
    await tx.appendEntry(ToolResultEntry, runtime.conversationId, {
      data: { diagnostics: [] }, model: [{ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: why }], isError: true, timestamp: runtime.now() }],
    })
  }
}

/** End the turn without an answer, saying why: the run fails with it (its open calls, if given, closed first). */
async function fail(runtime: Runtime, message: string, context: Context, open?: Map<string, string>) {
  await runtime.commit(async (tx) => {
    if (open) await appendClosed(tx, runtime, open, message)
    return { status: 'terminal', outcome: { status: 'failed', error: { message } } }
  }, context)
}

/** A promise with its resolve, to wait on something the loop sees. */
function later() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Aborts when either does. */
const either = (a: AbortSignal, b: AbortSignal) => AbortSignal.any([a, b])

async function runTurn(runtime: Runtime, executable: string, host: TurnHost, context: Context) {
  const conversationId = runtime.conversationId
  const thread = host.threadOf(conversationId) ?? String(conversationId)
  const [view, live, session, agent] = await Promise.all([
    runtime.context(conversationId, context),
    runtime.snapshot(LiveDoc, conversationId, context),
    runtime.snapshot(SessionDoc, conversationId, context),
    runtime.agent(context),
  ])
  const prompt = promptOf(view.entries, live?.run?.first)
  if (!prompt) return fail(runtime, 'Nothing to send: Claude Agent threads take text only for now', context)
  const head = view.head?.id ?? null
  const resume = session?.id && session.head === head ? session.id : undefined
  const choices = host.options(thread)
  // Without a folder of its own, Claude Code runs in the daemon's. What that folder may give, narrowed to what the
  // profile picks: a profile can't load a folder's settings the user hasn't allowed.
  const cwd = agent.cwd ?? process.cwd()
  const may = await host.sources(conversationId, cwd)
  const settingSources: SettingSource[] = (choices.settingSources ?? [...SETTING_SOURCES]).filter((source) => may.includes(source))
  // The profile's, and what the user said to always allow in the folder.
  const allowedTools = [...choices.allowedTools ?? [], ...host.rules(cwd)]
  const tools = offeredTools(agent)
  const append = await appendedPrompt(runtime, agent, tools, context, { skill: Boolean(host.plugin) })

  // Every write in order, one at a time: a published partial never lands after the entry that replaced it.
  let writes: Promise<unknown> = Promise.resolve()
  const write = (commit: Parameters<Runtime['commit']>[0], options?: Parameters<Runtime['commit']>[2]) => {
    const next = writes.then(() => runtime.commit(commit, context, options))
    writes = next.catch(() => {})
    return next
  }
  /** A write of what's shown live only: deferred, and refused once Stop came (expected: the run is ending). */
  const show = (change: (live: LiveState) => void) => {
    void write(async (tx) => { change(await tx.doc(LiveDoc, conversationId)); return undefined }, { persistence: { kind: 'deferred' } })
      .catch((error: unknown) => { if (!runtime.signal.aborted) runtime.report(error) })
  }

  // The answer as it streams in, published at most every PARTIAL_MS, deferred like pi's own (PROGRESS_COMMIT).
  const partial = partialAnswer()
  let model = session?.model ?? 'claude'
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = () => {
    timer = undefined
    const content = partial.take()
    if (!content?.length) return
    const message = assistantMessage(content, model)
    show((doc) => { doc.generation = { attempt: 1, message: message as never } })
  }

  // ── Tool calls: their rows, and what they report ─────────────────────────────────────────────────────────────────
  /** Tool calls by id: Claude Code's name for each, to name its result. */
  const calls = new Map<string, string>()
  /** Each call once its row is there (or it's a subagent's, which has none of its own): what asks about it waits for it. */
  const rows = new Map<string, ReturnType<typeof later>>()
  const row = (id: string) => rows.get(id) ?? rows.set(id, later()).get(id)!
  /** What each call reported for the transcript to draw it with: a Superego tool's details. */
  const details = new Map<string, JsonValue>()
  const report = (id: string, value: JsonValue) => {
    details.set(id, value)
    show((doc) => { const slot = doc.tools?.find((s) => s.callId === id); if (slot) slot.details = value })
  }
  /** Subagents' work, by their Agent call (the one in this thread's transcript); and each subagent call's Agent call. */
  const subagents = new Map<string, SubagentSteps>()
  const agentOf = new Map<string, string>()
  const workOf = (call: string) => subagents.get(call) ?? subagents.set(call, { status: 'running', steps: [], results: {} }).get(call)!
  const keep = (call: string) => host.subagent(thread, call, structuredClone(workOf(call)))

  // Claude Code sends a model message a block at a time, each as an `assistant` message of the same id: they're one
  // entry, appended when a tool call comes (so its row is there while it runs, or waits on the user), the next message,
  // a tool's result or the end.
  let pending: { id: string; blocks: Block[]; usage?: object } | undefined
  /** Messages whose usage is counted already (a message split over entries counts once). */
  const counted = new Set<string>()
  let answer: EntryId | undefined
  const flush = async (results: { block: { tool_use_id: string; content?: unknown; is_error?: boolean | null } }[] = []) => {
    const usage = pending && !counted.has(pending.id) ? pending.usage : undefined
    if (pending && usage) counted.add(pending.id)
    const message = pending ? assistantMessage(contentOf(pending.blocks), model, usage) : undefined
    pending = undefined
    if (!message && !results.length) return
    if (timer) { clearTimeout(timer); timer = undefined }
    partial.clear()
    const started = message?.content.flatMap((c) => c.type === 'toolCall' ? [c as ToolCall] : []) ?? []
    const ended = new Set(results.map(({ block }) => block.tool_use_id))
    await write(async (tx) => {
      const doc = await tx.doc(LiveDoc, conversationId)
      delete doc.generation
      if (message) {
        const entry = await tx.appendEntry(AssistantEntry, conversationId, { model: [message] })
        if (message.stopReason === 'stop') answer = entry.id
      }
      for (const { block } of results) {
        const id = block.tool_use_id
        await tx.appendEntry(ToolResultEntry, conversationId, { data: { diagnostics: [] }, model: [toolResultMessage(block, calls.get(id) ?? '', details.get(id))] })
      }
      // Running calls have a live slot, as a Superego thread's do: drawn as running, with what they report.
      const slots = [...(doc.tools ?? []).filter((s) => !ended.has(s.callId)), ...started.map((c): ToolSlot => ({ callId: c.id, name: c.name, status: 'running' }))]
      if (slots.length) doc.tools = slots
      else delete doc.tools
      return undefined
    })
    for (const call of started) row(call.id).resolve()
  }

  /** A subagent's message, under the Agent call `parent`: its text and tool calls, then their results, as that call's steps. */
  const subagent = (message: SDKMessage, parent: string) => {
    const top = agentOf.get(parent) ?? parent
    const work = workOf(top)
    if (message.type === 'assistant') {
      for (const block of message.message.content as Block[]) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) work.steps.push({ type: 'text', text: block.text })
        if (block.type === 'tool_use') {
          const use = block as { id: string; name: string; input: unknown }
          const input = use.input && typeof use.input === 'object' ? use.input as ToolCall['arguments'] : {}
          const { name, arguments: args } = toolCall(use.name, input)
          work.steps.push({ type: 'toolCall', id: use.id, name, arguments: args as Record<string, Json> })
          agentOf.set(use.id, top)
          // Its own call: what asks about it doesn't wait for a row of its own.
          row(use.id).resolve()
        }
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue
        const text = resultText(block)
        work.results[block.tool_use_id] = { text: text.length > STEP_TEXT ? `${text.slice(0, STEP_TEXT)}…` : text, isError: Boolean(block.is_error) }
      }
    } else return
    keep(top)
  }

  /** Wait for a call's row before asking about it (bounded: a call the loop never saw is asked about anyway). */
  const rowOf = async (id: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([row(id).promise, new Promise((r) => { timer = setTimeout(r, ROW_WAIT_MS) })])
    clearTimeout(timer)
  }

  // ── What Claude Code asks first ──────────────────────────────────────────────────────────────────────────────────
  const canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    // Superego's own tools run as a Superego thread's do, without asking: those of the server this turn gave it.
    if (options.mcpServer?.source === 'sdk' && options.mcpServer.name === SERVER) return { behavior: 'allow', updatedInput: input }
    const signal = either(options.signal, runtime.signal)
    await rowOf(options.toolUseID)
    signal.throwIfAborted()
    if (toolName === 'AskUserQuestion') return askQuestions(input, options.toolUseID, signal)
    const approval = approvalOf(toolName, input, options, thread, runtime.now())
    const answer = await host.ask(approval, signal)
    if (answer.choice === 'always') await host.remember(cwd, folderRules(options.suggestions))
    return resultOf(approval, input, answer, options.suggestions)
  }

  /** Claude Code's questions, one at a time, through the thread's own question card (agent-ui's `ask_user`). */
  const askQuestions = async (input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<PermissionResult> => {
    const ask = tools.find((t) => t.name === 'ask_user')
    if (!ask) return { behavior: 'deny', message: "The user can't be asked questions in this thread (Superego's Agent UI is off). Ask in your answer instead." }
    const answers: Record<string, string> = {}
    for (const [index, question] of questionsOf(input).entries()) {
      const run = await runTool(ask, askUserArgs(question), { runtime, callId: `${id}/${index + 1}`, signal, context, details: () => {} })
      signal.throwIfAborted()
      const said = (run.details as { answer?: unknown } | undefined)?.answer
      if (run.isError || typeof said !== 'string') return { behavior: 'deny', message: `The question couldn't be asked: ${run.content.map((c) => c.type === 'text' ? c.text : '').join('')}` }
      answers[question.question] = said
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }

  // ── Superego's tools, bound to this thread ───────────────────────────────────────────────────────────────────────
  const server = superegoServer(tools, async (tool, args, callId, signal) => {
    await rowOf(callId)
    const run = await runTool(tool, args, { runtime, callId, signal: either(signal, runtime.signal), context, details: (value) => report(callId, value) })
    if (run.details !== undefined) details.set(callId, run.details)
    return run
  })

  const stderr: string[] = []
  const abort = new AbortController()
  // The profile's mode, else `default` (ask): never one Claude Code's own settings pick, bypassing included.
  const mode = choices.permissionMode ?? 'default'
  const options: Options = {
    pathToClaudeCodeExecutable: executable,
    env: host.env(thread),
    abortController: abort,
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    ...(resume ? { resume } : {}),
    includePartialMessages: true,
    permissionMode: mode,
    // The thread's model and effort (picked in the model menu), else its profile's, else Claude Code's own.
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.effort ? { effort: choices.effort } : {}),
    // Bypassing every check only when the profile says so; never from Claude Code's own settings.
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    canUseTool,
    ...(allowedTools.length ? { allowedTools } : {}),
    ...(choices.disallowedTools?.length ? { disallowedTools: choices.disallowedTools } : {}),
    settingSources,
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
    mcpServers: { [SERVER]: server },
    // Superego's skills: a plugin of the daemon's, for this session alone (nothing written to the user's `~/.claude`).
    ...(host.plugin ? { plugins: [{ type: 'local' as const, path: host.plugin }] } : {}),
    stderr: (data) => { stderr.push(...data.split('\n').filter(Boolean)); stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES)) },
  }
  let q: Query | undefined
  const stop = () => {
    // Asked to stop it first, so it ends its turn as it would for the user; then the process goes.
    const asked = q?.interrupt().catch((error: unknown) => console.error('Claude Agent: interrupting Claude Code:', error))
    void Promise.race([asked, new Promise((r) => setTimeout(r, 2000))]).finally(() => abort.abort())
  }
  runtime.signal.addEventListener('abort', stop, { once: true })

  let failure: string | undefined
  let ended = false
  try {
    q = query({ prompt, options })
    for await (const message of q as AsyncIterable<SDKMessage>) {
      if (runtime.signal.aborted) break
      const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null
      if (parent) {
        subagent(message, parent)
        continue
      }
      switch (message.type) {
        case 'system':
          if (message.subtype === 'task_notification' && message.tool_use_id && subagents.has(message.tool_use_id)) {
            // A subagent ended (one in the background too): how, and what it found, in its call's row.
            Object.assign(workOf(message.tool_use_id), { status: message.status, ...(message.summary ? { summary: message.summary } : {}) })
            keep(message.tool_use_id)
          } else if (message.subtype === 'init') {
            model = message.model
            const started: Session = { id: message.session_id, head, version: message.claude_code_version, model: message.model, auth: message.apiKeySource, permissionMode: message.permissionMode }
            await write(async (tx) => { Object.assign(await tx.doc(SessionDoc, conversationId), started); return undefined })
            const failed = message.mcp_servers.find((s) => s.name === SERVER && s.status !== 'connected')
            if (failed) console.error(`Claude Agent: Superego's tools didn't reach Claude Code (${failed.status})`)
          }
          break
        case 'stream_event':
          partial.see(message.event as StreamEvent)
          timer ??= setTimeout(publish, PARTIAL_MS)
          break
        case 'assistant': {
          const { id, content, usage } = message.message as { id: string; content: Block[]; usage?: object }
          if (pending && pending.id !== id) await flush()
          pending ??= { id, blocks: [] }
          pending.blocks.push(...content)
          if (usage) pending.usage = usage
          const uses = content.filter((block) => block.type === 'tool_use') as { id: string; name: string }[]
          for (const use of uses) calls.set(use.id, use.name)
          if (uses.length) await flush()
          break
        }
        case 'user': {
          const content = message.message.content
          const results = Array.isArray(content) ? content.filter((b) => b.type === 'tool_result') : []
          if (results.length) await flush(results.map((block) => ({ block: block as never })))
          break
        }
        case 'result':
          ended = true
          await flush()
          if (message.is_error || message.subtype !== 'success') {
            failure = explain(message.subtype === 'success' ? message.result : message.errors.join('\n') || message.subtype)
          } else if (answer === undefined && message.result) {
            // It answered without a text of its own this turn (all tools): its result is the answer.
            await write(async (tx) => {
              answer = (await tx.appendEntry(AssistantEntry, conversationId, { model: [assistantMessage([{ type: 'text', text: message.result }], model)] })).id
              return undefined
            })
          }
          break
        default:
          // Status, retries, hooks, task notices, rate limits…: not shown yet. Unknown kinds are a newer Claude Code's.
          break
      }
    }
  } catch (error) {
    if (runtime.signal.aborted) throw error
    // Its error result says it better than the SDK's wrapping of it does.
    failure ??= explain(error instanceof Error ? error.message : String(error))
    if (!ended && stderr.length) failure = `${failure}\n${stderr.slice(-5).join('\n')}`
  } finally {
    // Subagents still going end with the process.
    for (const [call, work] of subagents) if (work.status === 'running') { work.status = 'stopped'; keep(call) }
    runtime.signal.removeEventListener('abort', stop)
    if (timer) clearTimeout(timer)
    q?.close()
  }
  runtime.signal.throwIfAborted()
  await writes
  if (failure !== undefined || answer === undefined) {
    if (failure === undefined) console.error(`Claude Agent: Claude Code ended without an answer${stderr.length ? `:\n${stderr.join('\n')}` : ''}`)
    const message = failure ?? `Claude Code ended without an answer${stderr.length ? `: ${stderr.at(-1)}` : ''}`
    return fail(runtime, message, context, await openOf(runtime, context))
  }
  const entryId = answer
  await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'completed', result: { entryId } } }), context)
}
