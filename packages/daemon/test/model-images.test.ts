import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxProvider, normalizeContext, type Api, type AssistantMessage, type Context, type Message, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import { omittedNote } from '../src/core-extensions.ts'
import { sniff } from '../src/image-kind.ts'
import { createModelImages, IMAGE_OMITTED, refusalOf, type ModelImages, type OmittedImage } from '../src/model-images.ts'
import { png } from './image-fixtures.ts'

let dir: string
let made: ModelImages[]
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-images-')); made = [] })
afterEach(async () => {
  await Promise.all(made.map((images) => images.settled()))
  await rm(dir, { recursive: true, force: true })
})
const modelImages = async () => {
  const images = createModelImages(dir, await createNodePhotonImages({ worker: false }))
  made.push(images)
  return images
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
/** A PNG whose header says what it is, and nothing more: no provider can read it. */
const cutShort = b64(png(10, 10).subarray(0, 33))
const user = (...content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]): Message => ({ role: 'user', content, timestamp: 0 })
const image = (data: string) => ({ type: 'image' as const, data, mimeType: 'image/png' })
const text = (value: string) => ({ type: 'text' as const, text: value })

/**
 * A provider like Anthropic: it builds its request (for `onPayload`) with the images as `source.data`, and refuses one
 * over 8000 px a side, or one it can't read, by its path in that request. `refuse` replaces what it refuses.
 */
function anthropicLike(refuse?: (payload: Payload) => string | undefined) {
  const faux = fauxProvider()
  const seen: Message[][] = []
  const step = async (context: Context, options: SimpleStreamOptions | undefined) => {
    faux.appendResponses([step])
    seen.push(context.messages)
    const payload: Payload = {
      messages: context.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : (m.content as { type: string; text?: string; data?: string }[]).map((b) => b.type === 'image' ? { type: 'image', source: { type: 'base64', data: b.data } } : b),
      })),
    }
    await options?.onPayload?.(payload, faux.getModel())
    const refused = (refuse ?? anthropicRefusal)(payload)
    if (refused) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: refused })
    return fauxAssistantMessage('ok')
  }
  faux.setResponses([step])
  return { provider: faux.provider, model: faux.getModel(), seen }
}
type Payload = { messages: { role: string; content: unknown }[] }
function anthropicRefusal(payload: Payload) {
  for (const [m, message] of payload.messages.entries()) {
    if (!Array.isArray(message.content)) continue
    for (const [b, block] of (message.content as { type: string; source?: { data: string } }[]).entries()) {
      if (block.type !== 'image') continue
      const bytes = Buffer.from(block.source!.data, 'base64')
      const kind = sniff(bytes)
      const problem = kind?.width && kind.height && Math.max(kind.width, kind.height) > 8000 ? 'At least one of the image dimensions exceed max allowed size: 8000 pixels'
        : bytes.lastIndexOf('IEND') < 0 ? 'Could not process image' : undefined
      if (problem) return `400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.${m}.content.${b}.image.source.base64.data: ${problem}"}}`
    }
  }
  return undefined
}

const ask = async (provider: ReturnType<typeof anthropicLike>['provider'], model: Model<Api>, messages: Message[]) => {
  const events: string[] = []
  const stream = provider.streamSimple(model, normalizeContext({ messages }), {})
  for await (const event of stream) events.push(event.type)
  return { events, answer: await stream.result() }
}
const omittedOf = (answer: AssistantMessage) => (answer.diagnostics ?? []).filter((d) => d.type === IMAGE_OMITTED).map((d) => d.details as OmittedImage)
const contentOf = (message: Message) => message.content as { type: string; text?: string; data?: string }[]

it('scales an image too large for the model down before it is sent, and leaves the history as it is', async () => {
  const images = await modelImages()
  const { provider, model, seen } = anthropicLike()
  const tall = b64(png(100, 9000))
  const history = [user(text('look'), image(tall))]
  const { answer } = await ask(images.wrap(provider), model, history)
  expect(answer.stopReason).toBe('stop')
  expect(seen).toHaveLength(1)
  const sent = contentOf(seen[0]![0]!)
  expect(sent.map((b) => b.type)).toEqual(['text', 'image', 'text'])
  expect(sniff(Buffer.from(sent[1]!.data!, 'base64'))).toMatchObject({ height: 2000 })
  expect(sent[2]!.text).toMatch(/^\[image scaled from 100×9000 to \d+×2000 to fit the model\]$/)
  expect(contentOf(history[0]!)[1]!.data).toBe(tall)
  expect(omittedOf(answer)).toEqual([])
})

it('sends an image that fits as it is', async () => {
  const images = await modelImages()
  const { provider, model, seen } = anthropicLike()
  const small = b64(png(40, 30))
  await ask(images.wrap(provider), model, [user(text('look'), image(small))])
  expect(contentOf(seen[0]![0]!)).toEqual([text('look'), image(small)])
})

it('asks again once without an image the provider refused, with a line in its place, and says so on the answer', async () => {
  const images = await modelImages()
  const { provider, model, seen } = anthropicLike()
  const fine = b64(png(40, 30))
  const history = [user(text('first'), image(fine)), user(text('what is this?'), image(cutShort)), user(text('and now?'))]
  const { events, answer } = await ask(images.wrap(provider), model, history)
  expect(answer.stopReason).toBe('stop')
  // The refusal isn't passed on: the stream is the answer's alone.
  expect(events).not.toContain('error')
  expect(seen).toHaveLength(2)
  // The image it named is left out; the other and every word the user wrote are sent.
  expect(contentOf(seen[1]![0]!)).toEqual([text('first'), image(fine)])
  expect(contentOf(seen[1]![1]!)).toEqual([text('what is this?'), text('[image omitted: refused by the model: Could not process image (33 bytes, 10×10)]')])
  expect(contentOf(seen[1]![2]!)).toEqual([text('and now?')])
  expect(omittedOf(answer)).toEqual([{ reason: 'refused by the model: Could not process image', bytes: 33, width: 10, height: 10, refused: true }])
  expect(omittedNote(omittedOf(answer))).toBe('Left an image out of what the model is sent (33 bytes, 10×10): refused by the model: Could not process image. Asked it again without it.')
})

it('goes on with a history that holds a refused image: left out at once, after a restart too, and said only the once', async () => {
  const history = [user(text('what is this?'), image(cutShort)), user(text('hello?'))]
  const first = await modelImages()
  await ask(first.wrap(anthropicLike().provider), anthropicLike().model, history)
  await first.settled()
  const again = await modelImages()
  const { provider, model, seen } = anthropicLike()
  const { answer } = await ask(again.wrap(provider), model, history)
  expect(answer.stopReason).toBe('stop')
  expect(seen).toHaveLength(1)
  expect(contentOf(seen[0]![0]!)[1]!.text).toMatch(/^\[image omitted: refused by the model/)
  expect(omittedOf(answer)).toEqual([])
})

it('leaves out the newest image when the refusal names none, and asks again only once', async () => {
  const images = await modelImages()
  const { provider, model, seen } = anthropicLike(() => '400 Invalid image.')
  const [older, newer] = [b64(png(40, 30)), b64(png(30, 40))]
  const { answer } = await ask(images.wrap(provider), model, [user(image(older)), user(text('and'), image(newer))])
  // Refused again: that's the answer, a failure as before.
  expect(seen).toHaveLength(2)
  expect(answer.stopReason).toBe('error')
  expect(contentOf(seen[1]![0]!)).toEqual([image(older)])
  expect(contentOf(seen[1]![1]!)[1]!.text).toBe('[image omitted: refused by the model: Invalid image (101 bytes, 30×40)]')
  expect(omittedOf(answer)).toHaveLength(1)
})

it('passes on a refusal that is not about images, untouched', async () => {
  const images = await modelImages()
  const { provider, model, seen } = anthropicLike(() => '400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.0.name: String should match pattern"}}')
  const { answer } = await ask(images.wrap(provider), model, [user(text('hi'), image(b64(png(4, 4))))])
  expect(seen).toHaveLength(1)
  expect(answer.stopReason).toBe('error')
  expect(refusalOf(answer)).toBeUndefined()
})

it('sends the newest images when there are more than one request may carry', async () => {
  const images = await modelImages()
  const { provider, model, seen } = anthropicLike()
  const few = { ...model, input: ['text', 'image'], inputLimits: { images: { maxPerRequest: 2 } } } as Model<Api>
  const [a, b, c] = [b64(png(4, 4)), b64(png(5, 5)), b64(png(6, 6))]
  await ask(images.wrap(provider), few, [user(image(a)), user(image(b)), user(image(c))])
  expect(contentOf(seen[0]![0]!)[0]!.text).toMatch(/^\[image omitted: more images than one request to the model may carry/)
  expect(contentOf(seen[0]![1]!)).toEqual([image(b)])
  expect(contentOf(seen[0]![2]!)).toEqual([image(c)])
})
