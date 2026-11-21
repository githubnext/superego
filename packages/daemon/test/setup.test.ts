// First-run model setup, as the daemon serves it: what a machine has (`setup.probe`: a key in the login shell, a local
// model server answering), a model saying hi (`model.test`), a key tried before a sign-in is done (`auth.signIn`'s
// `check`), and a first message no model could answer refused before a thread is made.
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, PROTOCOL_VERSION, type AuthEvent, type Notifications, type RpcPeer, type SetupProbe } from '@superego/protocol'
import { connectSocket, listen, openDaemon, type DaemonOptions } from '../src/index.ts'
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
      return response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:32b', object: 'model' }, { id: 'llama3.1:8b', object: 'model' }] }))
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
  const peer = await open({ loginEnv: async () => ({ GROQ_API_KEY: 'gsk-from-zshrc', PATH: '/usr/bin' }) })
  const probe = await peer.call<SetupProbe>('setup.probe', {})
  expect(probe.fromEnv).toEqual([{ provider: 'groq', name: 'Groq', variable: 'GROQ_API_KEY', shell: true }])
  expect(probe.usable).toBe(true)
})

it("reads the login shell's environment, whatever its startup files print", async () => {
  const shell = join(dir, 'shell')
  await writeFile(shell, '#!/bin/sh\n# As zsh -ilc: its startup files print, and export a key.\necho "welcome back"\nshift\nOPENAI_API_KEY="sk-multi\nline" exec /bin/sh -c "$1"\n')
  await chmod(shell, 0o755)
  const env = await readLoginEnv({ shell })
  expect(env.OPENAI_API_KEY).toBe('sk-multi\nline')
  expect(await readLoginEnv({ shell: join(dir, 'no-such-shell') })).toEqual({})
})

it('finds a local model server, which works once added', async () => {
  const baseUrl = await mockServer()
  const peer = await open({ localServers: [{ id: 'ollama', name: 'Ollama', baseUrl }, { id: 'lmstudio', name: 'LM Studio', baseUrl: NOWHERE }] })
  let probe = await peer.call<SetupProbe>('setup.probe', {})
  expect(probe).toEqual({ usable: false, fromEnv: [], local: [{ id: 'ollama', name: 'Ollama', baseUrl, models: ['llama3.1:8b', 'qwen3:32b'] }] })

  await peer.call('providers.save', { name: 'Ollama', baseUrl, models: probe.local[0]!.models })
  probe = await peer.call<SetupProbe>('setup.probe', {})
  expect(probe.usable).toBe(true)
  expect(probe.local[0]!.provider).toBe('ollama')
  expect(await peer.call('model.test', { model: 'ollama/qwen3:32b' })).toMatchObject({ model: 'ollama/qwen3:32b', label: 'qwen3:32b', text: 'Hi! Ready when you are.' })
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

it("refuses a first message no model can answer, and makes no thread", async () => {
  const peer = await open()
  await expect(peer.call('thread.start', { cwd: dir, prompt: 'Say hi' })).rejects.toMatchObject({ kind: 'no_model' })
  expect(await peer.call('thread.list', {})).toEqual([])
})
