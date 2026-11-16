import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Hello, type Json, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import tasks from '../src/daemon.ts'

const app = defineApp({ name: 'test', id: 'taskstest' })
let dir: string
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })

it('gives the agent the tools, and task_start a task_id that is its own call', async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-tasks-'))
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'call-1', name: 'task_start', arguments: { title: 'Looking around' } }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'call-2', name: 'task_finish', arguments: { task_id: 'call-1', status: 'success', outcome: 'Saw it all' } }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.TASKSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.TASKSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, extensions: [tasks] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.extensions.map((e) => e.name)).toContain('tasks')

  const thread = await peer.call<ThreadInfo>('thread.start', {})
  await peer.call('thread.send', { thread: thread.id, text: 'look around' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  // Its done status says what the run did: the last task's outcome.
  expect((await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status).toEqual({ state: 'done', msg: 'Saw it all' })
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
  const results = value.entries.map((entry) => entry.model?.[0] as { role?: string; isError?: boolean; content?: { text?: string }[] } | undefined)
    .filter((message) => message?.role === 'toolResult')
  expect(results.map((message) => message!.isError)).toEqual([false, false])
  expect(JSON.parse(results[0]!.content![0]!.text!)).toEqual({ task_id: 'call-1', title: 'Looking around' })

  socket.destroy(); server.close(); await daemon.close()
  delete process.env.TASKSTEST_MODEL
})

it('is listed in Settings → Extensions, and switched off there the agent goes without it', async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-tasks-'))
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'call-1', name: 'task_start', arguments: { title: 'Looking around' } }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.TASKSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.TASKSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, extensions: [tasks] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  const { value: settings } = await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
  const section = settings.sections.find((s) => s.id === 'extensions')!
  expect(section.settings.map((s) => s.key)).toEqual(['extensions.coding-tools', 'extensions.panes', 'extensions.agents-md', 'extensions.tasks'])
  expect(section.settings.at(-1)).toMatchObject({ title: 'Task reporting', default: true })
  expect(settings.sections.find((s) => s.id === 'profiles')?.data).toEqual([])

  await peer.call('settings.set', { key: 'extensions.tasks', value: false })
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  await peer.call('thread.send', { thread: thread.id, text: 'look around' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  // Without tasks, the answer's first sentence says what the run did.
  expect((await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status).toEqual({ state: 'done', msg: 'Done.' })
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
  const result = value.entries.map((entry) => entry.model?.[0] as { role?: string; isError?: boolean } | undefined).find((m) => m?.role === 'toolResult')
  expect(result?.isError).toBe(true)

  socket.destroy(); server.close(); await daemon.close()
  delete process.env.TASKSTEST_MODEL
})
