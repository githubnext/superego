// Every pi-ai provider Superego offers, how each signs in, the OpenAI-compatible ones the user adds, and the favourite
// models the model menus put first.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { defineApp, PROTOCOL_VERSION, type AuthEvent, type ModelCatalog, type Notifications, type ProviderAuthInfo, type RpcPeer, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { until } from './until.ts'

const APP = defineApp({ name: 'superego', id: 'providerstest' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-providers-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const open = async () => {
  const daemon = await openDaemon({ app: APP, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 'd.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'd.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

const snapshot = async (peer: RpcPeer) => (await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})).value
const providers = async (peer: RpcPeer) => (await snapshot(peer)).sections.find((s) => s.id === 'providers')!.data as ProviderAuthInfo[]
const catalog = (peer: RpcPeer) => peer.call<ModelCatalog>('agent.models', {})

/** Sign in with a key, and wait for it to be done. */
async function signIn(peer: RpcPeer, provider: string, key: string) {
  const events: AuthEvent[] = []
  const off = peer.on('auth.event', ({ event }: Notifications['auth.event']) => events.push(event))
  await peer.call('auth.signIn', { provider, type: 'api_key', key })
  await until(() => events.some((e) => e.type === 'done' || e.type === 'failed'))
  off()
  expect(events.at(-1)).toEqual({ type: 'done' })
}

/**
 * An OpenAI-compatible server: it lists two models, and answers every chat with one line, streamed as OpenAI does.
 * `heard` keeps each request's path and Authorization header.
 */
async function mockEndpoint() {
  const heard: { path: string; auth?: string }[] = []
  const server: Server = createServer((request: IncomingMessage, response) => {
    heard.push({ path: request.url!, ...(request.headers.authorization ? { auth: request.headers.authorization } : {}) })
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-large', object: 'model' }, { id: 'mock-small', object: 'model' }] }))
    }
    if (request.url === '/v1/chat/completions') {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (delta: object, finish: string | null, usage?: object) =>
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'mock-large', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
        response.write(chunk({ role: 'assistant', content: 'hello from ' }, null))
        response.write(chunk({ content: 'the mock' }, null))
        response.write(chunk({}, 'stop', { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }))
        response.end('data: [DONE]\n\n')
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { baseUrl: `http://127.0.0.1:${port}/v1`, heard, close: () => new Promise((resolve) => server.close(resolve)) }
}

it("lists pi-ai's providers, offering only the sign-ins meant for apps like it", async () => {
  const { peer, close } = await open()
  const list = await providers(peer)
  const ids = list.map((p) => p.id)
  for (const id of ['anthropic', 'openai', 'google', 'groq', 'mistral', 'xai', 'openrouter', 'amazon-bedrock', 'google-vertex', 'github-copilot', 'deepseek', 'cerebras']) expect(ids).toContain(id)
  // The legacy ChatGPT sign-in through Codex's client, beside OpenAI's own: one ChatGPT sign-in, not two.
  expect(ids).not.toContain('openai-codex')
  expect(list.filter((p) => p.oauth).map((p) => p.id).sort()).toEqual(['github-copilot', 'openai', 'openrouter'])
  // Never a Claude subscription's.
  await expect(peer.call('auth.signIn', { provider: 'anthropic', type: 'oauth' })).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(peer.call('auth.signIn', { provider: 'xai', type: 'oauth' })).rejects.toMatchObject({ kind: 'unsupported' })
  // Each says where it finds a key, and whether signing in asks for more than one.
  expect(list.find((p) => p.id === 'groq')).toMatchObject({ apiKey: true, env: ['GROQ_API_KEY'] })
  expect(list.find((p) => p.id === 'groq')!.keyFlow).toBeUndefined()
  expect(list.find((p) => p.id === 'amazon-bedrock')).toMatchObject({ apiKey: true, keyFlow: true, env: expect.arrayContaining(['AWS_PROFILE']) })
  expect(list.find((p) => p.id === 'azure')).toMatchObject({ keyFlow: true })
  await close()
})

it("offers a provider's models once it has a key, and none of them before", async () => {
  const { peer, close } = await open()
  expect((await catalog(peer)).models.some((m) => m.value.startsWith('groq/'))).toBe(false)
  await signIn(peer, 'groq', 'gsk-test')
  const groq = (await providers(peer)).find((p) => p.id === 'groq')!
  expect(groq).toMatchObject({ stored: true, auth: { type: 'api_key', source: 'stored credential' } })
  const models = (await catalog(peer)).models.filter((m) => m.value.startsWith('groq/'))
  expect(models.length).toBe(groq.models)
  expect(models[0]).toMatchObject({ group: 'Groq' })
  // The only one signed in: new threads get its model.
  expect((await catalog(peer)).default.model).toMatch(/^groq\//)
  await close()
})

it('signs in to Bedrock from the AWS profile in the environment, saying so', async () => {
  process.env.AWS_PROFILE = 'work'
  try {
    const { peer, close } = await open()
    expect((await providers(peer)).find((p) => p.id === 'amazon-bedrock')).toMatchObject({ stored: false, auth: { type: 'api_key', source: 'AWS_PROFILE' } })
    await close()
  } finally { delete process.env.AWS_PROFILE }
})

it('adds an OpenAI-compatible provider: its models from the endpoint, a turn streamed through it, changed and removed', async () => {
  const endpoint = await mockEndpoint()
  const { peer, close } = await open()
  const { models } = await peer.call<{ models: string[] }>('providers.models', { baseUrl: endpoint.baseUrl })
  expect(models).toEqual(['mock-large', 'mock-small'])

  const { id } = await peer.call<{ id: string }>('providers.save', { name: 'Local Mock', baseUrl: `${endpoint.baseUrl}/`, key: 'sk-local' })
  expect(id).toBe('local-mock')
  // Kept as pi keeps its own (models.json), its key with the others.
  expect(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))).toEqual({
    providers: { 'local-mock': { name: 'Local Mock', baseUrl: endpoint.baseUrl, api: 'openai-completions', models: [{ id: 'mock-large' }, { id: 'mock-small' }] } },
  })
  expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['local-mock']).toEqual({ type: 'api_key', key: 'sk-local' })
  expect((await providers(peer)).find((p) => p.id === 'local-mock')).toMatchObject({
    name: 'Local Mock', stored: true, models: 2, auth: { source: 'stored credential' }, custom: { baseUrl: endpoint.baseUrl, models: ['mock-large', 'mock-small'] },
  })
  expect((await catalog(peer)).models.filter((m) => m.group === 'Local Mock').map((m) => m.value)).toEqual(['local-mock/mock-large', 'local-mock/mock-small'])
  // Not over a built-in one.
  await expect(peer.call('providers.save', { name: 'Groq', baseUrl: endpoint.baseUrl })).rejects.toMatchObject({ kind: 'invalid' })

  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir, model: 'local-mock/mock-large', prompt: 'hi' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!.status.state === 'done')
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
  expect(JSON.stringify(value.entries)).toContain('hello from the mock')
  expect(endpoint.heard).toContainEqual({ path: '/v1/chat/completions', auth: 'Bearer sk-local' })

  // Changed: its models typed in, its key taken away.
  await peer.call('providers.save', { id, name: 'Local Mock', baseUrl: endpoint.baseUrl, models: ['mock-small'], key: null })
  expect((await providers(peer)).find((p) => p.id === id)).toMatchObject({ stored: false, models: 1, auth: { source: 'no key' } })
  // A file edited by hand is heard too.
  const file = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))
  file.providers[id].models.push({ id: 'by-hand', name: 'By hand' })
  await writeFile(join(dir, 'models.json'), JSON.stringify(file))
  await until(async () => (await catalog(peer)).models.some((m) => m.value === `${id}/by-hand` && m.label === 'By hand'))

  await peer.call('providers.remove', { provider: id })
  expect((await providers(peer)).some((p) => p.id === id)).toBe(false)
  expect(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))).toEqual({ providers: {} })
  await close()
  await endpoint.close()
})

it("says why an endpoint's models can't be listed", async () => {
  const { peer, close } = await open()
  await expect(peer.call('providers.models', { baseUrl: 'http://127.0.0.1:1/v1' })).rejects.toMatchObject({ kind: 'unreachable', message: expect.stringContaining("Couldn't reach") })
  await expect(peer.call('providers.save', { name: 'Nope', baseUrl: 'ftp://x' })).rejects.toMatchObject({ kind: 'invalid' })
  await close()
})

it('keeps favourite models in order, seeded from what is in use, and shows one signed out as unavailable', async () => {
  const first = await open()
  await signIn(first.peer, 'openai', 'sk-test')
  // Seeded: the default model, which is OpenAI's preferred one.
  const seeded = (await catalog(first.peer)).favourites!
  expect(seeded.map((f) => f.value)).toEqual(['openai/gpt-6.1-sol'])
  await signIn(first.peer, 'groq', 'gsk-test')
  const groq = (await catalog(first.peer)).models.find((m) => m.value.startsWith('groq/'))!.value
  await first.peer.call('settings.set', { key: 'agent.favourites', value: [groq, 'openai/gpt-6.1-sol'] })
  await expect(first.peer.call('settings.set', { key: 'agent.favourites', value: ['nonsense'] })).rejects.toMatchObject({ kind: 'invalid_setting' })
  await first.close()

  const second = await open()
  expect((await catalog(second.peer)).favourites!.map((f) => f.value)).toEqual([groq, 'openai/gpt-6.1-sol'])
  // The Model setting's menu: the favourites first, under their own heading.
  const model = (await snapshot(second.peer)).sections.find((s) => s.id === 'model')!.settings.find((s) => s.key === 'agent.model')!
  expect(model.type === 'choice' && model.options.slice(0, 2)).toEqual([
    expect.objectContaining({ value: groq, group: 'Favourites' }), expect.objectContaining({ value: 'openai/gpt-6.1-sol', group: 'Favourites' }),
  ])
  expect(model.type === 'choice' && model.options.filter((o) => o.value === groq)).toHaveLength(1)
  await second.peer.call('auth.signOut', { provider: 'groq' })
  const after = (await catalog(second.peer)).favourites!
  expect(after[0]).toMatchObject({ value: groq, group: 'Groq', unavailable: "Groq isn't signed in" })
  expect(after[1]!.unavailable).toBeUndefined()
  await second.close()
})

it("loads no provider's SDK until it's used", () => {
  const providers = join(import.meta.dirname, '../src/providers.ts')
  const script = `
    import { registerHooks } from 'node:module'
    const loaded = new Set()
    registerHooks({ resolve(specifier, context, next) {
      const found = next(specifier, context)
      const sdk = found.url.match(/node_modules\\/(@aws-sdk\\/client-bedrock-runtime|@google\\/genai|@anthropic-ai\\/sdk|openai|@mistralai\\/[^/]+)\\//)
      if (sdk) loaded.add(sdk[1])
      return found
    } })
    const { builtins, keyShape } = await import(${JSON.stringify(`file://${providers}`)})
    const all = builtins()
    for (const provider of all) await keyShape(provider.auth.apiKey)
    const before = [...loaded]
    const bedrock = all.find((p) => p.id === 'amazon-bedrock')
    const model = bedrock.getModels()[0]
    for await (const event of bedrock.stream(model, { messages: [] }, { apiKey: 'x', signal: AbortSignal.abort() })) if (event.type === 'error' || event.type === 'done') break
    console.log(JSON.stringify({ providers: all.length, before, after: [...loaded] }))
  `
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }).trim().split('\n').at(-1)!)
  expect(out.providers).toBeGreaterThan(35)
  expect(out.before).toEqual([])
  expect(out.after).toContain('@aws-sdk/client-bedrock-runtime')
})
