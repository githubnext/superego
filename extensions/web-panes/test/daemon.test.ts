// web-panes' daemon half against a real daemon: Preview and Artifact told to the agent while the machine has it on,
// and opened for it; neither once it's off.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type ThreadInfo } from '@superego/protocol'
import webPanes from '../src/daemon.ts'

const app = defineApp({ name: 'test', id: 'webpanestest' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-web-panes-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.WEBPANESTEST_MODEL; delete process.env.WEBPANESTEST_REPLAY_SPEED })

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
type Result = { role?: string; isError?: boolean; content?: { text?: string }[] }

it('tells the agent of Preview and Artifact and opens them, unless the machine has web-panes off', async () => {
  const open = (id: string) => turn([{ type: 'toolCall', id, name: 'pane_open', arguments: { kind: 'preview', params: { url: 'http://localhost:3000' } } }], 'toolUse')
  const stop = turn([{ type: 'text', text: 'There.' }], 'stop')
  await writeFile(join(dir, 'turns.jsonl'), [open('on'), stop, open('off'), stop].join('\n') + '\n')
  process.env.WEBPANESTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.WEBPANESTEST_REPLAY_SPEED = '0'
  const data = join(dir, 'data')
  await mkdir(data)
  const daemon = await openDaemon({ app, dataDir: data, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [webPanes] })
  const server = await listen(daemon, join(data, 's.sock'))
  const { peer, socket } = await connectSocket(join(data, 's.sock'))
  const hello = await peer.call<{ features: string[] }>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.features).toContain('ext:web-panes')
  const run = async () => {
    const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'show me' })
    await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!.status.state === 'done')
    const { value } = await peer.call<{ value: { entries: { model?: unknown[] }[] } }>('thread.watch', { thread: thread.id })
    const result = value.entries.map((e) => e.model?.[0] as Result | undefined).find((m) => m?.role === 'toolResult')!
    const panes = (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!.panes ?? []
    return { told: JSON.stringify(value), result, panes }
  }
  const on = await run()
  expect(on.told).toContain('\\"preview\\": { url }')
  expect(on.told).toContain('\\"artifact\\": { path }')
  expect(on.result.isError).toBeFalsy()
  expect(on.panes).toMatchObject([{ kind: 'preview', params: { url: 'http://localhost:3000' } }])
  await peer.call('settings.set', { key: 'extensions.web-panes', value: false })
  const off = await run()
  expect(off.told).not.toContain('\\"artifact\\"')
  expect(off.result.isError).toBe(true)
  expect(off.panes).toEqual([])
  socket.destroy(); server.close(); await daemon.close()
})
