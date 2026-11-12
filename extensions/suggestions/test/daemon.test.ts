import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Notifications, type ThreadInfo } from '@superego/protocol'
import suggestions from '../src/daemon.ts'
import { NEXT, type Suggested } from '../src/shared.ts'

const app = defineApp({ name: 'test', id: 'suggeststest' })
let dir: string
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

it('asks the thread\'s model for next prompts once it answers, and drops them when the thread moves on', async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-suggest-'))
  // The faux model echoes the last user message: the agent echoes the prompt, and the side call echoes the transcript,
  // whose last JSON array is the suggestions.
  process.env.SUGGESTSTEST_MODEL = 'faux'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, extensions: [suggestions] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  const watched = await peer.call<{ sub: string; value: Record<string, Suggested> }>('value.watch', { key: NEXT })
  let next = watched.value
  peer.on('value.changed', ({ sub, value }: Notifications['value.changed']) => { if (sub === watched.sub) next = value as Record<string, Suggested> })

  const thread = await peer.call<ThreadInfo>('thread.create', {})
  await peer.call('thread.submit', { id: thread.id, text: '["Run the tests", "Commit this"]' })
  await until(() => next[thread.id] !== undefined)
  expect(next[thread.id]!.prompts).toEqual(['Run the tests', 'Commit this'])

  // Its next message takes them away; this answer suggests nothing (its last array is empty), so none come back.
  await peer.call('thread.submit', { id: thread.id, text: '[]' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done' && next[thread.id] === undefined)

  socket.destroy(); server.close(); await daemon.close()
  delete process.env.SUGGESTSTEST_MODEL
})
