import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxProvider, normalizeContext, type Api, type AssistantMessage, type Context, type Message, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import { omittedNote, shrunkNote } from '../src/core-extensions.ts'
import { sniff } from '../src/image-kind.ts'
import { createModelImages, IMAGE_OMITTED, refusalOf, REQUEST_SHRUNK, type ModelImages, type OmittedImage, type ShrunkRequest } from '../src/model-images.ts'
import { leaner } from '../src/request-budget.ts'
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

/** A request to `model` with a budget of `bytes`, as its catalog would give it. */
const within = (model: Model<Api>, bytes: number) => ({ ...model, input: ['text', 'image'], inputLimits: { maxRequestBytes: bytes } }) as Model<Api>
/** A screenshot's weight: a small PNG, `kb` KB long (padded past its end), sent as it is. */
const heavy = (kb: number) => b64(Buffer.concat([png(40, 30), Buffer.alloc(kb * 1024, kb % 251)]))

it('replaces the oldest images with a line naming them when a request is over its byte budget, keeping the newest', async () => {
  const images = await modelImages()
  const { provider, model, seen } = anthropicLike()
  const [first, second, third] = [heavy(300), heavy(301), heavy(302)]
  const call = (id: string, path: string): Message => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path } }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 0 })
  const result = (id: string, data: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [image(data)], isError: false, timestamp: 0 })
  const history = [user(text('look')), call('a', '/shots/first.png'), result('a', first), call('b', '/shots/second.png'), result('b', second), call('c', '/shots/third.png'), result('c', third)]
  // Room for two of them.
  await ask(images.wrap(provider), within(model, 1000 * 1024), history)
  const sent = seen[0]!
  expect(contentOf(sent[2]!)).toEqual([text(expect.stringMatching(/^\[image removed: first\.png \(\d+ KB, \d+×\d+\), to keep the request small enough for the model\]$/) as unknown as string)])
  expect(contentOf(sent[4]!)).toEqual([image(second)])
  expect(contentOf(sent[6]!)).toEqual([image(third)])
  // The history keeps them all.
  expect(contentOf(history[2]!)).toEqual([image(first)])
})

it('cuts old tool output short when the words alone are over the budget, the newest left whole', async () => {
  const images = await modelImages()
  const { provider, model, seen } = anthropicLike()
  const long = 'x'.repeat(60_000)
  const result = (id: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [text(long)], isError: false, timestamp: 0 })
  const history = [user(text('go')), result('a'), result('b'), user(text('1')), user(text('2')), user(text('3')), result('c')]
  await ask(images.wrap(provider), within(model, 100 * 1024), history)
  const sent = seen[0]!.map((m) => contentOf(m)[0]!.text!)
  expect(sent[1]!.length).toBeLessThan(3000)
  expect(sent[1]).toContain('characters of this tool output left out of the request')
  expect(sent[6]).toBe(long)
})

it('asks again within a lower budget when the provider refuses a request as too large, and keeps to it after', async () => {
  const images = await modelImages()
  // Like GitHub Copilot: anything over 700 KB is refused, whatever the catalog says.
  const { provider, model, seen } = anthropicLike((payload) => JSON.stringify(payload).length > 700 * 1024 ? '413 Request Entity Too Large\n' : undefined)
  const shots = [heavy(300), heavy(301), heavy(302)]
  const history = shots.map((shot, i) => user(text(`shot ${i}`), image(shot)))
  const { events, answer } = await ask(images.wrap(provider), within(model, 32 * 1024 * 1024), history)
  expect(answer.stopReason).toBe('stop')
  expect(events).not.toContain('error')
  expect(seen).toHaveLength(2)
  expect(contentOf(seen[1]![0]!)[1]!.text).toMatch(/^\[image removed: an attached image/)
  const shrunk = (answer.diagnostics ?? []).filter((d) => d.type === REQUEST_SHRUNK).map((d) => d.details as ShrunkRequest)
  expect(shrunk).toEqual([{ provider: model.provider, bytes: expect.any(Number) as number, limit: expect.any(Number) as number }])
  expect(shrunkNote(shrunk[0]!)).toMatch(/refused a request of .* as too large/)
  // Learned, after a restart too: the next request is sent small at once.
  await images.settled()
  const again = await modelImages()
  const next = anthropicLike((payload) => JSON.stringify(payload).length > 700 * 1024 ? '413 Request Entity Too Large\n' : undefined)
  const { answer: second } = await ask(again.wrap(next.provider), within(next.model, 32 * 1024 * 1024), history)
  expect(second.stopReason).toBe('stop')
  expect(next.seen).toHaveLength(1)
})

it('sends a lean thread only its newest images, naming the others', () => {
  const history = [user(image('a')), user(image('b')), user(text('and'), image('c'))]
  const sent = leaner(history)
  expect(contentOf(sent[0]!)).toEqual([text('[image removed: an attached image]')])
  expect(contentOf(sent[1]!)).toEqual([image('b')])
  expect(contentOf(sent[2]!)).toEqual([text('and'), image('c')])
})
