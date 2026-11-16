// `superego mcp` against a real daemon (the scripted model): an MCP client over stdio lists the tools made from the
// actions exposed to mcp, runs them, and finds them in the action log, from `mcp`. Starting threads waits for the
// machine's setting.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { connectSocket, socketPath } from '@superego/daemon/client'

const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
let home: string
let client: Client

const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { type: string; text: string }[])[0]!.text
const names = async () => (await client.listTools()).tools.map((t) => t.name)
const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
/** The daemon, as the window or the command line reach it. */
const direct = async <T,>(method: string, params: unknown): Promise<T> => {
  const { peer, socket } = await connectSocket(socketPath({ id: 'superego', name: 'Superego' }, home))
  try { return await peer.call<T>(method, params) } finally { socket.destroy() }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'superego-mcp-'))
  const env = { ...process.env, SUPEREGO_HOME: home, SUPEREGO_APP: home, SUPEREGO_HEADLESS: '1', SUPEREGO_MODEL: 'faux', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } as Record<string, string>
  client = new Client({ name: 'mcp-test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env, stderr: 'inherit' }))
}, 30_000)

afterAll(async () => {
  await client?.close()
  const pid = Number(await readFile(join(home, 'daemon.pid'), 'utf8').catch(() => '0'))
  if (pid) {
    try { process.kill(pid) } catch {}
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  await rm(home, { recursive: true, force: true })
})

it('starts threads only once the machine lets outside agents', async () => {
  // Off at first: no tool, and refused if called anyway, saying where to turn it on; the window's own way still works.
  expect(await names()).not.toContain('thread_start')
  const refused = await client.callTool({ name: 'thread_start', arguments: { cwd: home } })
  expect(refused.isError).toBe(true)
  expect(text(refused)).toMatch(/can't start threads[\s\S]*Settings → Outside agents/)
  await direct('action.run', { id: 'thread.start', params: { cwd: home, title: 'from the window' } })

  // Turned on: the list changes (told to the client), and it starts one.
  let told = false
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { told = true })
  await direct('settings.set', { key: 'outside.startThreads', value: true })
  await until(async () => told)
  expect(await names()).toContain('thread_start')
}, 60_000)

it('serves the actions exposed to outside agents as tools, and logs their runs as outside', async () => {
  const { tools } = await client.listTools()
  const offered = tools.map((t) => t.name)
  expect(offered).toEqual(expect.arrayContaining([
    'thread_start', 'thread_send', 'thread_stop', 'thread_rename', 'thread_archive', 'thread_unarchive', 'pane_open', 'profile_list', 'ego_ask', 'thread_list', 'thread_read',
  ]))
  // Only those that opt in: nothing that changes settings, signs in or out, trusts a profile or restarts the daemon.
  for (const kept of ['settings_set', 'auth_login', 'profile_allow', 'daemon_restart', 'file_write', 'ego_clear']) expect(offered).not.toContain(kept)
  expect(tools.find((t) => t.name === 'thread_rename')!.inputSchema).toMatchObject({ type: 'object', required: ['thread', 'title'] })

  const created = JSON.parse(text(await client.callTool({ name: 'thread_start', arguments: { cwd: home, prompt: 'hi from mcp' } })))
  expect(created).toMatchObject({ id: expect.any(String), title: 'hi from mcp' })
  const read = JSON.parse(text(await client.callTool({ name: 'thread_read', arguments: { thread: created.id, wait: true } })))
  expect(read.thread).toMatchObject({ id: created.id, state: 'done' })
  expect(read.answer).toBeTruthy()

  await client.callTool({ name: 'thread_rename', arguments: { thread: created.id, title: 'named over mcp' } })
  const listed = JSON.parse(text(await client.callTool({ name: 'thread_list', arguments: {} })))
  expect(listed.find((t: { id: string }) => t.id === created.id)).toMatchObject({ title: 'named over mcp' })

  // A refusal is the tool's error, not the server's.
  const bad = await client.callTool({ name: 'thread_rename', arguments: { thread: created.id } })
  expect(bad.isError).toBe(true)
  expect(text(bad)).toMatch(/title/)
  expect((await client.callTool({ name: 'settings_set', arguments: { key: 'agent.model', value: 'x' } })).isError).toBe(true)

  // A pane beside it; archived, and back.
  await client.callTool({ name: 'pane_open', arguments: { thread: created.id, kind: 'preview', params: { url: 'https://example.com' } } })
  await client.callTool({ name: 'thread_archive', arguments: { thread: created.id } })
  const archived = JSON.parse(text(await client.callTool({ name: 'thread_read', arguments: { thread: created.id } })))
  expect(archived.thread).toMatchObject({ archived: true })
  await client.callTool({ name: 'thread_unarchive', arguments: { thread: created.id } })
  const back = await direct<{ id: string; panes?: { kind: string }[] }[]>('thread.list', {})
  expect(back.find((t) => t.id === created.id)?.panes).toEqual([expect.objectContaining({ kind: 'preview' })])

  // The same log as the window's and the command line's, from outside, by a client named for the MCP client.
  const { peer, socket } = await connectSocket(socketPath({ id: 'superego', name: 'Superego' }, home))
  try {
    const log = await peer.call<{ id: string; source: string; ok: boolean; client?: { kind: string; label: string } }[]>('action.log', {})
    expect(log.find((e) => e.id === 'thread.rename' && e.ok)).toMatchObject({ source: 'outside', client: { kind: 'superego-outside', label: 'mcp-test (outside agent)' } })
    expect(log.some((e) => e.id === 'thread.start' && e.source === 'outside')).toBe(true)
  } finally {
    socket.destroy()
  }
}, 60_000)

it("asks this machine's Ego, whose answer reads as any thread's, and which stays out of the list", async () => {
  const ego = JSON.parse(text(await client.callTool({ name: 'ego_ask', arguments: { prompt: 'how is this machine set up?' } })))
  expect(ego).toMatchObject({ id: expect.any(String), hidden: true, facts: { ego: true } })
  await until(async () => JSON.parse(text(await client.callTool({ name: 'thread_read', arguments: { thread: ego.id, wait: true } }))).answer !== undefined)
  const listed = JSON.parse(text(await client.callTool({ name: 'thread_list', arguments: {} })))
  expect(listed.some((t: { id: string }) => t.id === ego.id)).toBe(false)
  // Told that an outside agent asked: what its thread_start goes by (see extensions/ego's tests).
  const { value } = await direct<{ value: { entries: { model?: { role: string; content: unknown }[] }[] } }>('thread.watch', { thread: ego.id })
  const asked = value.entries.find((e) => e.model?.[0]?.role === 'user')!.model![0]!.content
  expect(JSON.stringify(asked)).toMatch(/<outside-agent>[\s\S]*how is this machine set up\?/)
}, 60_000)
