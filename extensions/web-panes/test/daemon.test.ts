// web-panes against a real daemon: declared by the window, Preview and Artifact are told to the agent while the machine
// has it on, and opened for it; neither once it's off.
import { expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { callTool, say, testDaemon } from '@superego/sdk/testing'
import { about } from '../src/shared.ts'

type Result = { role?: string; isError?: boolean }

it('tells the agent of Preview and Artifact and opens them, unless the machine has web-panes off', async () => {
  const open = callTool('pane_open', { kind: 'preview', params: { url: 'http://localhost:3000' } })
  const daemon = await testDaemon({ model: [open, say('There.'), open, say('There.')] })
  await daemon.call('extension.declare', { extensions: [about] })
  const run = async () => {
    const thread = await daemon.thread('show me')
    const told = await daemon.transcript(thread.id)
    const result = (JSON.parse(told) as { model?: Result[] }[]).map((e) => e.model?.[0]).find((m) => m?.role === 'toolResult')!
    const panes = (await daemon.call<ThreadInfo[]>('thread.list')).find((t) => t.id === thread.id)!.panes ?? []
    return { told, result, panes }
  }
  const on = await run()
  expect(on.told).toContain('\\"preview\\": { url }')
  expect(on.told).toContain('\\"artifact\\": { path }')
  expect(on.result.isError).toBeFalsy()
  expect(on.panes).toMatchObject([{ kind: 'preview', params: { url: 'http://localhost:3000' } }])
  await daemon.call('settings.set', { key: 'extensions.web-panes', value: false })
  const off = await run()
  expect(off.told).not.toContain('\\"artifact\\"')
  expect(off.result.isError).toBe(true)
  expect(off.panes).toEqual([])
  await daemon.close()
})
