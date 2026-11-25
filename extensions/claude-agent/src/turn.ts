// A Claude Agent thread's turn: a durable task (pi-durable's agent `runner`) that runs on the user's own `claude`
// through the Agent SDK. It attaches to the thread's Claude Code (session.ts: kept running between turns, or started for
// this one, resuming the thread's session), gives it what the user said, appends what Claude Code says and does to the
// thread's conversation as it goes, publishes the answer as it streams, and completes with its answer. The run around it
// (working, done, failed, Stop, messages queued meanwhile) is pi-durable's.
//
// Within the turn:
// - a message the user sends now (a steer) goes in at once: placed in the conversation and given to Claude Code, which
//   takes it in mid-turn, or answers it next; the turn ends once Claude Code has answered all it was given;
// - each tool call gets its row as soon as Claude Code makes it (its entry, and a live slot while it runs), so what it
//   asks about, or a subagent's work, shows under the call it's for;
// - what Claude Code asks first (`canUseTool`) waits on the user, as the thread's status says: approvals (the host's,
//   with Allow, Deny and Always), its questions (through agent-ui's question card, the thread's own `ask_user`);
// - Superego's own tools reach it over an in-process MCP server bound to this thread (tools.ts);
// - a subagent's messages (under its Agent call) become that call's steps, kept with the thread by the host;
// - what Claude Code reports of the plan's limits goes to the host (a note), its compacting to the transcript, and how
//   full its context is, as the turn ends, to the thread's facts.
import type { CanUseTool, Options, PermissionResult, SDKMessage, SDKRateLimitInfo, SettingSource } from '@anthropic-ai/claude-agent-sdk'
import type { JsonValue } from '@earendil-works/chord/json'
import { NOTE_ENTRY, type Json } from '@superego/protocol'
import type { Context } from '@earendil-works/chord/context'
import { AssistantEntry, defineDoc, defineTask, InboxDoc, LiveDoc, placeSteers, ToolResultEntry, type EntryId, type EntryRecord, type LiveState, type TaskRuntime, type ToolSlot, type UserInput } from '@earendil-works/pi-durable'
import type { Message, ToolCall } from '@earendil-works/pi-ai'
import { approvalOf, askUserArgs, folderRules, questionsOf, resultOf } from './asks.ts'
import { explain, NOT_INSTALLED, signedOut } from './claude.ts'
import { assistantMessage, contentOf, partialAnswer, resultText, toolCall, toolResultMessage, type Block, type StreamEvent } from './messages.ts'
import { ClaudeProcess, type ClaudeProcesses, type Content } from './session.ts'
import { limitSaid, SERVER, SETTING_SOURCES, type Answer, type Approval, type ClaudeAgentOptions, type SubagentSteps } from './shared.ts'
import { appendedPrompt, offeredTools, runTool } from './tools.ts'

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
  /** Each thread's running Claude Code (session.ts). */
  processes: ClaudeProcesses
  /** How long a thread's Claude Code waits for its next turn before it goes. */
  idleMs: number
  /** A turn ended: how full the thread's context is, as Claude Code says, and the model it ran on. */
  ran(thread: string, facts: { context: { tokens: number; max: number }; model: string }): void
  /** What Claude Code reported of the plan's limits (`rate_limit_event`): the user's own, on this machine. */
  limit(info: SDKRateLimitInfo): void
  /** A turn failed as Claude Code isn't signed in: the thread waits for it to be. */
  signedOut(thread: string): void
}

type Checkpoint = { phase: 'run' }
type Result = { entryId: EntryId }
type Runtime = TaskRuntime<Record<string, never>, Checkpoint, Result, object>

/** How often the answer as it streams is published. */
const PARTIAL_MS = 100
/** How long what Claude Code asks about a call waits for the call's row, before it's shown anyway. */
const ROW_WAIT_MS = 5000
/** How much of each subagent step's result its Agent call keeps. */
const STEP_TEXT = 2000

/**
 * What the user said in this run, as Claude Code is given it: its inputs (from its first entry on; a run continued
 * without one, the user's messages since the last answer), their text and images. The files sent with them are named
 * by path in their text (`<attachment … path="…">`), for Claude Code to read.
 */
export function inputsOf(entries: readonly { id: EntryId; model?: readonly unknown[] }[], first: EntryId | undefined): Content {
  const since = first !== undefined ? entries.filter((e) => e.id >= first)
    : entries.slice(entries.findLastIndex((e) => (e.model as Message[] | undefined)?.some((m) => m.role === 'assistant')) + 1)
  return since.flatMap((entry) => ((entry.model ?? []) as Message[]).flatMap((m) => m.role === 'user' ? contentFor(m.content) : []))
}

/** A user message's content (pi-ai's) as Messages API blocks: its text, and its images as image blocks. */
export function contentFor(content: UserInput): Content {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  return content.flatMap((block): Content => {
    if (block.type === 'text') return block.text.trim() ? [{ type: 'text', text: block.text }] : []
    if (block.type === 'image') return [{ type: 'image', source: { type: 'base64', media_type: block.mimeType as 'image/png', data: block.data } }]
    return []
  })
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
          // Not found, or not looked for: the login shell couldn't be read (findClaude says why).
          const executable = await host.executable().catch((error: Error) => error)
          if (executable instanceof Error) return fail(runtime, executable.message, context)
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

/** How long Stop waits for Claude Code to end its turn as asked, before its process goes. */
const STOP_MS = 2000

async function runTurn(runtime: Runtime, executable: string, host: TurnHost, context: Context) {
  const conversationId = runtime.conversationId
  const thread = host.threadOf(conversationId) ?? String(conversationId)
  const [view, live, session, agent] = await Promise.all([
    runtime.context(conversationId, context),
    runtime.snapshot(LiveDoc, conversationId, context),
    runtime.snapshot(SessionDoc, conversationId, context),
    runtime.agent(context),
  ])
  const prompt = inputsOf(view.entries, live?.run?.first)
  if (!prompt.length) return fail(runtime, 'Nothing to send', context)
  const head = view.head?.id ?? null
  const resume = session?.id && session.head === head ? session.id : undefined
  const choices = host.options(thread)
  // Without a folder of its own, Claude Code runs in the daemon's. What that folder may give, narrowed to what the
  // profile picks: a profile can't load a folder's settings the user hasn't allowed.
  const cwd = agent.cwd ?? process.cwd()
  const may = await host.sources(conversationId, cwd)
  const settingSources: SettingSource[] = (choices.settingSources ?? [...SETTING_SOURCES]).filter((source) => may.includes(source))
  // Superego's own tools (the server this turn gives it, which stands in for any of Claude Code's of that name), the
  // profile's, and what the user said to always allow in the folder. Superego's are allowed here, not only in
  // `canUseTool`: in `auto`, Claude Code would ask its classifier first, a model request for every call.
  const allowedTools = [`mcp__${SERVER}`, ...choices.allowedTools ?? [], ...host.rules(cwd)]
  const tools = offeredTools(agent)
  const append = await appendedPrompt(runtime, agent, tools, context, { skill: Boolean(host.plugin) })
  // The profile's mode, else the machine's (Settings), else `auto`: never one Claude Code's own settings pick, bypassing
  // included.
  const mode = choices.permissionMode ?? 'auto'
  const options = {
    pathToClaudeCodeExecutable: executable,
    env: host.env(thread),
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    ...(resume ? { resume } : {}),
    includePartialMessages: true,
    permissionMode: mode,
    // The thread's model and effort (picked in the model menu), else its profile's, else Claude Code's own.
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.effort ? { effort: choices.effort } : {}),
    // Bypassing every check only when the profile or Settings says so; never from Claude Code's own settings.
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    allowedTools,
    ...(choices.disallowedTools?.length ? { disallowedTools: choices.disallowedTools } : {}),
    settingSources,
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
    // Superego's skills: a plugin of the daemon's, for this session alone (nothing written to the user's `~/.claude`).
    ...(host.plugin ? { plugins: [{ type: 'local' as const, path: host.plugin }] } : {}),
  } satisfies Omit<Options, 'abortController' | 'canUseTool' | 'mcpServers' | 'stderr'>
  // The thread's Claude Code, as this turn would start it: the one running when it was started so (and for the session
  // this turn goes on: a thread started over starts a new one), else a new one, resuming the session.
  const { resume: _, ...kept } = options
  const key = JSON.stringify({ ...kept, env: undefined, head, tools: tools.map((t) => t.name) })
  const { process: claude } = await host.processes.take(thread, key, (onClosed) => new ClaudeProcess({ thread, key, options, tools, onClosed }))

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

  // ── What the user sends meanwhile ────────────────────────────────────────────────────────────────────────────────
  /** What this turn gave Claude Code (its ids), and those it has taken in and answered (`command_lifecycle`). */
  const given = new Set<string>()
  const answered = new Set<string>()
  /** Whether Claude Code says what it did with each message (2.1.325 does): else a result ends the turn. */
  let tracked = false
  /** Steers being placed and given to Claude Code: the turn doesn't end on one half done. */
  let steering: Promise<unknown> = Promise.resolve()
  let ending = false
  const steer = () => {
    if (ending || runtime.signal.aborted) return
    steering = steering.then(async () => {
      if (ending) return
      let placed: Awaited<ReturnType<typeof placeSteers>> = []
      await write(async (tx) => { placed = await placeSteers(tx, conversationId, runtime.settings, runtime.now()); return undefined })
      for (const { content } of placed) {
        const blocks = contentFor(content)
        if (blocks.length) given.add(claude.send(blocks))
      }
    }).catch((error: unknown) => { if (!runtime.signal.aborted) runtime.report(error) })
  }
  const inbox = await runtime.watchDoc(InboxDoc, conversationId, context)

  // ── The turn: from the prompt to Claude Code's answer to all it was given ────────────────────────────────────────
  let failure: string | undefined
  /** This turn ran into a limit of the plan: what Claude Code said of it. */
  let refused: SDKRateLimitInfo | undefined
  let settled = false
  let notSignedIn = false
  /** What a compaction asked for said: the answer of a turn with none of its own. */
  let compacted: string | undefined
  const end = later()
  let broke: Error | undefined
  const message = async (message: SDKMessage) => {
    const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null
    if (parent) return subagent(message, parent)
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
        } else if (message.subtype === 'compact_boundary') {
          // Claude Code's own compaction: said where it happened, as Superego says its own.
          await flush()
          const { pre_tokens: before, trigger } = message.compact_metadata
          const text = `Claude Code compacted the conversation${trigger === 'manual' ? ' as asked' : ''} (it was ${tokens(before)} tokens).`
          // Asked for (`/compact`), it's the turn's answer; on its own, a note where it happened.
          if (trigger === 'manual') compacted = text
          else await write(async (tx) => { await tx.appendEntry(conversationId, { kind: NOTE_ENTRY, data: { text } }); return undefined })
        }
        break
      case 'rate_limit_event':
        host.limit(message.rate_limit_info)
        if (message.rate_limit_info.status === 'rejected') refused = message.rate_limit_info
        break
      case 'stream_event':
        last = null
        partial.see(message.event as StreamEvent)
        timer ??= setTimeout(publish, PARTIAL_MS)
        break
      case 'assistant': {
        last = null
        const { id, content, usage } = message.message as { id: string; content: Block[]; usage?: object }
        // Claude Code's word on a request that failed (not signed in, a limit): its result says it, as the turn's error.
        if (message.error) {
          if (message.error === 'authentication_failed') notSignedIn = true
          break
        }
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
      case 'result': {
        await flush()
        if (message.is_error || message.subtype !== 'success') {
          failure = explain(message.subtype === 'success' ? message.result : message.errors.join('\n') || message.subtype)
        } else failure = undefined
        if (message.user_message_uuid) answered.add(message.user_message_uuid)
        last = message.subtype === 'success' && !message.is_error ? message.result : undefined
        await settle()
        break
      }
      default:
        if ((message.type as string) === 'command_lifecycle') {
          const { command_uuid: id, state } = message as unknown as { command_uuid?: string; state?: string }
          tracked = true
          if (id && (state === 'completed' || state === 'cancelled')) answered.add(id)
          // Claude Code took up a message given too late for the turn before: its result comes next.
          if (state === 'started') last = null
          else if (last !== null) await settle()
        }
        // Status, retries, hooks, task notices…: not shown. Unknown kinds are a newer Claude Code's.
        break
    }
  }
  /** The last result's text, once one came and nothing was taken up since (`null`: none). */
  let last: string | undefined | null = null
  /**
   * After a result: the turn's done once Claude Code answered all it was given (a message it took in mid-turn is
   * answered with that result), or can't say what it answered. A message given too late to take in gets a turn of its
   * own from Claude Code, whose result comes next.
   */
  const settle = async () => {
    if (settled || last === null) return
    ending = true
    await steering
    if (tracked && [...given].some((id) => !answered.has(id))) { ending = false; steer(); return }
    if (settled) return
    settled = true
    const text = last || compacted
    if (failure === undefined && answer === undefined && text) {
      // It answered without a text of its own this turn (all tools): its result is the answer.
      await write(async (tx) => {
        answer = (await tx.appendEntry(AssistantEntry, conversationId, { model: [assistantMessage([{ type: 'text', text }], model)] })).id
        return undefined
      })
    }
    end.resolve()
  }

  claude.attach({
    message: async (said) => {
      // Stopped: nothing more is kept, but the turn Claude Code was asked to end has ended once its result comes.
      if (runtime.signal.aborted) {
        if (said.type === 'result') { settled = true; end.resolve() }
        return
      }
      try {
        await message(said)
      } catch (error) {
        // A write the turn couldn't make (the run ending, say): it ends here, saying why.
        if (runtime.signal.aborted) return
        broke = error instanceof Error ? error : new Error(String(error))
        end.resolve()
      }
    },
    canUseTool,
    runTool: async (tool, args, callId, signal) => {
      await rowOf(callId)
      const run = await runTool(tool, args, { runtime, callId, signal: either(signal, runtime.signal), context, details: (value) => report(callId, value) })
      if (run.details !== undefined) details.set(callId, run.details)
      return run
    },
    ended: (error) => { broke = error; end.resolve() },
  })
  // Stop: Claude Code is asked to end its turn, as the user would ask it; one that doesn't, or would still run messages
  // it was given, goes.
  const stop = () => {
    const stopped = claude.interrupt().then(
      (queued) => { if (queued.length) claude.close() },
      (error: unknown) => {
        // Closed meanwhile (the daemon stopping, say): nothing left to stop.
        if (!claude.closed) console.error('Claude Agent: interrupting Claude Code:', error)
        claude.close()
      })
    void Promise.race([Promise.all([stopped, end.promise]), new Promise((r) => setTimeout(r, STOP_MS))]).then(() => {
      if (!settled) claude.close()
    })
  }
  runtime.signal.addEventListener('abort', stop, { once: true })
  inbox?.start(async () => steer())

  try {
    given.add(claude.send(prompt))
    // What was sent before the turn started, as steers (none, usually): given too.
    steer()
    await Promise.race([end.promise, new Promise<void>((resolve) => runtime.signal.addEventListener('abort', () => resolve(), { once: true }))])
  } finally {
    ending = true
    inbox?.stop()
    runtime.signal.removeEventListener('abort', stop)
    if (timer) clearTimeout(timer)
    // Subagents still going (in the background) end with the process, which can't wait for its next turn then.
    const going = [...subagents].filter(([, work]) => work.status === 'running')
    for (const [call, work] of going) { work.status = 'stopped'; keep(call) }
    if (going.length || broke) claude.close()
    if (runtime.signal.aborted) {
      // Detached once Claude Code ended the turn it was asked to stop (or goes, above).
      void Promise.race([end.promise, claude.done]).then(() => claude.detach(host.idleMs))
    } else claude.detach(host.idleMs)
  }
  runtime.signal.throwIfAborted()
  await writes
  if (settled && !claude.closed) {
    await claude.context().then((usage) => host.ran(thread, { context: usage, model }), (error: unknown) => console.error(`Claude Agent: thread ${thread}'s context usage:`, error))
  }
  // Refused for the plan's limits, said as Claude Code says it; not signed in, the thread waits for it to be.
  if (refused) failure = limitSaid(refused, true)
  if (broke) failure ??= explain(broke.message)
  if (failure === undefined && answer === undefined) {
    console.error(`Claude Agent: Claude Code ended without an answer${claude.stderr.length ? `:\n${claude.stderr.join('\n')}` : ''}`)
    failure = `Claude Code ended without an answer${claude.stderr.length ? `: ${claude.stderr.at(-1)}` : ''}`
  } else if (broke && !settled && claude.stderr.length) failure = `${failure}\n${claude.stderr.slice(-5).join('\n')}`
  if (failure !== undefined) {
    // A Claude Code that failed a turn isn't kept: what failed it (its sign-in, say) is read as it starts.
    claude.close()
    if (notSignedIn || signedOut(failure)) host.signedOut(thread)
    return fail(runtime, failure, context, await openOf(runtime, context))
  }
  const entryId = answer!
  await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'completed', result: { entryId } } }), context)
}

/** A count of tokens, said short: "48k", "1.2M". */
export function tokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}
