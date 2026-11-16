import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Hello, type Json, type Notifications, type ThreadInfo } from '@superego/protocol'
import paneUi from '../src/daemon.ts'
import { SPECS, type ThreadSpecs } from '../src/shared.ts'

const app = defineApp({ name: 'test', id: 'paneuitest' })
let dir: string
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
const call = (id: string, name: string, args: Json) => turn([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')

/** A thread's scope of the panes' UI, as a pane watches it: what it is now, as told. */
async function watch(peer: Awaited<ReturnType<typeof open>>['peer'], scope: string) {
  // Heard from before the watch answers: what it says may come with the answer.
  const told: Notifications['value.changed'][] = []
  peer.on('value.changed', (params: Notifications['value.changed']) => { told.push(params) })
  const watched = await peer.call<{ sub: string; value: ThreadSpecs | null }>('value.watch', { key: SPECS, scope })
  return { get now() { return (told.filter((t) => t.sub === watched.sub).at(-1)?.value ?? watched.value) as ThreadSpecs | null } }
}

async function open() {
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, extensions: [paneUi] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.extensions.map((e) => e.name)).toContain('pane-ui')
  return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

it('opens a ui pane with { id }, updates its UI by id, and keeps it across a restart', async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-pane-ui-'))
  const first: Json[] = [{ type: 'markdown', text: 'Building…' }]
  const second: Json[] = [{ type: 'kv', items: [{ label: 'Tests', value: 'passing' }] }, { type: 'buttons', buttons: [{ id: 'ship', label: 'Ship it' }] }]
  await writeFile(join(dir, 'turns.jsonl'), [
    call('call-1', 'open_ui', { id: 'status', title: 'Build', blocks: first }),
    call('call-2', 'update_ui', { id: 'status', title: 'Build: green', blocks: second }),
    call('call-3', 'update_ui', { id: 'nope', blocks: first }),
    turn([{ type: 'text', text: 'All green.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.PANEUITEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.PANEUITEST_REPLAY_SPEED = '0'
  let { peer, close } = await open()

  const thread = await peer.call<ThreadInfo>('thread.start', {})
  await peer.call('thread.send', { thread: thread.id, text: 'build it' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')

  const [info] = await peer.call<ThreadInfo[]>('thread.list', {})
  expect(info!.panes).toEqual([{ id: expect.any(String), kind: 'ui', title: 'Build: green', params: { id: 'status' } }])
  // In the thread's own scope, read from the thread as it's watched; another's has none.
  const specs = await watch(peer, thread.id)
  await until(() => specs.now !== null)
  expect(specs.now!.status).toMatchObject({ id: 'status', title: 'Build: green', blocks: second })
  const another = await watch(peer, 'another')
  await new Promise((r) => setTimeout(r, 100))
  expect(another.now).toBeNull()

  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
  const results = value.entries.map((e) => e.model?.[0] as { role?: string; isError?: boolean; content?: { text?: string }[] } | undefined).filter((m) => m?.role === 'toolResult')
  expect(results.map((r) => r!.isError)).toEqual([false, false, true])
  expect(results[2]!.content![0]!.text).toContain('No UI pane "nope"')

  // The pane's UI is still there after the daemon restarts.
  await close()
  ;({ peer, close } = await open())
  // Kept with the thread: read again as a pane watches it.
  const kept = await watch(peer, thread.id)
  await until(() => kept.now !== null)
  expect(kept.now!.status?.blocks).toEqual(second)
  await close()
  delete process.env.PANEUITEST_MODEL
})
