import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Hello, type Json, type Notifications, type ThreadInfo } from '@superego/protocol'
import askUser from '../src/daemon.ts'
import { ANSWER, ASKING, type Question } from '../src/shared.ts'

const app = defineApp({ name: 'test', id: 'askusertest' })
let dir: string
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })

it('asks, blocks the thread, takes an answer from any client, and carries on', async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-ask-'))
  // The model asks once, then answers with what it was told.
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'call-1', name: 'ask_user', arguments: { question: 'Which colour?', options: ['red', { label: 'blue', description: 'like the sky' }] } }], 'toolUse'),
    turn([{ type: 'text', text: 'Blue it is.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.ASKUSERTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.ASKUSERTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, extensions: [askUser] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.extensions.map((e) => e.name)).toContain('ask-user')

  const thread = await peer.call<ThreadInfo>('thread.start', {})
  // The thread's own questions, in its scope; another's scope hears nothing.
  const own = await peer.call<{ sub: string; value: Question[] }>('value.watch', { key: ASKING, scope: thread.id })
  const other = await peer.call<{ sub: string; value: Question[] }>('value.watch', { key: ASKING, scope: 'another' })
  let mine = own.value
  const others: unknown[] = []
  peer.on('value.changed', ({ sub, value }: Notifications['value.changed']) => { if (sub === own.sub) mine = value as Question[]; if (sub === other.sub) others.push(value) })
  await peer.call('thread.send', { thread: thread.id, text: 'pick a colour' })
  await until(() => mine.length === 1)
  expect(mine[0]).toMatchObject({ thread: thread.id, question: 'Which colour?', options: [{ label: 'red' }, { label: 'blue', description: 'like the sky' }] })
  const blocked = (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!
  expect(blocked.status).toEqual({ state: 'blocked', kind: 'question', msg: 'Which colour?' })

  await expect(peer.call(ANSWER, { id: 'nope', answer: 'x' })).rejects.toMatchObject({ kind: 'not_found' })
  await peer.call(ANSWER, { id: mine[0]!.id, answer: 'blue' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  await until(() => mine.length === 0)
  expect(others).toEqual([])
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
  const text = JSON.stringify(value.entries)
  expect(text).toContain('The user answered: blue')
  expect(text).toContain('Blue it is.')

  socket.destroy(); server.close(); await daemon.close()
  delete process.env.ASKUSERTEST_MODEL
})
