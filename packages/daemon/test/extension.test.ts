// The daemon half of the extension API, as an extension sees it: methods (reads) apart from actions, threads by id, and
// pane kinds told to the agent.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, obj, PROTOCOL_VERSION, str, type ActionInfo, type Hello, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonExtension } from '../src/index.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-extension-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function open(extensions: DaemonExtension[]) {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, hello, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 30)) }
  throw new Error('timed out')
}

it('serves an extension method as a plain read: called by name, checked, not an action', async () => {
  const notes = defineDaemonExtension({
    name: 'notes',
    setup(superego) {
      superego.method('notes.folder', async ({ id }) => ({ cwd: (await superego.threads.get(id)).cwd }), { params: obj({ id: str() }) })
    },
  })
  const { peer, hello, close } = await open([notes])
  expect(hello.methods).toContain('notes.folder')
  const thread = await peer.call<ThreadInfo>('thread.create', {})
  expect(await peer.call('notes.folder', { id: thread.id })).toEqual({ cwd: dir })
  await expect(peer.call('notes.folder', {})).rejects.toMatchObject({ kind: 'invalid_params' })
  await expect(peer.call('notes.folder', { id: '999' })).rejects.toMatchObject({ kind: 'not_found' })
  // A read: not offered as an action, not in the log.
  expect((await peer.call<ActionInfo[]>('action.list', {})).map((a) => a.id)).not.toContain('notes.folder')
  expect(JSON.stringify(await peer.call('action.log', {}))).not.toContain('notes.folder')
  await close()
})

it("tells the agent the pane kinds extensions describe, beside the core's", async () => {
  const notes = defineDaemonExtension({ name: 'notes', setup(superego) { superego.pane('graph', 'the notes as a graph; no params') } })
  const { peer, close } = await open([notes])
  const thread = await peer.call<ThreadInfo>('thread.create', { prompt: 'hi' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  const { value } = await peer.call<{ value: { entries: { model?: { role?: string; content?: unknown }[] }[]; docs: Record<string, unknown> } }>('thread.watch', { id: thread.id })
  const prompt = JSON.stringify(value)
  expect(prompt).toContain('\\"graph\\": the notes as a graph; no params')
  expect(prompt).toContain('\\"diff\\": the changes in the working folder')
  await close()
})
