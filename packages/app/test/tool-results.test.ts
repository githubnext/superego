// Tool results as the transcript hands them to rows and extensions' views: against a real daemon, a failed call's
// text is its error message, not the `<harness>[error] …</harness>` the model was shown.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type ThreadInfo } from '@superego/protocol'
import { createRegistry } from '../src/renderer/registry.tsx'
import { toolRow } from '../src/renderer/lookups.ts'
import { DescribedCall, registerToolRows } from '../src/renderer/tool-rows.tsx'
import { toolResults } from '../src/renderer/transcript.tsx'

const app = defineApp({ name: 'test', id: 'toolresultstest' })
let dir: string
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.TOOLRESULTSTEST_MODEL })

const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
const read = (id: string, path: string) => turn([{ type: 'toolCall', id, name: 'read', arguments: { path } }], 'toolUse')

it("hands a failed call's row its error message alone, and a call's output as is", async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-tool-results-'))
  await writeFile(join(dir, 'here.txt'), 'hello\n')
  await writeFile(join(dir, 'turns.jsonl'), [read('ok', 'here.txt'), read('gone', 'missing.txt'), turn([{ type: 'text', text: 'Done.' }], 'stop')].join('\n') + '\n')
  process.env.TOOLRESULTSTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.TOOLRESULTSTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: join(dir, 'home'), defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  try {
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    const thread = await peer.call<ThreadInfo>('thread.start', {})
    await peer.call('thread.send', { thread: thread.id, text: 'read them' })
    for (let i = 0; ; i++) {
      if ((await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done') break
      if (i > 400) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 25))
    }
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
    // What the model saw: the error in the harness's wrapper.
    expect(JSON.stringify(value.entries)).toContain('<harness>')

    const results = toolResults(value.entries)
    expect(results.get('ok')).toMatchObject({ isError: false })
    expect(results.get('ok')!.text).toContain('hello')
    const failed = results.get('gone')!
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('missing.txt')
    expect(failed.text).not.toMatch(/<\/?harness>|\[error\]/)

    // Its row says so, as drawn.
    const registry = createRegistry(app, [], registerToolRows)
    const machine = { id: 'local', label: 'This Mac', state: 'connected' } as never
    const row = renderToStaticMarkup(createElement(DescribedCall, {
      row: toolRow(registry, 'read', { machine: 'local', thread }),
      call: { machine, thread, call: { id: 'gone', name: 'read', arguments: { path: 'missing.txt' } }, result: failed, state: 'error' },
    }))
    expect(row).toContain('Read failed')
    expect(row).not.toContain('harness')
    expect(row).not.toContain('[error]')
  } finally {
    socket.destroy(); server.close(); await daemon.close()
  }
})
