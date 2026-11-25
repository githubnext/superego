// A profile's extension changing what each request to the model carries (`hook(GenerationTask, { beforeRequest })`),
// the transcript left as it was, and fitting an image as the core does (`superego.images.fit`), against a real daemon
// loading the profile through 'superego'.
import { afterEach, expect, it } from 'vitest'
import { testDaemon, type TestDaemon } from '../src/testing.ts'

let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

const PROFILE = `import { defineProfile } from 'superego'
export default defineProfile({ extensions: ['./shout.ts'] })
`
// Every user message sent upper-cased; and a method that fits an image with the core's fitting.
const SHOUT = `import { defineDaemonExtension, defineExtension, GenerationTask, hook } from 'superego'
export default defineDaemonExtension({
  name: 'shout', version: '1.0.0', api: '^5.12',
  setup(superego) {
    superego.method('shout.fit', (params) => superego.images.fit(params.image, params.limits))
    superego.agent(defineExtension({
      name: 'shout',
      hooks: [hook(GenerationTask, {
        beforeRequest({ messages }) {
          return { messages: messages.map((m) => m.role !== 'user' ? m
            : typeof m.content === 'string' ? { ...m, content: m.content.toUpperCase() }
            : { ...m, content: m.content.map((b) => b.type === 'text' ? { ...b, text: b.text.toUpperCase() } : b) }) }
        },
      })],
    }))
  },
})
`

it('sends each request as the hook changed it, and keeps the transcript as it was', async () => {
  daemon = await testDaemon({ model: 'echo', profile: { 'profile.ts': PROFILE, 'shout.ts': SHOUT } })
  const thread = await daemon.thread('quiet please')
  // The echo model answers with what it was sent.
  expect(thread.status.msg).toBe('echo: QUIET PLEASE')
  expect(await daemon.transcript(thread.id)).toContain('"quiet please"')
})

it('fits an image within the limits it is given', async () => {
  daemon = await testDaemon({ model: 'echo', profile: { 'profile.ts': PROFILE, 'shout.ts': SHOUT } })
  await daemon.thread()
  // A 1×1 PNG: already within any limits, so as it is.
  const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  expect(await daemon.call('shout.fit', { image: { data: dot, mimeType: 'image/png' } })).toEqual({ data: dot, mimeType: 'image/png' })
  // Not an image: none.
  expect(await daemon.call('shout.fit', { image: { data: Buffer.from('nope').toString('base64'), mimeType: 'image/png' } })).toBeNull()
})
