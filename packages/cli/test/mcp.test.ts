// `superego mcp` against a real daemon (the scripted model): an MCP client over stdio lists the tools made from the
// actions exposed to mcp, runs one, and finds it in the action log, from `mcp`.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { connectSocket, socketPath } from '@superego/daemon/client'

const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
let home: string
let client: Client

const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { type: string; text: string }[])[0]!.text

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

it('serves the actions exposed to mcp as tools, and logs their runs as mcp', async () => {
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  expect(names).toEqual(expect.arrayContaining(['thread_create', 'thread_submit', 'thread_abort', 'thread_rename', 'profile_list', 'thread_list', 'thread_read']))
  // Only those that opt in: nothing that changes settings, signs in or out, trusts a profile or restarts the daemon.
  for (const kept of ['settings_set', 'auth_login', 'profile_allow', 'daemon_restart', 'thread_archive', 'file_write']) expect(names).not.toContain(kept)
  expect(tools.find((t) => t.name === 'thread_rename')!.inputSchema).toMatchObject({ type: 'object', required: ['id', 'title'] })

  const created = JSON.parse(text(await client.callTool({ name: 'thread_create', arguments: { cwd: home, prompt: 'hi from mcp' } })))
  expect(created).toMatchObject({ id: expect.any(String), title: 'hi from mcp' })
  const read = JSON.parse(text(await client.callTool({ name: 'thread_read', arguments: { id: created.id, wait: true } })))
  expect(read.thread).toMatchObject({ id: created.id, state: 'done' })
  expect(read.answer).toBeTruthy()

  await client.callTool({ name: 'thread_rename', arguments: { id: created.id, title: 'named over mcp' } })
  const listed = JSON.parse(text(await client.callTool({ name: 'thread_list', arguments: {} })))
  expect(listed.find((t: { id: string }) => t.id === created.id)).toMatchObject({ title: 'named over mcp' })

  // A refusal is the tool's error, not the server's.
  const bad = await client.callTool({ name: 'thread_rename', arguments: { id: created.id } })
  expect(bad.isError).toBe(true)
  expect(text(bad)).toMatch(/title/)
  expect((await client.callTool({ name: 'settings_set', arguments: { key: 'agent.model', value: 'x' } })).isError).toBe(true)

  // The same log as the window's and the command line's, from mcp, by a client named for the MCP client.
  const { peer, socket } = await connectSocket(socketPath({ id: 'superego', name: 'Superego' }, home))
  try {
    const log = await peer.call<{ id: string; source: string; ok: boolean; client?: { kind: string; label: string } }[]>('action.log', {})
    expect(log.find((e) => e.id === 'thread.rename' && e.ok)).toMatchObject({ source: 'mcp', client: { kind: 'superego-mcp', label: 'mcp-test (MCP)' } })
    expect(log.some((e) => e.id === 'thread.create' && e.source === 'mcp')).toBe(true)
  } finally {
    socket.destroy()
  }
}, 60_000)
