// extension.inspect, as `superego extensions` shows it: where each extension is from, how it stands and why, what it
// registered, who watches its values, each profile's load, and what a thread goes without and why.
import { afterEach, expect, it } from 'vitest'
import { defineDaemonExtension } from '../src/index.ts'
import { say, testDaemon, type TestDaemon } from '../src/testing.ts'
import type { ExtensionsReport } from '@superego/protocol'

let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

const profile = (queue: string) => ({
  'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./queue.ts'], without: ['bundled-extra'] })\n`,
  'queue.ts': queue,
})
const QUEUE = `import { defineDaemonExtension, defineAction } from 'superego'
export default defineDaemonExtension({ name: 'queue', version: '1.0.0', api: '^3', setup(superego) {
  superego.scopedValue('queue.items', [])
  superego.method('queue.read', () => null)
  superego.action(defineAction({ id: 'queue.show', title: 'Show', runs: 'machine', keys: 'mod+shift+q', run: () => null }))
  superego.view('queue.list', { title: 'Queue', context: 'thread', fits: ['beside'], value: 'queue.items' })
} })
`

it('reports what each extension is, has registered and has watched; and what a thread goes without, and why', async () => {
  const extra = defineDaemonExtension({ name: 'bundled-extra', version: '2.0.0', title: 'Extra', setup(superego) { superego.thread({ archived() {} }) } })
  daemon = await testDaemon({ extensions: [extra], profile: profile(QUEUE), model: [say('hi')] })
  const thread = await daemon.thread('hello')
  const watch = await daemon.watch('queue.items', { scope: thread.id })
  const report = await daemon.call<ExtensionsReport>('extension.inspect', { thread: thread.id })
  const queue = report.extensions.find((e) => e.name === 'queue')!
  expect(queue).toMatchObject({ version: '1.0.0', api: '^3', source: 'profile', state: 'set up', profiles: ['user:default'] })
  expect(queue.file).toMatch(/queue\.ts$/)
  expect(queue.registered).toMatchObject({
    values: ['queue.items (scoped)'], methods: ['queue.read'], actions: ['queue.show (mod+shift+q)'], views: ['queue.list (beside; from queue.items)'],
  })
  expect(queue.watches).toEqual([{ value: 'queue.items', whole: 0, scopes: 1 }])
  expect(report.extensions.find((e) => e.name === 'bundled-extra')).toMatchObject({ source: 'bundled', version: '2.0.0', registered: { 'thread hooks': ['archived'] } })
  expect(report.extensions.find((e) => e.name === 'coding-tools')).toMatchObject({ source: 'core' })
  expect(report.profiles).toEqual([expect.objectContaining({ name: 'default', scope: 'user', state: 'loaded' })])
  expect(report.thread).toMatchObject({ id: thread.id, profile: 'user:default' })
  expect(report.thread!.without).toContainEqual({ extension: 'bundled-extra', why: 'its profile default goes without it (without)' })
  await watch.stop()
})

it("says why one isn't set up: refused for the API it needs, or failed, with the profile it broke", async () => {
  daemon = await testDaemon({ profile: profile(QUEUE.replace("api: '^3'", "api: '^9'")) })
  await expect(daemon.reload()).rejects.toThrow(/needs extension API \^9/)
  let report = await daemon.call<ExtensionsReport>('extension.inspect')
  expect(report.extensions.find((e) => e.name === 'queue')).toMatchObject({ state: 'refused', error: expect.stringMatching(/needs extension API \^9, and this Superego has 3\.\d+\.\d+/) })
  expect(report.profiles).toEqual([expect.objectContaining({ name: 'default', state: 'failed', error: expect.stringMatching(/\^9/) })])
  // Fixed, and loaded: it's set up, and no longer reported as refused.
  await daemon.edit('queue.ts', QUEUE.replace("superego.method('queue.read', () => null)", "throw new Error('broke on purpose')"))
  await expect(daemon.reload()).rejects.toThrow(/broke on purpose/)
  report = await daemon.call<ExtensionsReport>('extension.inspect')
  expect(report.extensions.filter((e) => e.name === 'queue').map((e) => e.state)).toEqual(['failed'])
  await daemon.edit('queue.ts', QUEUE)
  await daemon.reload()
  report = await daemon.call<ExtensionsReport>('extension.inspect')
  expect(report.extensions.filter((e) => e.name === 'queue').map((e) => e.state)).toEqual(['set up'])
  expect(report.profiles[0]).toMatchObject({ state: 'loaded' })
})
