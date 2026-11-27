// An extension's notice (`threads.notice`): an entry in the thread from it that starts no run, makes the thread unread
// with the notice's text for what it says, and tells the agent of it as context with its next turn.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, MESSAGE_ENTRY, NOTE_ENTRY, PROTOCOL_VERSION, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonApi } from '../src/index.ts'
import { noticeForAgent } from '../src/threads.ts'
import { until } from './until.ts'

const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-notice-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function open() {
  process.env.SUPEREGO_MODEL = 'faux'
  let api: DaemonApi | undefined
  const checks = defineDaemonExtension({ name: 'checks', title: 'Checks', setup(superego) { api = superego } })
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: join(dir, 'home'), defaultCwd: dir, extensions: [checks] })
  const server = await listen(daemon, join(dir, 'home', 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'home', 'superego.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, api: api!, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

type Entry = { kind: string; data?: Record<string, unknown>; model?: { role: string; content: { type: string; text?: string }[] }[] }
const info = async (peer: RpcPeer, id: string) => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)!
const entries = async (peer: RpcPeer, id: string) => (await peer.call<{ value: { entries: Entry[] } }>('thread.watch', { thread: id })).value.entries
const answers = async (peer: RpcPeer, id: string) => (await entries(peer, id)).filter((e) => e.model?.[0]?.role === 'assistant')

it('tells the user without a run: unread, saying it, the agent told with its next turn as context', async () => {
  const { peer, api, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'hello' })
  await until(async () => (await info(peer, thread.id)).status.state === 'done')
  await peer.call('thread.seen', { thread: thread.id })
  expect((await info(peer, thread.id)).status.state).toBe('idle')

  const actions = [{ label: 'Fix it', send: 'Fix the failing checks.', style: 'primary' as const }, { label: 'Rerun', action: 'checks.rerun', params: { pr: 12 } }]
  await api.threads.notice(thread.id, { text: 'Checks **failed** on #12: lint.', kind: 'checks.failed', data: { pr: 12 }, actions })
  // Unread, saying what the notice says; no run.
  await until(async () => (await info(peer, thread.id)).status.state === 'done')
  expect((await info(peer, thread.id)).status).toEqual({ state: 'done', msg: 'Checks failed on #12: lint.' })
  expect(await answers(peer, thread.id)).toHaveLength(1)
  const notice = (await entries(peer, thread.id)).at(-1)!
  expect(notice.kind).toBe(NOTE_ENTRY)
  expect(notice.data).toEqual({ text: 'Checks **failed** on #12: lint.', kind: 'checks.failed', data: { pr: 12 }, actions, by: 'checks' })
  // The agent's: whose it is, and that it's no message from the user.
  expect(notice.model).toMatchObject([{ role: 'user', content: [{ type: 'text', text: noticeForAgent('Checks', 'Checks **failed** on #12: lint.') }] }])
  expect(noticeForAgent('Checks', 'x')).toMatch(/^<notice from="Checks">\nx\n<\/notice>\n\(.*not a message from them\.\)$/)

  // Told something else, or nothing: `agent`.
  await api.threads.notice(thread.id, { text: 'Merged.', agent: 'PR #12 was merged.' })
  await api.threads.notice(thread.id, { text: 'Deploy started.', agent: false })
  const [told, quiet] = (await entries(peer, thread.id)).slice(-2)
  expect(told!.model![0]!.content[0]!.text).toContain('PR #12 was merged.')
  expect(quiet!.model).toBeUndefined()

  // The next turn answers the user's message, and says what the run did, not the notice.
  await peer.call('thread.send', { thread: thread.id, text: 'go on' })
  await until(async () => (await answers(peer, thread.id)).length === 2)
  await until(async () => (await info(peer, thread.id)).status.state === 'done')
  expect((await info(peer, thread.id)).status.msg).toBe('echo: go on')
  const all = await entries(peer, thread.id)
  expect(all.map((e) => e.kind).slice(-5)).toEqual([NOTE_ENTRY, NOTE_ENTRY, NOTE_ENTRY, MESSAGE_ENTRY, 'pi.assistant'])
  await close()
})

it('refuses a notice without words, or to an archived thread', async () => {
  const { peer, api, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
  await expect(api.threads.notice(thread.id, { text: '  ' })).rejects.toMatchObject({ kind: 'invalid' })
  await peer.call('thread.archive', { thread: thread.id })
  await expect(api.threads.notice(thread.id, { text: 'Merged.' })).rejects.toMatchObject({ kind: 'archived' })
  await close()
})
