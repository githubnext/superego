import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Hello, type Json, type Notifications, type ThreadInfo } from '@superego/protocol'
import answerUi from '../src/daemon.ts'
import { ANSWER, ASKING, type Asking } from '../src/shared.ts'

const app = defineApp({ name: 'test', id: 'answeruitest' })
let dir: string
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
type Message = { role?: string; isError?: boolean; content?: { text?: string }[]; details?: unknown }
const toolResults = (view: ConversationView) => view.entries.map((entry) => entry.model?.[0] as Message | undefined).filter((m) => m?.role === 'toolResult')

async function start(turns: string[]) {
  dir = await mkdtemp(join(tmpdir(), 'superego-answer-ui-'))
  await writeFile(join(dir, 'turns.jsonl'), turns.join('\n') + '\n')
  process.env.ANSWERUITEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.ANSWERUITEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, extensions: [answerUi] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.extensions.map((e) => e.name)).toContain('answer-ui')
  const done = async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done'
  const view = async (id: string) => (await peer.call<{ value: ConversationView }>('thread.watch', { thread: id })).value
  const close = async () => { socket.destroy(); server.close(); await daemon.close(); delete process.env.ANSWERUITEST_MODEL }
  return { peer, done, view, close }
}

const BLOCKS: Json[] = [
  { type: 'markdown', text: 'Which layout?' },
  { type: 'choice', id: 'layout', options: [{ label: 'Grid', value: 'grid' }, { label: 'List', value: 'list', description: 'Denser' }] },
]

it('show_ui returns at once, with the whole UI in its details; bad blocks get errors to fix', async () => {
  const { peer, done, view, close } = await start([
    turn([{ type: 'toolCall', id: 'call-1', name: 'show_ui', arguments: { blocks: [{ type: 'markdown', txt: 'oops' }] } }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'call-2', name: 'show_ui', arguments: { title: 'Layouts', blocks: BLOCKS } }], 'toolUse'),
    turn([{ type: 'text', text: 'Pick one when you like.' }], 'stop'),
  ])
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  await peer.call('thread.send', { thread: thread.id, text: 'show me layouts' })
  await until(done)
  const [bad, good] = toolResults(await view(thread.id))
  expect(bad!.isError).toBe(true)
  expect(bad!.content![0]!.text).toContain('blocks[0].text: missing')
  expect(bad!.content![0]!.text).toContain('blocks[0].txt: unknown field')
  expect(good!.isError).toBe(false)
  expect(good!.details).toEqual({ title: 'Layouts', blocks: BLOCKS })
  await close()
})

it('ask_ui blocks the thread, takes an answer from any client, and returns values and the button', async () => {
  const { peer, done, view, close } = await start([
    turn([{ type: 'toolCall', id: 'call-1', name: 'ask_ui', arguments: { title: 'Pick a layout', blocks: BLOCKS } }], 'toolUse'),
    turn([{ type: 'text', text: 'Lists it is.' }], 'stop'),
  ])
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  // The thread's own scope; another's hears nothing.
  const watched = await peer.call<{ sub: string; value: Asking[] }>('value.watch', { key: ASKING, scope: thread.id })
  const other = await peer.call<{ sub: string; value: Asking[] }>('value.watch', { key: ASKING, scope: 'another' })
  let pending = watched.value
  const others: unknown[] = []
  peer.on('value.changed', ({ sub, value }: Notifications['value.changed']) => { if (sub === watched.sub) pending = value as Asking[]; if (sub === other.sub) others.push(value) })

  await peer.call('thread.send', { thread: thread.id, text: 'set it up' })
  await until(() => pending.length === 1)
  expect(pending[0]).toMatchObject({ id: 'call-1', thread: thread.id, title: 'Pick a layout', blocks: BLOCKS })
  expect((await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status).toEqual({ state: 'blocked', kind: 'question', msg: 'Pick a layout' })

  await expect(peer.call(ANSWER, { id: 'nope', values: {} })).rejects.toMatchObject({ kind: 'not_found' })
  await expect(peer.call(ANSWER, { id: 'call-1', values: ['x'] })).rejects.toMatchObject({ kind: 'invalid' })
  await peer.call(ANSWER, { id: 'call-1', values: { layout: 'list' }, button: 'submit' })
  await until(done)
  await until(() => pending.length === 0)
  expect(others).toEqual([])
  const value = await view(thread.id)
  const [result] = toolResults(value)
  expect(JSON.parse(result!.content![0]!.text!)).toEqual({ values: { layout: 'list' }, button: 'submit' })
  // Locked on the answer, with the UI it answered, after a reload too.
  expect(result!.details).toMatchObject({ id: 'call-1', title: 'Pick a layout', blocks: BLOCKS, answer: { values: { layout: 'list' }, button: 'submit' } })
  expect(JSON.stringify(value.entries)).toContain('Lists it is.')
  await close()
})

it('ask_ui takes an answer in words instead', async () => {
  const { peer, done, view, close } = await start([
    turn([{ type: 'toolCall', id: 'call-1', name: 'ask_ui', arguments: { blocks: BLOCKS } }], 'toolUse'),
    turn([{ type: 'text', text: 'Fine.' }], 'stop'),
  ])
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  await peer.call('thread.send', { thread: thread.id, text: 'set it up' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'blocked')
  expect((await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status).toMatchObject({ msg: 'Waiting for your answer' })
  await peer.call(ANSWER, { id: 'call-1', text: ' whatever is fastest ' })
  await until(done)
  const [result] = toolResults(await view(thread.id))
  expect(JSON.parse(result!.content![0]!.text!)).toEqual({ text: 'whatever is fastest' })
  await close()
})
