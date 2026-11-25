// How big a request to a model may be, in bytes, and what's left out of one to keep it so. Providers refuse a request
// whose body is too large (HTTP 413) whatever its tokens: GitHub Copilot's limit is far below Anthropic's or OpenAI's,
// and a few screenshots reach it. Token-based compaction doesn't see bytes (an image is a few hundred tokens and
// megabytes), so a thread whose newest stretch holds them would fail every request, compacted or not.
//
// So every request is fitted to a byte budget as it's sent (model-images.ts): the oldest images go first, then the
// bulk of old tool output. The budget is the model's (pi-ai's catalog: `inputLimits.maxRequestBytes`), else its
// provider's as known here (`PROVIDER_BYTES`), else Anthropic's; a provider that refuses a request as too large anyway
// teaches a lower one (`RequestLimits`), kept in `request-limits.json`. The history keeps everything: only what's sent
// changes.
//
// A thread can also be sent lean (`leaner`): only its newest images, and its old tool output cut short, as its own
// choice once it got stuck (`thread.retry` with `lean`).
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isContextOverflow, type AssistantMessage, type ImageContent, type Message, type TextContent } from '@earendil-works/pi-ai'
import type { ThreadFailure } from '@superego/protocol'
import { writeAtomic } from './write-atomic.ts'

/** Where a model's catalog entry doesn't say: Anthropic's limit. */
export const DEFAULT_REQUEST_BYTES = 32 * 1024 * 1024
/**
 * Providers whose limit is below that and that the catalog doesn't give. GitHub Copilot doesn't publish one: it refuses
 * requests of a few megabytes ("413 Request Entity Too Large"), and took those of about one.
 */
export const PROVIDER_BYTES: Record<string, number> = { 'github-copilot': 3 * 1024 * 1024 }
/** No refusal teaches a budget below this: one that small is a refusal for another reason. */
const LEAST = 256 * 1024
/** What a refused request teaches: this much of its size. */
const LEARN = 0.6
/** A request's envelope beyond its system prompt, tools and messages (the model, its options). */
export const SLACK = 16 * 1024

/** Whether a provider refused a request as too many bytes (413), not too many tokens. */
export function tooManyBytes(message: AssistantMessage) {
  if (message.stopReason !== 'error') return false
  const text = message.errorMessage ?? ''
  return /^\s*(?:[\w -]+ API error \()?413\b/i.test(text) || /request_too_large|request entity too large|payload too large|request exceeds the maximum size/i.test(text)
}

/**
 * What kind of failure a run's is, by what it said (`detail`): a request too large for the provider (in bytes, or in
 * tokens when compacting couldn't fix it), else any other.
 */
export function failureKind(detail: string | undefined): ThreadFailure['kind'] {
  const said = { stopReason: 'error', errorMessage: detail ?? '' } as AssistantMessage
  return detail && (tooManyBytes(said) || isContextOverflow(said)) ? 'too_large' : 'error'
}

/** The budgets providers taught by refusing requests as too large, by provider: kept across restarts. */
export class RequestLimits {
  readonly #path: string
  readonly #learned: Map<string, number>
  #saving: Promise<unknown> = Promise.resolve()
  constructor(dataDir: string) {
    this.#path = join(dataDir, 'request-limits.json')
    let kept: Record<string, number> = {}
    try { kept = JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, number> } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`${this.#path} couldn't be read, so what providers refused as too large is learned again:`, error)
    }
    this.#learned = new Map(Object.entries(kept).filter(([, bytes]) => Number.isFinite(bytes) && bytes >= LEAST))
  }
  /** A request's budget for `provider`: what it taught, else what's known of it, else `fallback` (the catalog's). */
  of(provider: string, fallback?: number) {
    const known = fallback ?? PROVIDER_BYTES[provider] ?? DEFAULT_REQUEST_BYTES
    return Math.min(known, this.#learned.get(provider) ?? Infinity)
  }
  /** `provider` refused a request of `bytes` as too large: the budget it teaches, or undefined when it teaches none lower than `now`. */
  refused(provider: string, bytes: number, now: number) {
    const lower = Math.max(LEAST, Math.floor(Math.min(bytes, now) * LEARN))
    if (lower >= now) return undefined
    this.#learned.set(provider, lower)
    const json = JSON.stringify(Object.fromEntries(this.#learned), null, 2)
    this.#saving = this.#saving.then(() => writeAtomic(this.#path, json)).catch((error: unknown) => {
      console.error(`${this.#path} couldn't be saved: the request budgets learned hold until the daemon restarts.`, error)
    })
    return lower
  }
  /** Resolves once what's being saved is. */
  settled() { return this.#saving }
}

/**
 * What an image in `messages` is, for the line that stands in for it: the file `read` read it from, else the tool that
 * gave it, else an image the user attached.
 */
export function imageName(messages: readonly Message[], index: number) {
  const message = messages[index]
  if (message?.role !== 'toolResult') return 'an attached image'
  for (let at = index - 1; at >= 0; at--) {
    const before = messages[at]
    if (before?.role !== 'assistant') continue
    const call = before.content.find((block) => block.type === 'toolCall' && block.id === message.toolCallId)
    if (call?.type !== 'toolCall') continue
    const args = call.arguments as Record<string, unknown>
    const path = [args.path, args.file, args.url].find((value) => typeof value === 'string' && value)
    return typeof path === 'string' ? basename(path) : `${message.toolName}'s image`
  }
  return `${message.toolName}'s image`
}

/** How much of a long tool output is kept: its start and end. */
const HEAD = 1536
const TAIL = 512
/** Tool output longer than this may be cut short. */
const LONG = 4096
/** The newest messages, whose tool output is never cut short: what the model is working on now. */
const RECENT = 4

/** `text` cut to its start and end, with a line saying what's gone between. */
export function cutShort(text: string) {
  const gone = text.length - HEAD - TAIL
  return `${text.slice(0, HEAD)}\n[… ${gone.toLocaleString('en')} characters of this tool output left out of the request to keep it small enough for the model …]\n${text.slice(-TAIL)}`
}

/**
 * `messages` with old tool output cut short, the oldest first, until `over` bytes are saved (all of it, `Infinity`). The
 * newest few messages are left whole. Returns the messages and the bytes saved.
 */
export function trimToolOutput(messages: readonly Message[], over: number): { messages: Message[]; saved: number } {
  let saved = 0
  const out = [...messages]
  for (let m = 0; m < out.length - RECENT && saved < over; m++) {
    const message = out[m]!
    if (message.role !== 'toolResult' || !message.content.some((b) => b.type === 'text' && b.text.length > LONG)) continue
    const content = message.content.map((block): TextContent | ImageContent => {
      if (block.type !== 'text' || block.text.length <= LONG || saved >= over) return block
      const text = cutShort(block.text)
      saved += JSON.stringify(block.text).length - JSON.stringify(text).length
      return { ...block, text }
    })
    out[m] = { ...message, content }
  }
  return { messages: out, saved }
}

/** How many of a lean thread's images are sent: its newest. */
export const LEAN_IMAGES = 2

/**
 * `messages` as a lean thread sends them: only its newest images (`LEAN_IMAGES`), each older one a line naming it, and
 * all its old tool output cut short.
 */
export function leaner(messages: readonly Message[]): Message[] {
  let kept = 0
  const out = [...messages]
  for (let m = out.length - 1; m >= 0; m--) {
    const message = out[m]!
    if ((message.role !== 'user' && message.role !== 'toolResult') || typeof message.content === 'string') continue
    if (!message.content.some((b) => b.type === 'image')) continue
    const content: (TextContent | ImageContent)[] = []
    for (const block of [...message.content].reverse()) {
      if (block.type !== 'image') content.unshift(block)
      else if (kept < LEAN_IMAGES) { kept++; content.unshift(block) }
      else content.unshift({ type: 'text', text: `[image removed: ${imageName(messages, m)}]` })
    }
    out[m] = { ...message, content } as Message
  }
  return trimToolOutput(out, Infinity).messages
}
