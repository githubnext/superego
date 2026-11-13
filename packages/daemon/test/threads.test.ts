import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { defineApp, PROTOCOL_VERSION, type Json, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'

const app = defineApp({ name: 'test', id: 'threadstest' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-threads-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.THREADSTEST_MODEL })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })

it('lets Ego hand work to a thread of its own: top-level in its project, listed, not under Ego', async () => {
  const project = join(dir, 'project')
  await mkdir(project)
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_start', arguments: { prompt: 'Turn on web access', title: 'Web', cwd: project } }], 'toolUse'),
    turn([{ type: 'text', text: 'Started it.' }], 'stop'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  const ego = await peer.call<ThreadInfo>('thread.meta', { prompt: 'turn on web access' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).length === 1)
  const [started] = await peer.call<ThreadInfo[]>('thread.list', {})
  expect(started).toMatchObject({ title: 'Web', cwd: project, session: { root: project } })
  expect(started!.parent).toBeUndefined()
  await until(async () => (await peer.call<{ value: ThreadInfo }>('meta.watch', {})).value.status.state === 'done')
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: ego.id })
  expect(JSON.stringify(value.entries)).toContain(`Started [Web](thread:${started!.id})`)

  socket.destroy(); server.close(); await daemon.close()
})

it("lets Ego change this machine's settings itself", async () => {
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'superego_set_setting', arguments: { key: 'web.port', value: 8888 } }], 'toolUse'),
    turn([{ type: 'text', text: 'Set.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  await peer.call<ThreadInfo>('thread.meta', { prompt: 'serve the app on port 8888' })
  await until(async () => (await peer.call<{ value: ThreadInfo }>('meta.watch', {})).value.status.state === 'done')
  expect((await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})).value.values['web.port']).toBe(8888)
  expect(await peer.call('thread.list', {})).toEqual([])

  socket.destroy(); server.close(); await daemon.close()
})
