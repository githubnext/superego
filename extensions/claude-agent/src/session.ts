// A Claude Agent thread's Claude Code, kept running while the thread is in use: one `query()` of the Agent SDK fed by
// streaming input, so a turn starts without spawning `claude` and resuming its session, and a message sent mid-turn
// reaches Claude Code at once. A turn attaches to it for its length (turn.ts): what Claude Code says and asks goes to
// that turn. Between turns it waits, and a few idle minutes on it goes (`ClaudeProcesses`); the next turn starts another,
// resuming the session. A daemon restart loses it the same way.
//
// It's only kept while Claude Code is idle between turns: a turn that leaves work going on in the background (a
// subagent) closes it, as does Claude Code starting a turn of its own, which no Superego turn would mirror.
import { randomUUID } from 'node:crypto'
import { query, type CanUseTool, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { superegoServer, type ToolRun } from './tools.ts'
import { SERVER } from './shared.ts'

/** What a user message gives Claude Code: Messages API content blocks. */
export type Content = Exclude<SDKUserMessage['message']['content'], string>

/** The turn attached to a process: what it hears and answers for. */
export type TurnHandlers = {
  /** A message of Claude Code's. Messages are handed over one at a time, in order. */
  message(message: SDKMessage): Promise<void>
  canUseTool: CanUseTool
  runTool(tool: ToolRegistration, args: Record<string, unknown>, callId: string, signal: AbortSignal): Promise<ToolRun>
  /** The process ended (exited, or failed) while this turn was attached: why. */
  ended(error: Error): void
}

/** What Claude Code sends only while it works on a turn: between Superego's turns, a turn of its own. */
const WORK = new Set<string>(['assistant', 'user', 'stream_event', 'result', 'tool_progress'])

/** The last lines of Claude Code's stderr kept, to say why a process that ended without an answer did. */
const STDERR_LINES = 20

/** A queue Claude Code reads its input from, as it comes (streaming input). */
class Input implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = []
  #wake?: () => void
  #done = false
  push(message: SDKUserMessage) { this.#items.push(message); this.#wake?.() }
  end() { this.#done = true; this.#wake?.() }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.#items.length) yield this.#items.shift()!
      if (this.#done) return
      await new Promise<void>((resolve) => { this.#wake = resolve })
      this.#wake = undefined
    }
  }
}

/** One thread's running Claude Code: `options` are what it was started with; `key`, what a turn may reuse it for. */
export class ClaudeProcess {
  readonly thread: string
  readonly key: string
  /** Claude Code's last lines on stderr. */
  readonly stderr: string[] = []
  #input = new Input()
  #query: Query
  #abort = new AbortController()
  #turn: TurnHandlers | undefined
  #closed = false
  #idle: ReturnType<typeof setTimeout> | undefined
  #onClosed: (process: ClaudeProcess) => void
  /** Settles when no turn is attached (detached, or closed). */
  #free: Promise<void> = Promise.resolve()
  #freed: () => void = () => {}
  /** Settles once Claude Code's output ends (the process exited or was closed). */
  readonly done: Promise<void>

  constructor({ thread, key, options, tools, onClosed }: {
    thread: string; key: string
    /** Its options, but for the turn's own: what asks and Superego's tools go to the turn attached. */
    options: Omit<Options, 'abortController' | 'canUseTool' | 'mcpServers' | 'stderr'>
    tools: readonly ToolRegistration[]
    onClosed(process: ClaudeProcess): void
  }) {
    this.thread = thread
    this.key = key
    this.#onClosed = onClosed
    const canUseTool: CanUseTool = (name, input, asked): Promise<PermissionResult | null> => this.#turn
      ? this.#turn.canUseTool(name, input, asked)
      : Promise.resolve({ behavior: 'deny', message: 'The turn this was for has ended.' })
    const server = superegoServer(tools, (tool, args, callId, signal) => this.#turn
      ? this.#turn.runTool(tool, args, callId, signal)
      : Promise.resolve({ content: [{ type: 'text', text: 'The turn this was for has ended.' }], isError: true }))
    this.#query = query({
      prompt: this.#input,
      options: {
        ...options,
        abortController: this.#abort,
        canUseTool,
        mcpServers: { [SERVER]: server },
        stderr: (data) => { this.stderr.push(...data.split('\n').filter(Boolean)); this.stderr.splice(0, Math.max(0, this.stderr.length - STDERR_LINES)) },
      },
    })
    this.done = this.#pump()
  }

  get closed() { return this.#closed }

  /** Hand Claude Code's messages to the turn attached, one at a time; what comes between turns is looked at here. */
  async #pump() {
    let failure: Error | undefined
    try {
      for await (const message of this.#query as AsyncIterable<SDKMessage>) {
        if (this.#turn) await this.#turn.message(message)
        else this.#between(message)
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    const why = failure ?? new Error('Claude Code ended')
    // Closed on purpose: nothing went wrong.
    if (!this.#closed) {
      console.error(`Claude Agent: thread ${this.thread}'s Claude Code ended:`, why.message, this.stderr.slice(-5).join('\n'))
      this.#turn?.ended(why)
    }
    this.close()
  }

  /** A message with no turn to take it: Claude Code reporting in (expected), or doing work of its own, which goes. */
  #between(message: SDKMessage) {
    if (!WORK.has(message.type)) return
    console.error(`Claude Agent: thread ${this.thread}'s Claude Code started work of its own between turns (${message.type}): closing it`)
    this.close()
  }

  /** The turn this process works for, until `detach`. */
  attach(turn: TurnHandlers) {
    if (this.#idle) clearTimeout(this.#idle)
    this.#idle = undefined
    this.#turn = turn
    this.#free = new Promise((resolve) => { this.#freed = resolve })
  }

  /** Once no turn is attached: the one before has let go of it (or it closed). */
  get free() { return this.#free }

  /** The turn ended: wait for the next, for `idleMs` at most, then go. */
  detach(idleMs: number) {
    this.#turn = undefined
    this.#freed()
    if (this.#closed) return
    this.#idle = setTimeout(() => this.close(), idleMs)
    this.#idle.unref?.()
  }

  /** Give Claude Code a user message; its id (`uuid`), to know when it took it in (`command_lifecycle`). */
  send(content: Content): string {
    const uuid = randomUUID()
    this.#input.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null })
    return uuid
  }

  /** Ask Claude Code to stop its turn, as the user would: the messages it hadn't taken in yet, which it would still run. */
  async interrupt(): Promise<string[]> {
    const receipt = await this.#query.interrupt()
    return receipt?.still_queued ?? []
  }

  /** How full the session's context is, as Claude Code estimates it from its last request: tokens, of how many fit. */
  async context(): Promise<{ tokens: number; max: number }> {
    const usage = await this.#query.getContextUsage({ detail: 'summary' })
    return { tokens: usage.totalTokens, max: usage.maxTokens }
  }

  /** End it: Claude Code exits (its process group with it). Again does nothing. */
  close() {
    if (this.#closed) return
    this.#closed = true
    if (this.#idle) clearTimeout(this.#idle)
    this.#freed()
    this.#input.end()
    this.#query.close()
    this.#abort.abort()
    this.#onClosed(this)
  }
}

/** Each thread's running Claude Code, at most one. */
export class ClaudeProcesses {
  #running = new Map<string, ClaudeProcess>()

  /**
   * `thread`'s Claude Code for a turn: the one running, when it was started as this turn would start it (`key`), else a
   * new one (`make`), the old one closed.
   */
  async take(thread: string, key: string, make: (onClosed: (process: ClaudeProcess) => void) => ClaudeProcess): Promise<{ process: ClaudeProcess; reused: boolean }> {
    const running = this.#running.get(thread)
    // A turn stopped just now may still be letting go of it (its Claude Code ending the turn as asked).
    await running?.free
    if (running && !running.closed && running.key === key && this.#running.get(thread) === running) return { process: running, reused: true }
    running?.close()
    const made = make((process) => { if (this.#running.get(process.thread) === process) this.#running.delete(process.thread) })
    this.#running.set(thread, made)
    return { process: made, reused: false }
  }

  /** Whether `thread` has its Claude Code running. */
  has(thread: string) { return this.#running.has(thread) }

  /** End `thread`'s Claude Code, if it runs. */
  close(thread: string) { this.#running.get(thread)?.close() }

  /** End them all, and wait until they're gone. */
  async closeAll() {
    const all = [...this.#running.values()]
    for (const process of all) process.close()
    await Promise.all(all.map((process) => process.done))
  }
}
