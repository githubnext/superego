import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Json, type Notifications, type ThreadInfo } from '@superego/protocol'
import askUser from '../src/daemon.ts'
import { ANSWER, PENDING, type Question } from '../src/shared.ts'

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
  const hello = await peer.call<{ features: string[] }>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.features).toContain('ext:ask-user')

  const watched = await peer.call<{ sub: string; value: Question[] }>('value.watch', { key: PENDING })
  let questions = watched.value
  peer.on('value.changed', ({ sub, value }: Notifications['value.changed']) => { if (sub === watched.sub) questions = value as Question[] })

  const thread = await peer.call<ThreadInfo>('thread.create', {})
  await peer.call('thread.submit', { id: thread.id, text: 'pick a colour' })
  await until(() => questions.length === 1)
  expect(questions[0]).toMatchObject({ thread: thread.id, question: 'Which colour?', options: [{ label: 'red' }, { label: 'blue', description: 'like the sky' }] })
  const blocked = (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!
  expect(blocked.status).toEqual({ state: 'blocked', kind: 'question', msg: 'Which colour?' })

  await expect(peer.call(ANSWER, { id: 'nope', answer: 'x' })).rejects.toMatchObject({ kind: 'not_found' })
  await peer.call(ANSWER, { id: questions[0]!.id, answer: 'blue' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  expect(questions).toEqual([])
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: thread.id })
  const text = JSON.stringify(value.entries)
  expect(text).toContain('The user answered: blue')
  expect(text).toContain('Blue it is.')

  socket.destroy(); server.close(); await daemon.close()
  delete process.env.ASKUSERTEST_MODEL
})
