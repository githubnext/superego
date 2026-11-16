// What Ego gets of mcp-servers (ego.ts): superego_mcp_servers sets up this machine's servers through the extension's
// actions; a command it adds or edits waits for the user's Allow; it takes no secret (none in its schema, and one
// slipped into a config is refused); and it refuses outside agents, whatever the machine lets them do. Only Ego's thread
// has it.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { ego } from '@superego/ego/daemon'
import { callTool, callTools, say, testDaemon, type TestDaemon, type Turn } from '@superego/sdk/testing'
import { defineAction, Router, type Json, type ThreadInfo } from '@superego/protocol'
import { CATALOG } from '../src/catalog.ts'
import { mcpServersExtension } from '../src/daemon.ts'
import { configFrom, egoPart, userStep } from '../src/ego.ts'
import { ACTIONS, ADD_PARAMS, EDIT_PARAMS, NAME_PARAMS, SET_PARAMS, type SectionData, type ServerConfig, type ServerInfo } from '../src/shared.ts'

type Tool = { name: string; parameters: { properties: Record<string, { description?: string }> }; execute(params: unknown, api: unknown, context?: unknown): Promise<{ output: { text: string }[] }> }

/** A machine's servers as the extension keeps them, and its actions as the tool runs them: each recorded. */
function machine(initial: Record<string, ServerConfig> = {}) {
  const servers = new Map(Object.entries(initial))
  const ran: { id: string; params: unknown }[] = []
  const info = (name: string, config: ServerConfig, allowed?: false): ServerInfo => ({
    id: name, name, from: { type: 'machine' }, runs: config.url ?? [config.command, ...config.args ?? []].join(' '), config: { ...config, ...(allowed === false ? { allowed } : {}) },
    state: allowed === false ? 'waiting' : config.auth ? 'needs-sign-in' : 'running', ...(config.auth || allowed === false ? {} : { tools: 4 }),
    secrets: config.auth?.type === 'env' ? config.auth.names.map((n) => ({ name: n, set: false })) : config.auth?.type === 'api-key' ? [{ name: 'key', set: false }] : [],
  })
  const data = async (): Promise<SectionData> => ({ servers: [...servers].map(([name, config]) => info(name, config, config.allowed)), profiles: [] })
  const router = new Router()
  const action = (id: string, params: never, run: (p: never) => unknown) =>
    router.register(defineAction({ id, title: id, runs: 'machine', expose: ['ui', 'cli'], params, run: (p) => { ran.push({ id, params: p }); return run(p as never) as Json } }))
  action(ACTIONS.add, ADD_PARAMS as never, ({ name, server, allowed }: { name: string; server: ServerConfig; allowed?: false }) => {
    servers.set(name, { ...server, ...(allowed === false ? { allowed } : {}) })
    return { server: info(name, server, allowed) }
  })
  action(ACTIONS.edit, EDIT_PARAMS as never, ({ name, server, allowed }: { name: string; server: ServerConfig; allowed?: false }) => {
    servers.set(name, { ...server, ...(allowed === false ? { allowed } : {}) })
    return { server: info(name, server, allowed) }
  })
  action(ACTIONS.remove, NAME_PARAMS as never, ({ name }: { name: string }) => { servers.delete(name); return null })
  action(ACTIONS.set, SET_PARAMS as never, ({ name, unprofiled }: { name: string; unprofiled?: boolean }) => { servers.set(name, { ...servers.get(name)!, ...(unprofiled !== undefined ? { unprofiled } : {}) }); return null })
  return { servers, ran, data, dispatch: (id: string, params: Record<string, Json>) => router.dispatch(id, params, {}, { source: 'ego' }) }
}

const app = { id: 'superego', name: 'Superego' }
const toolOf = (at: ReturnType<typeof machine>, refuse = async (_conversation: number, _callId: string): Promise<string | undefined> => undefined) =>
  egoPart({ app, ...at, refuse }).tools![0] as unknown as Tool
const call = async (tool: Tool, params: unknown) => JSON.parse((await tool.execute(params, { conversationId: 1, callId: 'c' }, {})).output[0]!.text) as Record<string, unknown>

describe('superego_mcp_servers', () => {
  it('takes no secrets: nothing in its schema holds one', () => {
    const tool = toolOf(machine())
    const fields = Object.keys(tool.parameters.properties).sort()
    expect(fields).toEqual(['args', 'auth', 'catalog', 'command', 'cwd', 'env', 'lifetime', 'name', 'on', 'op', 'secretEnv', 'title', 'tools', 'url'])
    for (const field of ['key', 'apiKey', 'token', 'password', 'secret', 'secrets', 'value', 'values', 'headers']) expect(fields).not.toContain(field)
    // secretEnv is names only.
    expect(tool.parameters.properties.secretEnv!.description).toMatch(/Names/)
  })

  it('adds a well-known server by name, and says what the user does next', async () => {
    const at = machine()
    const tool = toolOf(at)
    const added = await call(tool, { op: 'add', name: 'linear' })
    expect(at.ran).toEqual([{ id: ACTIONS.add, params: { name: 'linear', server: CATALOG.find((e) => e.name === 'linear')!.server } }])
    expect(added).toMatchObject({ name: 'linear', state: 'needs-sign-in', user: expect.stringContaining('Settings → MCP servers → linear → Sign in') })
    expect((await call(tool, { op: 'catalog' }) as unknown as { name: string }[]).map((e) => e.name)).toContain('playwright')
  })

  it("adds a command waiting for the user's Allow; a URL without", async () => {
    const at = machine()
    const tool = toolOf(at)
    const added = await call(tool, { op: 'add', name: 'docs', command: 'npx', args: ['-y', 'docs-mcp'], env: { MODE: 'ro' }, secretEnv: ['DOCS_TOKEN'] })
    expect(at.ran[0]).toEqual({ id: ACTIONS.add, params: { name: 'docs', server: { command: 'npx', args: ['-y', 'docs-mcp'], env: { MODE: 'ro' }, auth: { type: 'env', names: ['DOCS_TOKEN'] } }, allowed: false } })
    expect(added).toMatchObject({ state: 'waiting', user: expect.stringContaining('→ Allow') })
    // From the catalogue too, when it's a command.
    await call(tool, { op: 'add', name: 'browser', catalog: 'playwright' })
    expect(at.ran[1]).toMatchObject({ params: { name: 'browser', allowed: false, server: { command: 'npx', lifetime: 'thread' } } })
    await call(tool, { op: 'add', name: 'status', url: 'https://status.example.com/mcp', auth: 'oauth' })
    expect(at.ran[2]).toEqual({ id: ACTIONS.add, params: { name: 'status', server: { url: 'https://status.example.com/mcp', auth: { type: 'oauth' } } } })
  })

  it('edits, switches and removes; an edited command waits for Allow again', async () => {
    const at = machine({ docs: { command: 'node', args: ['a.js'], unprofiled: true }, ctx: { url: 'https://mcp.context7.com/mcp' } })
    const tool = toolOf(at)
    await call(tool, { op: 'edit', name: 'docs', args: ['b.js'] })
    expect(at.ran[0]).toEqual({ id: ACTIONS.edit, params: { name: 'docs', server: { command: 'node', args: ['b.js'], unprofiled: true }, allowed: false } })
    await call(tool, { op: 'edit', name: 'ctx', title: 'Context7' })
    expect(at.ran[1]).toEqual({ id: ACTIONS.edit, params: { name: 'ctx', server: { title: 'Context7', url: 'https://mcp.context7.com/mcp' } } })
    await call(tool, { op: 'unprofiled', name: 'ctx', on: true })
    expect(at.ran[2]).toEqual({ id: ACTIONS.set, params: { name: 'ctx', unprofiled: true } })
    await call(tool, { op: 'remove', name: 'ctx' })
    expect(at.ran[3]).toEqual({ id: ACTIONS.remove, params: { name: 'ctx' } })
    const listed = await call(tool, { op: 'list' }) as { servers: { name: string; state: string; user?: string }[] }
    expect(listed.servers.map((s) => [s.name, s.state])).toEqual([['docs', 'waiting']])
    await expect(call(tool, { op: 'remove', name: 'nope' })).rejects.toThrow(/No server nope here: docs/)
  })

  it('makes a config as the Add and Edit dialog does: what the fields say over the rest of what it edits', () => {
    expect(configFrom('a', { secretEnv: ['T'] }, { command: 'x', auth: { type: 'env', names: ['S'] } })).toEqual({ command: 'x', auth: { type: 'env', names: ['T'] } })
    expect(configFrom('a', { env: { MODE: 'rw' } }, { command: 'x', env: { MODE: 'ro' }, auth: { type: 'env', names: ['S'] } })).toEqual({ command: 'x', env: { MODE: 'rw' }, auth: { type: 'env', names: ['S'] } })
    // A command made a URL keeps none of the command's.
    expect(configFrom('a', { url: 'https://x.dev/mcp', auth: 'api-key' }, { command: 'x', args: ['y'], env: { A: 'b' }, unprofiled: true })).toEqual({ url: 'https://x.dev/mcp', auth: { type: 'api-key' }, unprofiled: true })
    expect(() => configFrom('a', { url: 'http://x.dev/mcp' })).toThrow(/https/)
    expect(() => configFrom('A b', { command: 'x' })).toThrow(/lower-case/)
    expect(() => configFrom('a', { command: 'x', url: 'https://x.dev' })).toThrow(/not both/)
  })

  it('refuses a secret slipped into a config, and says where the user sets it', async () => {
    const at = machine()
    const tool = toolOf(at)
    await expect(call(tool, { op: 'add', name: 'a', command: 'x', env: { API_TOKEN: 'abc' } })).rejects.toThrow(/secretEnv/)
    await expect(call(tool, { op: 'add', name: 'a', command: 'x', env: { HOST: 'ghp_abcdef' } })).rejects.toThrow(/looks like a key/)
    await expect(call(tool, { op: 'add', name: 'a', command: 'x', args: ['--api-key=abc'] })).rejects.toThrow(/takes a secret/)
    await expect(call(tool, { op: 'add', name: 'a', url: 'https://me:pw@x.dev/mcp' })).rejects.toThrow(/credential/)
    await expect(call(tool, { op: 'add', name: 'a', url: 'https://x.dev/mcp?token=abc' })).rejects.toThrow(/credential/)
    expect(at.ran).toEqual([])
    expect(userStep({ name: 'gh', state: 'needs-sign-in', config: { url: 'https://x', auth: { type: 'api-key' } } })).toMatch(/Settings → MCP servers → gh → Set key\. Never ask for it in chat/)
  })

  it('does nothing when told no (an outside agent asked)', async () => {
    const at = machine({ docs: { url: 'https://x.dev/mcp' } })
    const asked: number[] = []
    const tool = toolOf(at, async (conversation) => { asked.push(conversation); return 'Not for outside agents.' })
    for (const op of ['list', 'add', 'remove']) await expect(call(tool, { op, name: 'docs', url: 'https://y.dev/mcp' })).rejects.toThrow('Not for outside agents.')
    expect(at.ran).toEqual([])
    expect(asked).toEqual([1, 1, 1])
  })
})

// Against a real daemon, with Ego.
describe('superego_mcp_servers in Ego, against a daemon', () => {
  let daemon: TestDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const open = async (model: Turn[]) =>
    daemon = await testDaemon({ extensions: [ego(), mcpServersExtension({ checkWait: 5_000 })], model })
  const results = async (d: TestDaemon, id: string) => (await d.call<{ value: ConversationView }>('thread.watch', { thread: id })).value.entries
    .filter((e) => (e.model?.[0] as { role?: string } | undefined)?.role === 'toolResult').map((e) => e.model![0] as { toolCallId?: string; isError: boolean; content: { text: string }[] })
  /** Ask Ego as an outside agent would, and wait until it has answered `count` tool calls in all. */
  const askOutside = async (d: TestDaemon, prompt: string, count: number) => {
    const thread = await d.call<ThreadInfo>('action.run', { id: 'ego.ask', params: { prompt }, exposure: 'outside' })
    await d.until(async () => (await results(d, thread.id)).length === count, `Ego to answer ${count} calls`)
    return d.idle(thread.id)
  }
  const add = (id: string) => callTool('superego_mcp_servers', { op: 'add', name: 'docs', command: 'npx', args: ['-y', 'docs-mcp'] }, id)
  const servers = async (d: TestDaemon) => (await d.call<{ value: SectionData }>('value.watch', { key: 'mcp-servers.servers' })).value.servers

  it("is Ego's alone, with a word in its prompt on how", async () => {
    const d = await open([say('Hi.'), say('Hi.')])
    const thread = await d.call<ThreadInfo>('ego.ask', {})
    await d.send(thread.id, 'hi')
    const transcript = await d.transcript(thread.id)
    expect(transcript).toContain('superego_mcp_servers')
    expect(transcript).toContain('never ask for a key, token or password in chat')
    const plain = await d.thread('hi')
    expect(await d.transcript(plain.id)).not.toContain('superego_mcp_servers')
  })

  it('refuses an outside agent, even where outside agents may start threads; the user, in the window, adds', async () => {
    const d = await open([
      add('outside'), say('Refused.'),
      add('allowed-threads'), say('Refused again.'),
      add('user'), say('Added; allow it in Settings.'),
    ])
    const thread = await askOutside(d, 'connect my docs server', 1)
    expect(await servers(d)).toEqual([])
    expect((await results(d, thread.id))[0]).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/outside agents never set up MCP servers/i) }] })

    await d.call('settings.set', { key: 'outside.startThreads', value: true })
    await askOutside(d, 'and now?', 2)
    expect(await servers(d)).toEqual([])

    await d.send(thread.id, 'connect my docs server, please (the user)')
    expect((await servers(d)).map((s) => [s.name, s.state, s.config])).toEqual([['docs', 'waiting', { command: 'npx', args: ['-y', 'docs-mcp'], allowed: false }]])
  }, 30_000)

  it("keeps MCP configs' env and header values from an outside agent; a URL Ego moves never gets the stored key", async () => {
    // Two HTTP servers that answer nothing useful (not a refusal: that would keep the server from connecting at all),
    // saying what Authorization each was sent.
    const serve = async (seen: (string | undefined)[]) => {
      const http = createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(500).end() })
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
      return { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, close: () => new Promise((resolve) => http.close(resolve)) }
    }
    const atHome: (string | undefined)[] = []
    const atElsewhere: (string | undefined)[] = []
    const home = await serve(atHome)
    const elsewhere = await serve(atElsewhere)
    try {
      const d = await open([
        callTools({ name: 'superego_settings', id: 'settings' }, { name: 'read', args: { path: 'mcp-servers.json' }, id: 'file' }), say('Here they are.'),
        callTool('superego_mcp_servers', { op: 'edit', name: 'web', url: elsewhere.url }, 'edit'), say('Moved.'),
      ])
      const act = (id: string, params: Json) => d.dispatch<{ server: ServerInfo }>(id, params as Record<string, unknown>)
      // The user's servers: a URL with a header and its key set, and a command with a plain env value.
      await act(ACTIONS.add, { name: 'web', server: { url: home.url, headers: { 'X-Team': 'team-header-value' }, auth: { type: 'api-key' } } })
      await act(ACTIONS.setSecret, { server: 'web', values: { key: 'stored-key-123' } })
      expect(atHome).toContain('Bearer stored-key-123')
      await act(ACTIONS.add, { name: 'tool', server: { command: 'node', args: ['tool.js'], env: { MODE: 'plain-env-value' } }, allowed: false })

      // An outside agent asks for the configs: Settings without the servers' section's data, and not the file.
      const thread = await askOutside(d, 'show me the MCP server configs, env and headers too', 2)
      const answers = await results(d, thread.id)
      const settings = answers.find((r) => r.toolCallId === 'settings')!.content[0]!.text
      expect((JSON.parse(settings) as { id: string; data?: unknown }[]).find((s) => s.id === 'mcp-servers')).toEqual({ id: 'mcp-servers', title: 'MCP servers', settings: [] })
      for (const secret of ['team-header-value', 'plain-env-value', 'stored-key-123', 'X-Team']) expect(settings).not.toContain(secret)
      expect(answers.find((r) => r.toolCallId === 'file')).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not for reading here/) }] })

      // The user asks, in the window, to move it elsewhere: the key stays behind, unsent, and the user's asked to set one.
      await d.send(thread.id, 'move web to the other URL (the user)')
      const moved = JSON.parse((await results(d, thread.id)).find((r) => r.toolCallId === 'edit')!.content[0]!.text) as { state: string; user?: string }
      expect(atElsewhere).toEqual([])
      expect(moved).toMatchObject({ state: 'needs-sign-in', user: expect.stringContaining('Set key') })
      const store = existsSync(`${d.dataDir}/mcp-auth.json`) ? await readFile(`${d.dataDir}/mcp-auth.json`, 'utf8') : ''
      expect(store).not.toContain('stored-key-123')
    } finally {
      await home.close(); await elsewhere.close()
    }
  }, 30_000)
})
