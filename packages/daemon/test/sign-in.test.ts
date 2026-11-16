// A provider that rejects the machine's credentials: threads wait for sign-in instead of failing one by one, new turns
// for it don't ask it again, and new credentials take them on from where they stopped.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import type { ConversationView, LiveState } from '@earendil-works/pi-durable'
import { AUTH_REJECTED, defineApp, PROTOCOL_VERSION, type Notifications, type ProviderRejection, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { heardCredentials, heldRejections } from '../src/agent-settings.ts'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { until } from './until.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

const APP = defineApp({ name: 'superego', id: 'signintest' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-signin-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.SIGNINTEST_MODEL })

/** The scripted model's key: one starting with "reject" makes it answer as Anthropic does to a key it doesn't know. */
const storeKey = (key: string) => writeFile(join(dir, 'auth.json'), JSON.stringify({ faux: { type: 'api_key', key } }))

const open = async () => {
  process.env.SIGNINTEST_MODEL = 'faux'
  const daemon = await openDaemon({ app: APP, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 'd.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'd.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

const list = (peer: RpcPeer) => peer.call<ThreadInfo[]>('thread.list', {})
const statusOf = async (peer: RpcPeer, id: string) => (await list(peer)).find((t) => t.id === id)!.status
const waiting = async (peer: RpcPeer, ids: string[]) => (await list(peer)).filter((t) => ids.includes(t.id) && t.status.state === 'blocked' && t.status.kind === 'auth').length === ids.length

/** The value naming the rejected providers, as it is now. */
async function rejected(peer: RpcPeer) {
  let value: ProviderRejection[] = []
  const { sub, value: first } = await peer.call<{ sub: string; value: ProviderRejection[] }>('value.watch', { key: AUTH_REJECTED })
  value = first
  const off = peer.on('value.changed', (params: Notifications['value.changed']) => { if (params.sub === sub) value = params.value as ProviderRejection[] })
  return { now: () => value, stop: async () => { off(); await peer.call('unwatch', { sub }) } }
}

/** A thread's run state as its transcript has it. */
async function live(peer: RpcPeer, id: string) {
  let view: ConversationView | undefined
  const watched = await peer.call<{ sub: string; value: ConversationView }>('thread.watch', { thread: id })
  view = watched.value
  const off = peer.on('watch.ops', ({ sub, ops }: Notifications['watch.ops']) => { if (sub === watched.sub) view = applyImmutable(view!, ops as Op[]) })
  return { now: () => view!.docs['pi.live'] as LiveState | undefined, stop: async () => { off(); await peer.call('unwatch', { sub: watched.sub }) } }
}

it('waits for sign-in on a rejected key, fails new turns fast, and goes on when the key changes', async () => {
  await storeKey('reject-old')
  const { peer, close } = await open()
  const value = await rejected(peer)
  const ids: string[] = []
  for (const prompt of ['one', 'two', 'three']) ids.push((await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt })).id)

  // Each fails on the key, and waits: the same reason for all, not an error each.
  await until(() => waiting(peer, ids))
  expect(await statusOf(peer, ids[0]!)).toEqual({ state: 'blocked', kind: 'auth', msg: 'faux rejected the API key' })
  await until(() => value.now().length === 1 && value.now()[0]!.threads.length === 3)
  expect(value.now()[0]).toMatchObject({ provider: 'faux', name: 'faux', summary: 'faux rejected the API key', detail: expect.stringContaining('invalid x-api-key'), since: expect.any(Number) })

  // A new turn for the provider fails without asking it, and waits too.
  const fourth = (await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'four' })).id
  await until(() => waiting(peer, [fourth]))
  const its = await live(peer, fourth)
  await until(() => Boolean(its.now()?.runFailure))
  expect(its.now()!.runFailure!.detail).toMatch(/^Waiting for sign-in: faux rejected the API key/)
  await its.stop()
  await until(() => value.now()[0]?.threads.length === 4)

  // New credentials: every waiting thread goes on from where it stopped, and answers.
  await storeKey('good')
  await until(async () => (await list(peer)).filter((t) => t.status.state === 'done').length === 4)
  await until(() => value.now().length === 0)
  await value.stop()
  await close()
})

it('waits again when the new key is rejected too, without retrying on its own', async () => {
  await storeKey('reject-1')
  const { peer, close } = await open()
  const ids = [(await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'one' })).id, (await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'two' })).id]
  await until(() => waiting(peer, ids))
  const value = await rejected(peer)
  const firstSince = value.now()[0]!.since
  const watched = await live(peer, ids[0]!)
  const firstTask = watched.now()!.runFailure!.taskId

  // Another bad key: retried once, rejected again, and waiting again, rejected since then.
  const heard = heardCredentials.length
  await storeKey('reject-2')
  await until(() => watched.now()?.runFailure?.taskId !== firstTask && !watched.now()?.run)
  await until(() => waiting(peer, ids))
  await until(() => value.now()[0]?.threads.length === 2 && value.now()[0]!.since > firstSince)
  // Rejected by the provider, or, when the other thread's retry was rejected first, refused without asking it.
  expect(watched.now()!.runFailure!.detail).toMatch(/invalid x-api-key|^Waiting for sign-in: /)

  // And it stays so: the change was heard once, and only a change heard (or someone asking) retries.
  const settled = watched.now()!.runFailure!.taskId
  expect(heardCredentials.slice(heard)).toEqual([['faux']])
  expect((await statusOf(peer, ids[0]!))).toMatchObject({ state: 'blocked', kind: 'auth' })
  expect(watched.now()!.run).toBeUndefined()

  // Asked: retried, and (the key still bad) waiting again.
  expect(await peer.call('auth.retry', {})).toEqual({ retried: 2 })
  await until(() => watched.now()?.runFailure?.taskId !== settled && !watched.now()?.run)
  await until(() => waiting(peer, ids))
  await watched.stop()
  await value.stop()
  await close()
})

it('keeps waiting across a restart, and retries what changed meanwhile', async () => {
  await storeKey('reject-1')
  let daemon = await open()
  const id = (await daemon.peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'one' })).id
  await until(() => waiting(daemon.peer, [id]))
  await daemon.close()

  daemon = await open()
  expect(await statusOf(daemon.peer, id)).toMatchObject({ state: 'blocked', kind: 'auth' })
  await daemon.close()

  await storeKey('good')
  daemon = await open()
  await until(async () => (await statusOf(daemon.peer, id)).state === 'done')
  await daemon.close()
})

it('takes a bad key written just before the turns it stops as the one rejected: no retry, one rejection', async () => {
  await storeKey('good')
  const { peer, close } = await open()
  const value = await rejected(peer)
  // The turns run, and are rejected, before the daemon hears auth.json change.
  const heard = heardCredentials.length
  await storeKey('reject-new')
  const ids = [(await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'one' })).id, (await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'two' })).id]
  await until(() => waiting(peer, ids))
  await until(() => value.now()[0]?.threads.length === 2)
  const { since } = value.now()[0]!
  // Heard, and not taken for new credentials: the value as it is once the daemon has acted on it.
  await until(() => heardCredentials.length > heard)
  await value.stop()
  const after = await rejected(peer)
  expect(after.now()).toHaveLength(1)
  expect(after.now()[0]).toMatchObject({ since, threads: expect.arrayContaining(ids) })
  expect(after.now()[0]!.retrying).toBeUndefined()
  await after.stop()
  await close()
})

it('retries a turn rejected for a key replaced while it ran, with the new one', async () => {
  await storeKey('reject-held')
  const { peer, close } = await open()
  const id = (await peer.call<ThreadInfo>('thread.start', { cwd: dir, prompt: 'one' })).id
  // Asked with the old key; a new one is stored, and heard of, before the old one's rejection comes back.
  await until(() => heldRejections.length === 1)
  const heard = heardCredentials.length
  await storeKey('good')
  await until(() => heardCredentials.length > heard)
  heldRejections.splice(0).forEach((reject) => reject())
  await until(async () => (await statusOf(peer, id)).state === 'done')
  await close()
})
