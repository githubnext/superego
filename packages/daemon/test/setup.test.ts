// First-run model setup, as the daemon serves it: what a machine has (`setup.probe`: a key in the login shell, a local
// model server answering), a model saying hi (`model.test`), a key tried before a sign-in is done (`auth.signIn`'s
// `check`), and a first message no model could answer refused before a thread is made.
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, PROTOCOL_VERSION, type AuthEvent, type Notifications, type ModelCatalog, type RpcPeer, type SetupProbe } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonApi, type DaemonOptions } from '../src/index.ts'
import { readLoginEnv } from '../src/login-env.ts'
import { until } from './until.ts'

const APP = defineApp({ name: 'superego', id: 'setuptest' })
let dir: string
let closing: (() => Promise<unknown>)[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-setup-')) })
afterEach(async () => {
  for (const close of closing.reverse()) await close()
  closing = []
  await rm(dir, { recursive: true, force: true })
})

/** Nothing listens here: a local server that isn't running. */
const NOWHERE = 'http://127.0.0.1:9/v1'

async function open(options: Partial<DaemonOptions> = {}) {
  const daemon = await openDaemon({ app: APP, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), localServers: [{ id: 'ollama', name: 'Ollama', baseUrl: NOWHERE }], ...options })
  const server = await listen(daemon, join(dir, 'd.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'd.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  closing.push(async () => { socket.destroy(); server.close(); await daemon.close() })
  return peer
}

/**
 * An OpenAI-compatible server, as Ollama is: it lists two models and answers every chat with one line; given `key`,
 * it refuses any other as OpenAI does (401, invalid_api_key).
 */
async function mockServer(key?: string) {
  const server: Server = createServer((request, response) => {
    const auth = request.headers.authorization
    if (key && auth !== `Bearer ${key}`) {
      request.resume()
      response.writeHead(401, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth?.slice(7)}`, type: 'invalid_request_error', code: 'invalid_api_key' } }))
    }
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:32b', object: 'model' }, { id: 'nomic-embed-text:latest', object: 'model' }, { id: 'llama3.1:8b', object: 'model' }] }))
    }
    if (request.url === '/v1/chat/completions') {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen3:32b', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        response.write(chunk({ role: 'assistant', content: 'Hi! Ready ' }, null))
        response.write(chunk({ content: 'when you are.' }, null))
        response.write(chunk({}, 'stop'))
        response.end('data: [DONE]\n\n')
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  closing.push(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${port}/v1`
}

/** Sign in with a key, checked; the flow's events once it ended. */
async function signIn(peer: RpcPeer, provider: string, key: string) {
  const events: AuthEvent[] = []
  const off = peer.on('auth.event', ({ event }: Notifications['auth.event']) => events.push(event))
  await peer.call('auth.signIn', { provider, type: 'api_key', key, check: true })
  await until(() => events.some((e) => e.type === 'done' || e.type === 'failed'))
  off()
  return events
}

it('finds nothing on a machine with nothing, and no model works', async () => {
  const peer = await open()
  expect(await peer.call<SetupProbe>('setup.probe', {})).toEqual({ usable: false, fromEnv: [], local: [] })
  await expect(peer.call('model.test', {})).rejects.toMatchObject({ kind: 'no_model' })
})

it('finds a key in the login shell, and signs in with it', async () => {
  const peer = await open({ loginEnv: async () => ({ env: { GROQ_API_KEY: 'gsk-from-zshrc', PATH: '/usr/bin' } }) })
  const probe = await peer.call<SetupProbe>('setup.probe', {})
  expect(probe.fromEnv).toEqual([{ provider: 'groq', name: 'Groq', variable: 'GROQ_API_KEY', shell: true }])
  expect(probe.usable).toBe(true)
})

it('starts a provider on its best model, not its first by name', async () => {
  // Google's first by name is a deep-research preview, Groq's an 8B model.
  const peer = await open({ loginEnv: async () => ({ env: { GEMINI_API_KEY: 'gemini-from-zshrc' } }) })
  expect((await peer.call<SetupProbe>('setup.probe', {})).fromEnv.map((f) => f.provider)).toEqual(['google'])
  const catalog = await peer.call<ModelCatalog>('agent.models', {})
  expect(catalog.default.model).toBe('google/gemini-pro-latest')
  expect(catalog.models.filter((m) => m.recommended).map((m) => m.value)).toEqual(['google/gemini-flash-latest', 'google/gemini-pro-latest'])
})

it("reads the login shell's environment, whatever its startup files print", async () => {
  // A file of the checkout's, not one written here, run by bash (fixtures/login-shell says why): on a busy machine a
  // program can take seconds to start, past the 5s it's given.
  const read = await readLoginEnv({ shell: fileURLToPath(new URL('fixtures/login-shell', import.meta.url)) })
  expect('env' in read && read.env.OPENAI_API_KEY).toBe('sk-multi\nline')
  expect(await readLoginEnv({ shell: join(dir, 'no-such-shell') })).toEqual({ error: expect.stringMatching(/^Couldn't read your login shell's environment \(.*no-such-shell\): /) })
})

it("reads the login shell once, for setup and extensions alike, and again only after a read that failed", async () => {
  const reads: string[] = []
  const answers = [{ error: "Couldn't read your login shell's environment (zsh): it didn't answer within 5s" }, { env: { GROQ_API_KEY: 'gsk-from-zshrc', PATH: '/opt/bin' } }]
  let api: DaemonApi | undefined
  const peer = await open({
    loginEnv: async () => { reads.push('read'); return answers[reads.length - 1]! },
    extensions: [defineDaemonExtension({ name: 'reader', setup(superego) { api = superego } })],
  })
  // The daemon's read, at start, failed: the extension's asks again, and what that finds is kept, for setup too.
  await until(() => reads.length === 1)
  expect(await api!.loginEnv()).toEqual(answers[1])
  expect(await api!.loginEnv()).toEqual(answers[1])
  expect(reads).toHaveLength(2)
  expect((await peer.call<SetupProbe>('setup.probe', {})).fromEnv).toEqual([{ provider: 'groq', name: 'Groq', variable: 'GROQ_API_KEY', shell: true }])
  expect(reads).toHaveLength(2)
})

it('finds a local model server, its chat models in its own order, which works once added', async () => {
  const baseUrl = await mockServer()
  const peer = await open({ localServers: [{ id: 'ollama', name: 'Ollama', baseUrl }, { id: 'lmstudio', name: 'LM Studio', baseUrl: NOWHERE }] })
  let probe = await peer.call<SetupProbe>('setup.probe', {})
  // As Ollama lists them (the most recently pulled first), without its embedding model.
  expect(probe).toEqual({ usable: false, fromEnv: [], local: [{ id: 'ollama', name: 'Ollama', baseUrl, models: ['qwen3:32b', 'llama3.1:8b'] }] })

  await peer.call('providers.save', { name: 'Ollama', baseUrl, models: probe.local[0]!.models })
  probe = await peer.call<SetupProbe>('setup.probe', {})
  expect(probe.usable).toBe(true)
  expect(probe.local[0]!.provider).toBe('ollama')
  expect((await peer.call<ModelCatalog>('agent.models', {})).default.model).toBe('ollama/qwen3:32b')
  expect(await peer.call('model.test', {})).toMatchObject({ model: 'ollama/qwen3:32b', label: 'qwen3:32b', text: 'Hi! Ready when you are.' })
  // Typed without its scheme, as a local server's address often is.
  await peer.call('providers.save', { name: 'Again', baseUrl: baseUrl.replace('http://', '') })
  expect((await peer.call<ModelCatalog>('agent.models', {})).models.filter((m) => m.group === 'Again').map((m) => m.label)).toEqual(['qwen3:32b', 'llama3.1:8b'])
})

it('tries a key before signing in with it, and takes back one the provider refuses', async () => {
  const baseUrl = await mockServer('good-key')
  const peer = await open()
  await peer.call('providers.save', { name: 'Mock', baseUrl, models: ['qwen3:32b'] })
  const stored = () => existsSync(join(dir, 'auth.json')) ? JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')).mock : undefined

  const refused = await signIn(peer, 'mock', 'bad-key')
  expect(refused.at(-1)).toEqual({ type: 'failed', message: expect.stringMatching(/^Mock rejected the API key: .*Incorrect API key/) })
  expect(stored()).toBeUndefined()
  await expect(peer.call('model.test', { model: 'mock/qwen3:32b' })).rejects.toMatchObject({ kind: 'rejected' })

  const taken = await signIn(peer, 'mock', 'good-key')
  expect(taken).toContainEqual({ type: 'progress', message: 'Trying it on qwen3:32b…' })
  expect(taken.at(-1)).toEqual({ type: 'done' })
  expect(stored()).toEqual({ type: 'api_key', key: 'good-key' })
})

it("cancels a provider's unfinished sign-in when another starts, so the new one isn't stuck behind it", async () => {
  // ChatGPT's listens on a fixed port: one left running (its row closed) kept the next from starting.
  const peer = await open()
  const events = new Map<string, AuthEvent[]>()
  peer.on('auth.event', ({ flow, event }: Notifications['auth.event']) => events.set(flow, [...events.get(flow) ?? [], event]))
  const signIn = () => peer.call<{ flow: string }>('auth.signIn', { provider: 'github-copilot', type: 'oauth' })
  const first = await signIn()
  await until(() => Boolean(events.get(first.flow)?.some((e) => e.type === 'prompt')))
  const second = await signIn()
  await until(() => events.get(first.flow)?.at(-1)?.type === 'failed')
  expect(events.get(first.flow)!.at(-1)).toEqual({ type: 'failed', message: 'Signing in again elsewhere' })
  await until(() => Boolean(events.get(second.flow)?.some((e) => e.type === 'prompt')))
  await peer.call('auth.cancel', { flow: second.flow })
})

it("doesn't ask Copilot's GitHub when the caller says which", async () => {
  const peer = await open()
  const events: AuthEvent[] = []
  peer.on('auth.event', ({ event }: Notifications['auth.event']) => events.push(event))
  // A domain that can't resolve: the flow goes straight to asking it for a code, and fails there, offline too.
  await peer.call('auth.signIn', { provider: 'github-copilot', type: 'oauth', domain: 'github.invalid' })
  await until(() => events.some((e) => e.type === 'failed'))
  expect(events.filter((e) => e.type === 'prompt')).toEqual([])
})

it("refuses a first message no model can answer, and makes no thread", async () => {
  const peer = await open()
  await expect(peer.call('thread.start', { cwd: dir, prompt: 'Say hi' })).rejects.toMatchObject({ kind: 'no_model' })
  expect(await peer.call('thread.list', {})).toEqual([])
})

it('stops trying a key when its sign-in is cancelled, and keeps nothing of it', async () => {
  // A provider that lists its models, and holds every chat until the request goes away.
  let [held, gone] = [false, false]
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ object: 'list', data: [{ id: 'slow-1', object: 'model' }] }))
    }
    held = true
    request.resume()
    response.on('close', () => { gone = true })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closing.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const peer = await open()
  await peer.call('providers.save', { name: 'Slow', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: ['slow-1'] })
  const events: AuthEvent[] = []
  peer.on('auth.event', ({ event }: Notifications['auth.event']) => events.push(event))
  const { flow } = await peer.call<{ flow: string }>('auth.signIn', { provider: 'slow', type: 'api_key', key: 'a-good-key-it-would-be', check: true })
  await until(() => events.some((e) => e.type === 'progress' && e.message.startsWith('Trying it on')))
  // Cancelled once the chat is held: said before its request goes out, a cancel then would leave none to see end.
  await until(() => held)
  await peer.call('auth.cancel', { flow })
  await until(() => events.at(-1)?.type === 'failed')
  expect(events.at(-1)).toEqual({ type: 'failed', message: 'Cancelled' })
  await until(() => gone)
  const stored = existsSync(join(dir, 'auth.json')) ? JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')).slow : undefined
  expect(stored).toBeUndefined()
})
