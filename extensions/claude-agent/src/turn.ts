// A Claude Agent thread's turn: a durable task (pi-durable's agent `runner`) that runs the user's own `claude` through
// the Agent SDK, one process for the turn, resuming the thread's Claude Code session. It appends what Claude Code says
// and does to the thread's conversation as it goes, publishes the answer as it streams, and completes with its answer.
// The run around it (working, done, failed, Stop, messages sent meanwhile) is pi-durable's.
import { query, type Options, type Query, type SDKMessage, type SettingSource } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@earendil-works/chord/context'
import { AssistantEntry, defineDoc, defineTask, LiveDoc, ToolResultEntry, type EntryId, type TaskRuntime } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { explain, NOT_INSTALLED } from './claude.ts'
import { assistantMessage, contentOf, partialAnswer, toolResultMessage, type Block, type StreamEvent } from './messages.ts'

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
}
export const SessionDoc = defineDoc<Session>({
  kind: 'claude-agent.session', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({}), checkpointWhen: () => true,
})

/**
 * What a turn runs: the user's `claude`, the environment it gets (without Anthropic credentials), and the settings it
 * loads in the thread's folder (`sources`).
 */
export type TurnHost = {
  /** Where the user's `claude` is; undefined when it isn't installed. */
  executable(): Promise<string | undefined>
  env(): Record<string, string>
  /**
   * The settings Claude Code loads for a turn of the thread whose conversation it is, in `cwd`: the user's own, and the
   * folder's only once the user allowed them as they are now (project.ts).
   */
  sources(conversationId: number, cwd: string): Promise<SettingSource[]>
}

type Checkpoint = { phase: 'run' }
type Result = { entryId: EntryId }
type Runtime = TaskRuntime<Record<string, never>, Checkpoint, Result, object>

/** How often the answer as it streams is published. */
const PARTIAL_MS = 100
/** The last lines of Claude Code's stderr kept, to say why a process that ended without an answer did. */
const STDERR_LINES = 20

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

/** The turn task: `name` is its kind (pi-durable's agent `runner` names it). */
export function turnTask(name: string, host: TurnHost) {
  return defineTask<Record<string, never>, Checkpoint, Result>({
    name,
    version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      run: async (task, runtime, context) => {
        // The daemon stopped during this turn, and its `claude` with it: what it did is kept, the rest isn't replayed.
        if (task.restarts !== undefined) return fail(runtime, 'Interrupted: Superego stopped during this turn. Send again to go on.', context)
        const executable = await host.executable()
        if (!executable) return fail(runtime, NOT_INSTALLED, context)
        await runTurn(runtime, executable, host, context)
      },
    },
    abort: async (_task, runtime, context) => {
      // The running invocation stopped `claude` (its signal); what it streamed is the generation's to keep.
      await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
    },
  })
}

/** End the turn without an answer, saying why: the run fails with it. */
async function fail(runtime: Runtime, message: string, context: Context) {
  await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'failed', error: { message } } }), context)
}

async function runTurn(runtime: Runtime, executable: string, host: TurnHost, context: Context) {
  const conversationId = runtime.conversationId
  const [view, live, session, agent] = await Promise.all([
    runtime.context(conversationId, context),
    runtime.snapshot(LiveDoc, conversationId, context),
    runtime.snapshot(SessionDoc, conversationId, context),
    runtime.agent(context),
  ])
  const prompt = promptOf(view.entries, live?.run?.first)
  if (!prompt) return fail(runtime, 'Nothing to send: Claude Agent threads take text only for now', context)
  const head = view.head?.id ?? null
  // Without a folder of its own, Claude Code runs in the daemon's.
  const settingSources = await host.sources(conversationId, agent.cwd ?? process.cwd())
  const resume = session?.id && session.head === head ? session.id : undefined

  // Every write in order, one at a time: a published partial never lands after the entry that replaced it.
  let writes: Promise<unknown> = Promise.resolve()
  const write = (commit: Parameters<Runtime['commit']>[0], options?: Parameters<Runtime['commit']>[2]) => {
    const next = writes.then(() => runtime.commit(commit, context, options))
    writes = next.catch(() => {})
    return next
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
    void write(async (tx) => {
      const doc = await tx.doc(LiveDoc, conversationId)
      doc.generation = { attempt: 1, message: message as never }
      return undefined
    }, { persistence: { kind: 'deferred' } }).catch((error: unknown) => {
      // After Stop, a write is refused: expected, the run is ending.
      if (!runtime.signal.aborted) runtime.report(error)
    })
  }

  // Claude Code sends a model message a block at a time, each as an `assistant` message of the same id: they're one
  // entry, appended when the next message, a tool's result or the end comes.
  let pending: { id: string; blocks: Block[]; usage?: object } | undefined
  /** Tool calls by id, to name their results. */
  const calls = new Map<string, string>()
  let answer: EntryId | undefined
  const flush = async (results: { block: { tool_use_id: string; content?: unknown; is_error?: boolean | null } }[] = []) => {
    const message = pending ? assistantMessage(contentOf(pending.blocks), model, pending.usage) : undefined
    pending = undefined
    if (!message && !results.length) return
    if (timer) { clearTimeout(timer); timer = undefined }
    partial.clear()
    await write(async (tx) => {
      const doc = await tx.doc(LiveDoc, conversationId)
      delete doc.generation
      if (message) {
        const entry = await tx.appendEntry(AssistantEntry, conversationId, { model: [message] })
        if (message.stopReason === 'stop') answer = entry.id
      }
      for (const { block } of results) {
        await tx.appendEntry(ToolResultEntry, conversationId, { data: { diagnostics: [] }, model: [toolResultMessage(block, calls.get(block.tool_use_id) ?? '')] })
      }
      return undefined
    })
  }

  const stderr: string[] = []
  const abort = new AbortController()
  const options: Options = {
    pathToClaudeCodeExecutable: executable,
    env: host.env(),
    abortController: abort,
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    ...(resume ? { resume } : {}),
    includePartialMessages: true,
    // No approvals yet: a tool the user's own settings don't allow is refused, not asked about.
    permissionMode: 'dontAsk',
    settingSources,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
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
      // A subagent's own messages (under its Agent call) aren't shown yet.
      if ('parent_tool_use_id' in message && message.parent_tool_use_id) continue
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            model = message.model
            const started: Session = { id: message.session_id, head, version: message.claude_code_version, model: message.model, auth: message.apiKeySource }
            await write(async (tx) => { Object.assign(await tx.doc(SessionDoc, conversationId), started); return undefined })
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
          for (const block of content) if (block.type === 'tool_use') calls.set((block as { id: string }).id, (block as { name: string }).name)
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
          // Status, retries, hooks, tasks, rate limits…: not shown yet. Unknown kinds are a newer Claude Code's.
          break
      }
    }
  } catch (error) {
    if (runtime.signal.aborted) throw error
    // Its error result says it better than the SDK's wrapping of it does.
    failure ??= explain(error instanceof Error ? error.message : String(error))
    if (!ended && stderr.length) failure = `${failure}\n${stderr.slice(-5).join('\n')}`
  } finally {
    runtime.signal.removeEventListener('abort', stop)
    if (timer) clearTimeout(timer)
    q?.close()
  }
  runtime.signal.throwIfAborted()
  await writes
  if (failure !== undefined || answer === undefined) {
    if (failure === undefined) console.error(`Claude Agent: Claude Code ended without an answer${stderr.length ? `:\n${stderr.join('\n')}` : ''}`)
    return fail(runtime, failure ?? `Claude Code ended without an answer${stderr.length ? `: ${stderr.at(-1)}` : ''}`, context)
  }
  const entryId = answer
  await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'completed', result: { entryId } } }), context)
}

