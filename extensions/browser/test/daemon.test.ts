// browser against a real daemon: listed by its `about` alone, as the app's daemon bundles it, its pane is told to the
// agent with no window ever connected while the machine has it on, and opened for it, at a web page or an HTML file; not
// once it's off.
import { expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { callTool, say, testDaemon } from '@superego/sdk/testing'
import { about } from '../src/shared.ts'

type Result = { role?: string; isError?: boolean }

it('tells the agent of Browser and opens it, at a page or a file, window or not, unless the machine has browser off', async () => {
  const open = callTool('pane_open', { kind: 'browser', params: { url: 'http://localhost:3000' } })
  const file = callTool('pane_open', { kind: 'browser', params: { path: 'report.html' } })
  const daemon = await testDaemon({ extensions: [about], model: [open, file, say('There.'), open, say('There.')] })
  const run = async () => {
    const thread = await daemon.thread('show me')
    const told = await daemon.transcript(thread.id)
    const result = (JSON.parse(told) as { model?: Result[] }[]).map((e) => e.model?.[0]).find((m) => m?.role === 'toolResult')!
    const panes = (await daemon.call<ThreadInfo[]>('thread.list')).find((t) => t.id === thread.id)!.panes ?? []
    return { told, result, panes }
  }
  const on = await run()
  expect(on.told).toContain('\\"browser\\": { url } (a web page: a dev server running here at its localhost address, or any site, which loads once the user says so) or { path } (an HTML file in the working folder')
  expect(on.result.isError).toBeFalsy()
  expect(on.panes).toMatchObject([{ kind: 'browser', params: { url: 'http://localhost:3000' } }, { kind: 'browser', params: { path: 'report.html' } }])
  await daemon.call('settings.set', { key: 'extensions.browser', value: false })
  const off = await run()
  expect(off.told).not.toContain('{ path } (an HTML file')
  expect(off.result.isError).toBe(true)
  expect(off.panes).toEqual([])
  await daemon.close()
})

it('marks a page the agent opened as its choice, until the user opens it or sends it somewhere', async () => {
  const page = (url: string) => callTool('pane_open', { kind: 'browser', params: { url } })
  const daemon = await testDaemon({ extensions: [about], model: [page('https://example.com/?d=x'), say('There.'), page('https://example.org/'), say('There.')] })
  const thread = await daemon.thread('show me')
  const panes = async () => (await daemon.info(thread)).panes ?? []
  const [first] = await panes()
  expect(first).toMatchObject({ kind: 'browser', params: { url: 'https://example.com/?d=x' }, by: 'agent' })
  // Opened by the user too (a link to the same page): theirs.
  await daemon.call('pane.open', { thread: thread.id, kind: 'browser', params: { url: 'https://example.com/?d=x' } })
  expect((await panes())[0]!.by).toBeUndefined()
  // Another of the agent's, and the user saying to load it as it is (or sending it elsewhere): theirs.
  await daemon.send(thread, 'and that one')
  const second = (await panes())[1]!
  expect(second).toMatchObject({ params: { url: 'https://example.org/' }, by: 'agent' })
  await daemon.call('pane.update', { thread: thread.id, pane: second.id, params: second.params })
  expect((await panes())[1]!.by).toBeUndefined()
  await daemon.close()
})
