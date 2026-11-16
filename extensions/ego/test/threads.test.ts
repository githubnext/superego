// Ego and other threads: the work it hands to a thread of its own, and the settings it changes itself. (thread_archive
// refusing Ego is the threads extension's test.)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Json, type RpcPeer, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { ego as egoExtension } from '../src/daemon.ts'

const app = defineApp({ name: 'test', id: 'threadstest' })
const extensions = [egoExtension()]
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-threads-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.THREADSTEST_MODEL })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
/** Ego's thread as the window follows it: null until it's first opened. */
const egoOf = async (peer: RpcPeer) => (await peer.call<ThreadInfo[]>('thread.list', { hidden: true })).find((t) => t.owner === 'ego') ?? null

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
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  const ego = await peer.call<ThreadInfo>('ego.ask', { prompt: 'turn on web access' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).length === 1)
  const [started] = await peer.call<ThreadInfo[]>('thread.list', {})
  expect(started).toMatchObject({ title: 'Web', cwd: project, session: { root: project } })
  expect(started!.parent).toBeUndefined()
  await until(async () => (await egoOf(peer))!.status.state === 'done')
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
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })

  await peer.call<ThreadInfo>('ego.ask', { prompt: 'serve the app on port 8888' })
  await until(async () => (await egoOf(peer))!.status.state === 'done')
  expect((await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})).value.values['web.port']).toBe(8888)
  expect(await peer.call('thread.list', {})).toEqual([])

  socket.destroy(); server.close(); await daemon.close()
})

it("starts no thread for an outside agent through Ego, unless the machine lets outside agents; the user's own turn still does", async () => {
  const project = join(dir, 'project')
  await mkdir(project)
  const start = (title: string) => turn([{ type: 'toolCall', id: title, name: 'thread_start', arguments: { prompt: 'Do it', title, cwd: project } }], 'toolUse')
  await writeFile(join(dir, 'turns.jsonl'), [
    // An outside agent asks: refused, and Ego relays why.
    start('For the agent'), turn([{ type: 'text', text: 'Refused.' }], 'stop'),
    // The user asks in the window, in the same conversation: started (the thread it started answers too: either text).
    start('For the user'), turn([{ type: 'text', text: 'Started.' }], 'stop'), turn([{ type: 'text', text: 'Done.' }], 'stop'),
    // An outside agent's message straight to Ego's thread: refused too.
    start('Sent straight'), turn([{ type: 'text', text: 'Refused.' }], 'stop'),
    // Once the machine lets outside agents start threads: started.
    start('Allowed'), turn([{ type: 'text', text: 'Started.' }], 'stop'), turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.THREADSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.THREADSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  const titles = async () => (await peer.call<ThreadInfo[]>('thread.list', {})).map((t) => t.title).sort()
  const answered = async (count: number) => until(async () => {
    const ego = await egoOf(peer)
    if (ego?.status.state !== 'done') return false
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: ego.id })
    return value.entries.filter((e) => (e.model?.[0] as { role?: string } | undefined)?.role === 'toolResult').length === count
  })
  const results = async (id: string) => (await peer.call<{ value: ConversationView }>('thread.watch', { id })).value.entries
    .filter((e) => (e.model?.[0] as { role?: string } | undefined)?.role === 'toolResult').map((e) => e.model![0] as { isError: boolean; content: { text: string }[] })

  const ego = await peer.call<ThreadInfo>('action.run', { id: 'ego.ask', params: { prompt: 'start a thread for me' }, exposure: 'mcp' })
  await answered(1)
  expect(await titles()).toEqual([])
  const [refused] = await results(ego.id)
  expect(refused).toMatchObject({ isError: true })
  expect(refused!.content[0]!.text).toMatch(/outside agents can't start threads on this machine[\s\S]*Settings → Outside agents → Can start threads/)
  // Ego was told who was asking.
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: ego.id })
  expect(JSON.stringify(value.entries.find((e) => (e.model?.[0] as { role?: string } | undefined)?.role === 'user'))).toContain('<outside-agent>')

  await peer.call('thread.submit', { id: ego.id, text: 'start one for me, the user' })
  await answered(2)
  expect(await titles()).toEqual(['For the user'])
  // Done before the next, so each takes the turn meant for it.
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')

  await peer.call('action.run', { id: 'thread.submit', params: { id: ego.id, text: 'start another' }, exposure: 'mcp' })
  await answered(3)
  expect(await titles()).toEqual(['For the user'])
  expect((await results(ego.id))[2]).toMatchObject({ isError: true })

  await peer.call('settings.set', { key: 'mcp.startThreads', value: true })
  await peer.call('action.run', { id: 'ego.ask', params: { prompt: 'and now?' }, exposure: 'mcp' })
  await answered(4)
  expect(await titles()).toEqual(['Allowed', 'For the user'])

  socket.destroy(); server.close(); await daemon.close()
}, 30_000)
