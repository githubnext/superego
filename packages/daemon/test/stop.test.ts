// Stopping a thread stops what waits its turn too: the user's queued messages come back to write again, in order with
// their files; others' are withdrawn, said in the transcript and told to the extensions (`stopped`).
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { defineApp, NOTE_ENTRY, obj, PROTOCOL_VERSION, type MessageOrigin, type ReturnedMessage, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonApi } from '../src/index.ts'
import { until } from './until.ts'

const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-stop-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** A daemon whose model calls `wait`, which runs until it's stopped; `heard`, what `stopped` was told. */
async function open() {
  const recording = join(dir, 'wait.jsonl')
  const turn = (message: unknown) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message }) + '\n'
  writeFileSync(recording, turn({ role: 'assistant', content: [{ type: 'toolCall', id: 'wait-1', name: 'wait', arguments: {} }], stopReason: 'toolUse' }))
  process.env.SUPEREGO_MODEL = 'replay:' + recording
  process.env.SUPEREGO_REPLAY_SPEED = '0'
  let api: DaemonApi | undefined
  const heard: { thread: string; withdrawn: MessageOrigin[] }[] = []
  const waiter = defineDaemonExtension({
    name: 'waiter',
    setup(superego) {
      api = superego
      superego.thread({ stopped: (thread, { withdrawn }) => { heard.push({ thread: thread.id, withdrawn }) } })
      superego.agent(defineExtension({
        name: 'waiter',
        tools: [defineTool({
          name: 'wait', description: 'Waits until stopped.', parameters: obj({}), replay: 'safe',
          async execute(_args, _api, context) {
            while (!context.abortSignal?.aborted) await new Promise((r) => setTimeout(r, 20))
            throw new Error('stopped')
          },
        })],
      }))
    },
  })
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: join(dir, 'home'), defaultCwd: dir, extensions: [waiter] })
  const server = await listen(daemon, join(dir, 'home', 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'home', 'superego.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, api: api!, heard, close: async () => { socket.destroy(); server.close(); await daemon.close(); delete process.env.SUPEREGO_REPLAY_SPEED } }
}

const state = async (peer: RpcPeer, id: string) => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)?.status.state
const entries = async (peer: RpcPeer, id: string) => (await peer.call<{ value: { entries: { kind: string; data?: { text?: string }; model?: unknown[] }[] } }>('thread.watch', { thread: id })).value.entries
const inbox = async (peer: RpcPeer, id: string) => ((await peer.call<{ value: { docs: Record<string, unknown> } }>('thread.watch', { thread: id })).value.docs['pi.inbox'] as { items?: unknown[] } | undefined)?.items ?? []

it("gives back the user's queued messages, in order with their files, and withdraws another thread's, saying so", async () => {
  const { peer, api, heard, close } = await open()
  const lead = await peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'Lead' })
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'go' })
  await until(async () => await state(peer, thread.id) === 'working')
  const plan = { name: 'plan.md', mimeType: 'text/markdown', data: Buffer.from('# plan\n').toString('base64') }
  const dot = { name: 'dot.png', mimeType: 'image/png', data: Buffer.from('not really a png').toString('base64') }
  await peer.call('thread.send', { thread: thread.id, text: 'queued-one', whenBusy: 'followUp', attachments: [plan] })
  await api.threads.send(thread.id, 'queued-lead', { from: lead.id })
  await peer.call('thread.send', { thread: thread.id, text: 'queued-two', whenBusy: 'steer', attachments: [dot] })
  await until(async () => (await inbox(peer, thread.id)).length === 3)

  const { returned } = await peer.call<{ returned: ReturnedMessage[] }>('thread.stop', { thread: thread.id })
  expect(returned.map((m) => m.attachments)).toEqual([[plan], [dot]])
  const texts = returned.map((m) => typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('|'))
  expect(texts[0]).toMatch(/^queued-one\|<attachment name="plan\.md"/)
  expect(texts[1]).toMatch(/^queued-two\|<attachment name="dot\.png"/)
  // The image's pixels come back as its file, not twice.
  expect(JSON.stringify(returned[1]!.content)).not.toContain(dot.data)

  expect(await inbox(peer, thread.id)).toEqual([])
  await until(async () => (await entries(peer, thread.id)).some((e) => e.kind === NOTE_ENTRY))
  const after = await entries(peer, thread.id)
  expect(after.filter((e) => e.kind === NOTE_ENTRY).map((e) => e.data?.text)).toEqual(['Stopped: 1 queued message from Lead withdrawn.'])
  // None of them went in.
  for (const said of ['queued-one', 'queued-lead', 'queued-two']) expect(JSON.stringify(after.map((e) => e.model))).not.toContain(said)
  await until(() => heard.length === 1)
  expect(heard).toEqual([{ thread: thread.id, withdrawn: [{ by: 'waiter', from: lead.id }] }])
  await close()
})

it('stops a thread with nothing queued: nothing given back, nothing said, no one told', async () => {
  const { peer, heard, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'go' })
  await until(async () => await state(peer, thread.id) === 'working')
  expect(await peer.call('thread.stop', { thread: thread.id })).toEqual({ returned: [] })
  await until(async () => await state(peer, thread.id) !== 'working')
  expect((await entries(peer, thread.id)).some((e) => e.kind === NOTE_ENTRY)).toBe(false)
  expect(heard).toEqual([])
  await close()
})
