// The images a model is sent, each in a shape its provider takes. Every request's images are fitted to the model's limits
// (pi-ai's catalog: `inputLimits`) as it's sent, whatever put them in the history: a pasted attachment, `read`, an MCP
// tool's result, or a message kept from before. The history keeps each image as it came, and the files on disk stay
// whole: only what's sent changes, the same way every time, so a prompt cache still matches.
//
// What can't be sent goes as a line saying so in its place: an image that can't be made to fit, the oldest beyond what
// one request may carry (in number, or in bytes: request-budget.ts, which also cuts old tool output short when the
// words alone are too many), and one the provider refused anyway. A refused request is asked again once without the image
// it refused (the one its error names, else the newest), which is left out from then on: kept in `images-left-out.json`,
// so a thread whose history holds such an image goes on. A request refused as too large (413) is asked again once, within
// the lower budget it taught. What was left out for good, and why, and a budget learned, are said on the answer as
// diagnostics (IMAGE_OMITTED, REQUEST_SHRUNK), for the thread's transcript to tell the user (core-extensions.ts).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendAssistantMessageDiagnostic, createAssistantMessageEventStream, isContextOverflow,
  type Api, type AssistantMessage, type AssistantMessageEvent, type ImageContent, type Message, type Model, type TextContent,
} from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai/models'
import { DEFAULT_IMAGE_LIMITS, type ImageLimits, type ImageProcessor, type PreparedImage } from '@earendil-works/pi-durable/tools'
import { sniff } from './image-kind.ts'
import { imageName, RequestLimits, SLACK, tooManyBytes, trimToolOutput } from './request-budget.ts'
import { wrapStreams } from './provider-streams.ts'
import { writeAtomic } from './write-atomic.ts'

/** The diagnostic an answer carries for each image left out of its request for good. */
export const IMAGE_OMITTED = 'superego.image_omitted'
/** What it says of one. */
export type OmittedImage = { reason: string; bytes: number; width?: number; height?: number; refused?: boolean }
/** The diagnostic an answer carries when its provider refused the request as too large, and a lower budget was learned. */
export const REQUEST_SHRUNK = 'superego.request_shrunk'
/** What it says: the provider, the size of the request it refused, and the budget its requests are kept within now. */
export type ShrunkRequest = { provider: string; bytes: number; limit: number }

/** Where a model's catalog entry doesn't say: Anthropic's. */
const PER_REQUEST = 100
/** How much of the images fitted is kept for the next request, as base64. */
const CACHE_BYTES = 128 * 1024 * 1024
/** How much of an image's base64 is read for its header. */
const HEAD = 4 * Math.ceil(64 * 1024 / 3)
/** The formats every provider takes as they are. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

type Block = TextContent | ImageContent
/** An image of the history, where it is and what it is. */
type Found = { message: number; block: number; image: ImageContent; hash: string; bytes: number; width?: number; height?: number }
/** One sent, as it was sent. */
type Sent = Found & { data: string }

export const mb = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`
/** What an image is, for a line about it: "2.3 MB, 2560×12000". */
export const describe = ({ bytes, width, height }: { bytes: number; width?: number; height?: number }) =>
  [mb(bytes), ...(width && height ? [`${width}×${height}`] : [])].join(', ')
const placeholder = (why: string, image: Found): TextContent => ({ type: 'text', text: `[image omitted: ${why} (${describe(image)})]` })

/** The images a model takes, the limits its catalog entry gives (else the defaults). */
function limitsOf(model: Model<Api>) {
  const images = model.inputLimits?.images
  return {
    resize: { ...DEFAULT_IMAGE_LIMITS, ...images?.resize } as ImageLimits,
    perRequest: images?.maxPerRequest ?? PER_REQUEST,
  }
}

/**
 * The provider's reason, when a request it refused is refused for an image: a 400 that speaks of one. A request too
 * large (413) is not: it's asked again within a lower budget (request-budget.ts).
 */
export function refusalOf(message: AssistantMessage): string | undefined {
  if (message.stopReason !== 'error' || isContextOverflow(message)) return undefined
  const text = message.errorMessage ?? ''
  if (!/^\s*400\b|invalid_request/.test(text) || !/image|media|pixel|base64/i.test(text)) return undefined
  // "400 {"type":"error","error":{"message":"messages.3.content.2.image.source.base64.data: …"}}": its message, without the path.
  const json = text.slice(text.indexOf('{'))
  let said: string | undefined
  try { said = (JSON.parse(json) as { error?: { message?: string } }).error?.message } catch { /* not JSON: the text as it is */ }
  return (said ?? text.replace(/^\d{3}\s+/, '')).replace(/^[\w.[\]]+:\s*/, '').trim().replace(/\.$/, '') || text
}

/**
 * The images a refused request's error names, by the path it gives into the request it was sent (Anthropic's
 * `messages.3.content.2.image…`, OpenAI's `input[3].content[2]…`): the image data under where the path leads.
 */
export function namedIn(error: string, payload: unknown, sent: readonly Sent[]): Sent[] {
  const found = new Set<Sent>()
  for (const [path] of error.matchAll(/\b(?:messages|input|contents)(?:\.\d+|\[\d+\]|\.[A-Za-z_]\w*)+/g)) {
    let node = payload
    for (const key of path.split(/[.[\]]+/).filter(Boolean)) {
      const next = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
      if (next === undefined) break
      node = next
    }
    if (node === payload) continue
    for (const text of strings(node)) {
      const data = text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text
      for (const image of sent) if (image.data === data) found.add(image)
    }
  }
  return [...found]
}
/** Whether an answer so far has anything in it. */
const shows = (partial: AssistantMessage) => partial.content.some((c) => c.type === 'toolCall' || (c.type === 'text' ? c.text : c.thinking))

function* strings(node: unknown, depth = 0): Generator<string> {
  if (typeof node === 'string') yield node
  else if (node && typeof node === 'object' && depth < 8) for (const value of Object.values(node)) yield* strings(value, depth + 1)
}

/** The images a model has been refused, kept by their hash (of the base64 the history holds) with why. */
class LeftOut {
  readonly #path: string
  readonly #reasons: Map<string, string>
  #saving: Promise<unknown> = Promise.resolve()
  constructor(dataDir: string) {
    this.#path = join(dataDir, 'images-left-out.json')
    let kept: Record<string, string> = {}
    try { kept = JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, string> } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`${this.#path} couldn't be read, so images left out before are tried again:`, error)
    }
    this.#reasons = new Map(Object.entries(kept))
  }
  reason(hash: string) { return this.#reasons.get(hash) }
  add(hash: string, reason: string) {
    this.#reasons.set(hash, reason)
    const json = JSON.stringify(Object.fromEntries(this.#reasons), null, 2)
    this.#saving = this.#saving.then(() => writeAtomic(this.#path, json)).catch((error: unknown) => {
      console.error(`${this.#path} couldn't be saved: the images left out are left out until the daemon restarts.`, error)
    })
  }
  /** Resolves once what's being saved is. */
  settled() { return this.#saving }
}

export type ModelImages = {
  /** `provider`, every request it's sent with its images fitted, and asked again once without an image it refused. */
  wrap<T extends Provider>(provider: T): T
  /** What `read` prepares its images with. */
  processor: ImageProcessor
  /** Resolves once the images left out, and the budgets learned, are saved. */
  settled(): Promise<unknown>
}

export function createModelImages(dataDir: string, processor: ImageProcessor): ModelImages {
  const leftOut = new LeftOut(dataDir)
  const limits = new RequestLimits(dataDir)
  /** Images fitted before, by their hash and the limits: the newest kept, up to CACHE_BYTES. */
  const cache = new Map<string, PreparedImage | null>()
  let cached = 0
  const remember = (key: string, image: PreparedImage | null) => {
    cache.set(key, image)
    cached += image?.data.length ?? 0
    for (const [old, was] of cache) {
      if (cached <= CACHE_BYTES) break
      cache.delete(old)
      cached -= was?.data.length ?? 0
    }
  }

  /** An image in a shape `limits` allow: as it is when it is one already, else scaled down (undefined when it can't be). */
  async function fit(image: Found, limits: ImageLimits): Promise<PreparedImage | undefined> {
    const { width, height } = image
    if (INLINE.has(image.image.mimeType) && width && height && width <= limits.maxWidth && height <= limits.maxHeight && image.image.data.length <= limits.maxBytes) {
      return { data: image.image.data, mimeType: image.image.mimeType }
    }
    const key = `${image.hash}:${limits.maxWidth}x${limits.maxHeight}:${limits.maxBytes}`
    if (cache.has(key)) {
      const again = cache.get(key)!
      cache.delete(key)
      cache.set(key, again)
      return again ?? undefined
    }
    // A Uint8Array of its own: a Buffer's slice (which a worker processor sends on) shares Node's pool, and can't be moved.
    const bytes = Buffer.from(image.image.data, 'base64')
    const prepared = await processor.prepare(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), image.image.mimeType, limits).catch((error: unknown) => {
      console.error(`An image (${describe(image)}) couldn't be fitted to the model:`, error)
      return undefined
    })
    remember(key, prepared ?? null)
    return prepared
  }

  /**
   * `messages` as they're sent to `model` (its system prompt and tools among them), within `budget` bytes: every image
   * in a shape it takes, or a line in its place; the newest kept, as many as fit; old tool output cut short when the
   * words alone don't fit. `omit` hears of one left out for good as it can't be fitted; `sent` is the images sent,
   * oldest first; `bytes`, about how big the request is.
   */
  async function forModel(model: Model<Api>, history: readonly Message[], omit: (image: Found, reason: string) => void, budget: number): Promise<{ messages: Message[]; sent: Sent[]; bytes: number }> {
    // Its words: everything but the images' data.
    const words = JSON.stringify(history, (key, value: unknown) => key === 'data' && typeof value === 'string' ? '' : value).length
    let room = budget - SLACK - words
    // The words alone too many: every image goes (below), then the oldest tool output is cut short.
    const trimmed = room < 0 ? trimToolOutput(history, -room) : { messages: [...history], saved: 0 }
    const messages = trimmed.messages
    room += trimmed.saved
    const bytes = budget - room
    // A model without image input gets pi-ai's own placeholder.
    if (!model.input.includes('image')) return { messages, sent: [], bytes }
    const found: Found[] = []
    messages.forEach((message, m) => {
      if ((message.role !== 'user' && message.role !== 'toolResult') || typeof message.content === 'string') return
      message.content.forEach((block, b) => {
        if (block.type !== 'image') return
        const bytes = Buffer.byteLength(block.data, 'base64')
        // Its header says what it is: the first 64 KB are enough (a JPEG whose size comes later is fitted to find out).
        const kind = sniff(Buffer.from(block.data.slice(0, HEAD), 'base64'))
        found.push({ message: m, block: b, image: block, hash: createHash('sha256').update(block.data).digest('hex').slice(0, 32), bytes, ...(kind?.width && kind.height ? { width: kind.width, height: kind.height } : {}) })
      })
    })
    if (!found.length) return { messages, sent: [], bytes }
    const { resize, perRequest } = limitsOf(model)
    const instead = new Map<Found, Block[]>()
    const ready: { image: Found; sent: Sent; scaled?: PreparedImage['resized'] }[] = []
    for (const image of found) {
      const refused = leftOut.reason(image.hash)
      if (refused !== undefined) { instead.set(image, [placeholder(refused, image)]); continue }
      const prepared = await fit(image, resize)
      if (!prepared) {
        const reason = "it couldn't be made to fit the model"
        omit(image, reason)
        instead.set(image, [placeholder(reason, image)])
        continue
      }
      ready.push({ image, sent: { ...image, data: prepared.data }, ...(prepared.resized ? { scaled: prepared.resized } : {}) })
      instead.set(image, [{ type: 'image', data: prepared.data, mimeType: prepared.mimeType }])
    }
    // The newest are sent, as many as one request takes and as fit in it; from the first that doesn't, none older.
    let count = 0
    let full = false
    const sent: Sent[] = []
    for (const { image, sent: one, scaled } of [...ready].reverse()) {
      if (count >= perRequest) { instead.set(image, [placeholder('more images than one request to the model may carry', image)]); continue }
      if (full || one.data.length > room) {
        full = true
        instead.set(image, [{ type: 'text', text: `[image removed: ${imageName(messages, image.message)} (${describe(image)}), to keep the request small enough for the model]` }])
        continue
      }
      count++
      room -= one.data.length
      sent.unshift(one)
      const { from, to } = scaled ?? {}
      if (from && to) instead.get(image)!.push({ type: 'text', text: `[image scaled from ${from.width}×${from.height} to ${to.width}×${to.height} to fit the model]` })
    }
    const blocks = new Map(found.map((image) => [`${image.message}:${image.block}`, instead.get(image)!]))
    return {
      messages: messages.map((message, m) => (message.role !== 'user' && message.role !== 'toolResult') || typeof message.content === 'string' || !message.content.some((b) => b.type === 'image') ? message
        : { ...message, content: message.content.flatMap((block, b) => blocks.get(`${m}:${b}`) ?? [block]) } as Message),
      sent,
      bytes: budget - room,
    }
  }

  function wrap<T extends Provider>(provider: T): T {
    return wrapStreams(provider, (call, model, context, options) => {
      const out = createAssistantMessageEventStream()
      const omitted: OmittedImage[] = []
      const omit = (image: Found, reason: string, refused = false) => {
        leftOut.add(image.hash, reason)
        console.warn(`Left an image (${describe(image)}) out of what ${model.provider}/${model.id} is sent: ${reason}`)
        omitted.push({ reason, bytes: image.bytes, ...(image.width ? { width: image.width, height: image.height } : {}), ...(refused ? { refused } : {}) })
      }
      let shrunk: ShrunkRequest | undefined
      const said = new WeakSet<AssistantMessage>()
      const tell = (message: AssistantMessage) => {
        if (said.has(message)) return message
        said.add(message)
        for (const details of omitted) appendAssistantMessageDiagnostic(message, { type: IMAGE_OMITTED, timestamp: Date.now(), details })
        if (shrunk) appendAssistantMessageDiagnostic(message, { type: REQUEST_SHRUNK, timestamp: Date.now(), details: shrunk })
        return message
      }
      let budget = limits.of(model.provider, model.inputLimits?.maxRequestBytes)
      void (async () => {
        for (let refusedOne = false; ;) {
          const { messages, sent, bytes } = await forModel(model, context.messages, omit, budget)
          let payload: unknown
          const events = call(model, { ...context, messages }, {
            ...options,
            async onPayload(body, model) {
              payload = (await options?.onPayload?.(body, model)) ?? body
              return payload
            },
          })
          // Held until the answer shows something, so a refusal can be asked again without the stream having begun twice.
          const held: AssistantMessageEvent[] = []
          let started = false
          let again = false
          for await (const event of events) {
            if (!started && event.type !== 'done' && event.type !== 'error' && !shows(event.partial)) { held.push(event); continue }
            if (!started && event.type === 'error') {
              const reason = refusedOne ? undefined : refusalOf(event.error)
              const named = reason === undefined ? [] : namedIn(event.error.errorMessage ?? '', payload, sent)
              const culprits = named.length ? named : sent.slice(-1)
              if (reason !== undefined && culprits.length) {
                for (const image of culprits) omit(image, `refused by the model: ${reason}`, true)
                refusedOne = again = true
                break
              }
              // Too large: asked again within the lower budget the refusal teaches, if it teaches one.
              if (!shrunk && tooManyBytes(event.error)) {
                const size = payload === undefined ? bytes : Buffer.byteLength(JSON.stringify(payload))
                const limit = limits.refused(model.provider, size, budget)
                if (limit !== undefined) {
                  console.warn(`${model.provider}/${model.id} refused a request of ${mb(size)} as too large: its requests are kept within ${mb(limit)} from now on.`)
                  shrunk = { provider: model.provider, bytes: size, limit }
                  budget = limit
                  again = true
                  break
                }
              }
            }
            if (!started) { started = true; for (const event of held) out.push(event) }
            if (event.type === 'done') tell(event.message)
            if (event.type === 'error') tell(event.error)
            out.push(event)
          }
          if (again) continue
          out.end(tell(await events.result()))
          return
        }
      })().catch((error: unknown) => {
        // Unexpected: fitting the images, or the provider's call itself, threw. The request fails with it, as any failure
        // of the provider's would.
        console.error(`A request to ${model.provider}/${model.id} failed before it was sent:`, error)
        const message: AssistantMessage = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error', errorMessage: `Its images couldn't be prepared: ${error instanceof Error ? error.message : String(error)}`, timestamp: Date.now(),
        }
        out.push({ type: 'error', reason: 'error', error: tell(message) })
        out.end(message)
      })
      return out
    })
  }

  return { wrap, processor, settled: () => Promise.all([leftOut.settled(), limits.settled()]) }
}
