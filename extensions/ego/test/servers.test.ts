// Ego's superego_mcp_servers: it sets up this machine's MCP servers through the mcp-servers extension's actions; a
// command it adds or edits waits for the user's Allow; it takes no secret (none in its schema, and one slipped into a
// config is refused); and it refuses outside agents, whatever the machine lets them do. Its read tool won't open the
// credential stores either.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, defineDaemonExtension, listen, openDaemon } from '@superego/daemon'
import { defineAction, defineApp, obj, PROTOCOL_VERSION, Router, type Json, type RpcPeer, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { ACTIONS, ADD_PARAMS, EDIT_PARAMS, NAME_PARAMS, SET_PARAMS, type SectionData, type ServerConfig, type ServerInfo } from '@superego/mcp-servers/shared'
import { CATALOG } from '@superego/mcp-servers/catalog'
import { ego as egoExtension } from '../src/daemon.ts'
import { metaExtension } from '../src/tools.ts'
import { configFrom, serversTool, userStep } from '../src/servers-tool.ts'

type Tool = { name: string; parameters: { properties: Record<string, { description?: string }> }; execute(params: unknown, api: unknown, context?: unknown): Promise<{ output: { text: string }[] }> }

/** A machine's servers as the mcp-servers extension keeps them, and its actions as Ego runs them: each recorded. */
function machine(initial: Record<string, ServerConfig> = {}) {
  const servers = new Map(Object.entries(initial))
  const ran: { id: string; params: unknown }[] = []
  const info = (name: string, config: ServerConfig, allowed?: false): ServerInfo => ({
    id: name, name, from: { type: 'machine' }, runs: config.url ?? [config.command, ...config.args ?? []].join(' '), config: { ...config, ...(allowed === false ? { allowed } : {}) },
    state: allowed === false ? 'waiting' : config.auth ? 'needs-sign-in' : 'running', ...(config.auth || allowed === false ? {} : { tools: 4 }),
    secrets: config.auth?.type === 'env' ? config.auth.names.map((n) => ({ name: n, set: false })) : config.auth?.type === 'api-key' ? [{ name: 'key', set: false }] : [],
  })
  const data = (): SectionData => ({ servers: [...servers].map(([name, config]) => info(name, config, config.allowed)), profiles: [] })
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
  const snapshot = async (): Promise<SettingsSnapshot> => ({ sections: [{ id: 'mcp-servers', title: 'MCP servers', order: 30, settings: [], ui: 'mcp-servers', data: data() as unknown as Json }], values: {} })
  return { servers, ran, data, snapshot, dispatch: (id: string, params: Record<string, Json>) => router.dispatch(id, params, {}, { source: 'ego' }) }
}

const call = async (tool: Tool, params: unknown) => JSON.parse((await tool.execute(params, { conversationId: 1 }, {})).output[0]!.text) as Record<string, unknown>

describe('superego_mcp_servers', () => {
  it('takes no secrets: nothing in its schema holds one', () => {
    const at = machine()
    const tool = serversTool(at) as unknown as Tool
    const fields = Object.keys(tool.parameters.properties).sort()
    expect(fields).toEqual(['args', 'auth', 'catalog', 'command', 'cwd', 'env', 'lifetime', 'name', 'on', 'op', 'secretEnv', 'title', 'tools', 'url'])
    for (const field of ['key', 'apiKey', 'token', 'password', 'secret', 'secrets', 'value', 'values', 'headers']) expect(fields).not.toContain(field)
    // secretEnv is names only.
    expect(tool.parameters.properties.secretEnv!.description).toMatch(/Names/)
  })

  it('adds a well-known server by name, and says what the user does next', async () => {
    const at = machine()
    const tool = serversTool(at) as unknown as Tool
    const added = await call(tool, { op: 'add', name: 'linear' })
    expect(at.ran).toEqual([{ id: ACTIONS.add, params: { name: 'linear', server: CATALOG.find((e) => e.name === 'linear')!.server } }])
    expect(added).toMatchObject({ name: 'linear', state: 'needs-sign-in', user: expect.stringContaining('Settings → MCP servers → linear → Sign in') })
    expect((await call(tool, { op: 'catalog' }) as unknown as { name: string }[]).map((e) => e.name)).toContain('playwright')
  })

  it("adds a command waiting for the user's Allow; a URL without", async () => {
    const at = machine()
    const tool = serversTool(at) as unknown as Tool
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
    const tool = serversTool(at) as unknown as Tool
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

  it('refuses a secret slipped into a config, and says where the user sets it', async () => {
    const at = machine()
    const tool = serversTool(at) as unknown as Tool
    await expect(call(tool, { op: 'add', name: 'a', command: 'x', env: { API_TOKEN: 'abc' } })).rejects.toThrow(/secretEnv/)
    await expect(call(tool, { op: 'add', name: 'a', command: 'x', env: { HOST: 'ghp_abcdef' } })).rejects.toThrow(/looks like a key/)
    await expect(call(tool, { op: 'add', name: 'a', command: 'x', args: ['--api-key=abc'] })).rejects.toThrow(/takes a secret/)
    await expect(call(tool, { op: 'add', name: 'a', url: 'https://me:pw@x.dev/mcp' })).rejects.toThrow(/credential/)
    await expect(call(tool, { op: 'add', name: 'a', url: 'https://x.dev/mcp?token=abc' })).rejects.toThrow(/credential/)
    expect(at.ran).toEqual([])
    expect(userStep({ name: 'gh', state: 'needs-sign-in', config: { url: 'https://x', auth: { type: 'api-key' } } })).toMatch(/Settings → MCP servers → gh → Set key\. Never ask for it in chat/)
    expect(configFrom({ secretEnv: ['T'] }, { command: 'x', auth: { type: 'env', names: ['S'] } })).toEqual({ command: 'x', auth: { type: 'env', names: ['T'] } })
  })

  it('does nothing when told no (an outside agent asked), nor on a machine without the extension', async () => {
    const at = machine({ docs: { url: 'https://x.dev/mcp' } })
    const asked: number[] = []
    const tool = serversTool({ ...at, refuse: async (conversation) => { asked.push(conversation); return 'Not for outside agents.' } }) as unknown as Tool
    for (const op of ['list', 'add', 'remove']) await expect(call(tool, { op, name: 'docs', url: 'https://y.dev/mcp' })).rejects.toThrow('Not for outside agents.')
    expect(at.ran).toEqual([])
    expect(asked).toEqual([1, 1, 1])
    const off = serversTool({ dispatch: at.dispatch, snapshot: async () => ({ sections: [], values: {} }) }) as unknown as Tool
    await expect(call(off, { op: 'list' })).rejects.toThrow(/extension is off/)
  })
})

describe("Ego's read tool", () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-ego-read-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it("won't open the credential stores", async () => {
    await writeFile(join(dir, 'mcp-auth.json'), '{"server:linear":"lin_api_x"}')
    await writeFile(join(dir, 'auth.json'), '{"anthropic":"sk-x"}')
    await writeFile(join(dir, 'mcp-servers.json'), '{"servers":{}}')
    const at = machine()
    const { tools = [] } = metaExtension({ dir, dispatch: at.dispatch, actions: () => [], snapshot: at.snapshot, threads: { info: async () => undefined, list: async () => [], start: async () => { throw new Error('no') }, answer: async () => undefined } })
    const read = (tools as unknown as Tool[]).find((t) => t.name === 'read')!
    const api = { conversationId: 1, cwd: dir, env: process.env }
    for (const path of ['mcp-auth.json', './auth.json', join(dir, 'sub', '..', 'mcp-auth.json')]) {
      await expect(Promise.resolve().then(() => read.execute({ path }, api, { cwd: dir }))).rejects.toThrow(/holds sign-ins and keys/)
    }
  })
})

// Against a real daemon, with a stand-in for the mcp-servers extension (its section and add action).
describe('superego_mcp_servers in Ego, against a daemon', () => {
  const app = defineApp({ name: 'test', id: 'servertest' })
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-ego-servers-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.SERVERTEST_MODEL })
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
    throw new Error('timed out')
  }
  const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })

  it('refuses an outside agent, even where outside agents may start threads; the user, in the window, adds', async () => {
    const added: unknown[] = []
    const servers = defineDaemonExtension({
      name: 'mcp-servers',
      setup(superego) {
        superego.settings.register({ id: 'mcp-servers', title: 'MCP servers', ui: 'mcp-servers', settings: [], data: () => ({ servers: [], profiles: [] }) })
        superego.action(defineAction({
          id: ACTIONS.add, title: 'Add', runs: 'machine', expose: ['ui', 'cli'], params: ADD_PARAMS,
          run: (params) => { added.push(params); return { server: { id: params.name, name: params.name, from: { type: 'machine' }, runs: params.server.command ?? '', config: params.server, state: 'waiting', secrets: [] } } as never },
        }))
        // Unused here; there so the stand-in has the shape.
        superego.action(defineAction({ id: 'mcp-servers.noop', title: 'Nothing', runs: 'machine', expose: ['ui'], params: obj({}), run: () => null }))
      },
    })
    const add = (id: string) => turn([{ type: 'toolCall', id, name: 'superego_mcp_servers', arguments: { op: 'add', name: 'docs', command: 'npx', args: ['-y', 'docs-mcp'] } }], 'toolUse')
    await writeFile(join(dir, 'turns.jsonl'), [
      add('outside'), turn([{ type: 'text', text: 'Refused.' }], 'stop'),
      add('allowed-threads'), turn([{ type: 'text', text: 'Refused again.' }], 'stop'),
      add('user'), turn([{ type: 'text', text: 'Added; allow it in Settings.' }], 'stop'),
    ].join('\n') + '\n')
    process.env.SERVERTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
    process.env.SERVERTEST_REPLAY_SPEED = '0'
    const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [egoExtension(), servers] })
    const server = await listen(daemon, join(dir, 's.sock'))
    const { peer, socket } = await connectSocket(join(dir, 's.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    const egoOf = async (p: RpcPeer) => (await p.call<{ value: ThreadInfo | null }>('value.watch', { key: 'ego.thread' })).value
    const results = async (id: string) => (await peer.call<{ value: ConversationView }>('thread.watch', { id })).value.entries
      .filter((e) => (e.model?.[0] as { role?: string } | undefined)?.role === 'toolResult').map((e) => e.model![0] as { isError: boolean; content: { text: string }[] })
    const answered = (count: number) => until(async () => {
      const ego = await egoOf(peer)
      return ego?.status.state === 'done' && (await results(ego.id)).length === count
    })

    const ego = await peer.call<ThreadInfo>('action.run', { id: 'ego.ask', params: { prompt: 'connect my docs server' }, exposure: 'mcp' })
    await answered(1)
    expect(added).toEqual([])
    expect((await results(ego.id))[0]).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/outside agents never set up MCP servers/i) }] })

    await peer.call('settings.set', { key: 'mcp.startThreads', value: true })
    await peer.call('action.run', { id: 'ego.ask', params: { prompt: 'and now?' }, exposure: 'mcp' })
    await answered(2)
    expect(added).toEqual([])

    await peer.call('thread.submit', { id: ego.id, text: 'connect my docs server, please (the user)' })
    await answered(3)
    expect(added).toEqual([{ name: 'docs', server: { command: 'npx', args: ['-y', 'docs-mcp'] }, allowed: false }])

    socket.destroy(); server.close(); await daemon.close()
  }, 30_000)
})
