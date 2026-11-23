// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true}}}
// First-run setup, against a real daemon: it shows at once on a fresh data folder (on the model that works, if one
// does, done once it has answered), finds a local model server (a mock, as Ollama), uses it, has it say hi, stars a model, and goes for good once
// done. Set up models… brings it back; from a composer that couldn't send, it goes back to that thread once done.
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon, type Daemon } from '@superego/daemon'
import { defineApp, ONBOARDED, PROTOCOL_VERSION, RELEASED, type AuthEvent, type Hello, type Notifications, type RpcPeer } from '@superego/protocol'
import type { MachineEntry, SuperegoEvent } from '../src/shared/bridge.ts'
import { RegistryProvider, useRegistry } from '../src/renderer/registry.tsx'
import { windowRegistry } from '../src/renderer/index.tsx'
import { NoModel, SetupPage, useSetup, type SetupFound } from '../src/renderer/Setup.tsx'
import { SignInFlow } from '../src/renderer/sign-in-flow.tsx'
import { ShellStateProvider, useMachines, useSelection } from '../src/renderer/state.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const app = defineApp({ name: 'Superego', id: 'superego' })

let dir: string
let daemon: Daemon
let peer: RpcPeer
let close: (() => Promise<void>) | undefined
let root: Root | undefined
let container: HTMLElement
let server: Server | undefined

/** An OpenAI-compatible server, as Ollama is: two models, and one line for every chat; or, `refusing`, a 401 for every chat. */
async function mockOllama({ refusing = false } = {}) {
  server = createServer((request, response) => {
    if (refusing && request.url !== '/v1/models') {
      request.resume()
      response.writeHead(401, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }))
    }
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:32b' }, { id: 'llama3.1:8b' }] }))
    }
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen3:32b', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      response.write(chunk({ role: 'assistant', content: 'Hi! Ready when you are.' }, null))
      response.write(chunk({}, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
}

/** A daemon on a fresh folder: with the scripted model (`faux`) or none, and Ollama where `ollama` says (nowhere unset). */
async function start({ faux = false, ollama = 'http://127.0.0.1:9/v1' }: { faux?: boolean; ollama?: string } = {}) {
  if (faux) process.env.SUPEREGO_MODEL = 'faux'
  else delete process.env.SUPEREGO_MODEL
  daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), localServers: [{ id: 'ollama', name: 'Ollama', baseUrl: ollama }] })
  const listening = await listen(daemon, join(dir, 'superego.sock'))
  const connected = await connectSocket(join(dir, 'superego.sock'))
  peer = connected.peer
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  const entry: MachineEntry = { id: 'local', label: 'This computer', state: 'connected', machine: hello.machine, features: hello.features, extensions: hello.extensions }
  const listeners = new Set<(event: SuperegoEvent) => void>()
  for (const method of RELEASED.notifications) peer.on(method, (params: unknown) => { for (const l of listeners) l({ machine: 'local', method, params }) })
  window.superego = {
    call: (machine, method, params) => machine === 'local' ? peer.call(method, params) : Promise.reject(new Error(`no ${machine}`)),
    machines: async () => [entry],
    onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  close = async () => { connected.socket.destroy(); listening.close(); await daemon.close() }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-setup-'))
  localStorage.clear()
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
  await close?.()
  close = undefined
  if (server) await new Promise((resolve) => server!.close(resolve))
  server = undefined
  delete process.env.SUPEREGO_MODEL
  await rm(dir, { recursive: true, force: true })
})

let select: ReturnType<typeof useSelection>['select']
let selection: ReturnType<typeof useSelection>['selection']
/**
 * Where the shell puts it: in place of "Select or start a thread", with the router's context as the shell sets it; and
 * a composer's "no model" card, for a thread that couldn't send.
 */
function Main({ card, flow }: { card?: string; flow?: () => Promise<{ flow: string }> }) {
  const registry = useRegistry()
  const machines = useMachines()
  const selected = useSelection()
  select = selected.select
  selection = selected.selection
  registry.router.setContext({
    app, machines, selection: selected.selection, select: selected.select, openSettings() {}, newThread() {}, togglePalette() {}, toggleNavigator() {}, togglePanePicker() {},
    showLog() {}, threadOf: () => undefined, projects: [], sidebar: { pinned: [], projects: [], folded: [] }, lastThread: {}, fold() {}, appSetting: () => undefined, toggleSidebar() {}, focusSpace() {}, back() {}, forward() {}, railTabs: () => [],
  })
  const setup = useSetup()
  const local = machines.find((m) => m.id === 'local')
  if (flow) return h(SignInFlow, { machine: 'local', title: 'Signing in…', start: flow, onClose() {} })
  return h('div', null,
    card && local && selected.selection ? h(NoModel, { machine: local, back: { machine: 'local', thread: card } }) : null,
    setup ? h(SetupPage, { key: setup, machine: setup }) : h('p', { className: 'empty' }, 'Select or start a thread.'))
}

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) }
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await settle() }
  throw new Error(`waiting for ${what}: ${container.textContent}`)
}
async function mount(card?: string, flow?: () => Promise<{ flow: string }>) {
  const registry = windowRegistry(app, [])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(h(RegistryProvider, { registry, children: h(ShellStateProvider, { children: h(Main, { card, ...(flow ? { flow } : {}) }) }) })) })
  await settle()
  return registry
}
const page = () => container.querySelector('.setup')
const text = () => container.textContent ?? ''
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
const rowOf = (title: string) => [...container.querySelectorAll<HTMLElement>('.setup__row')].find((r) => r.querySelector('.setup__what')?.firstElementChild?.textContent === title)
const click = async (element: HTMLElement) => { await act(async () => { element.click() }); await settle() }
const value = async (key: string) => (await daemon.settings.snapshot()).values[key]

it('shows on first run with no model, uses the Ollama it finds, says hi, and goes for good once done', async () => {
  await start({ ollama: await mockOllama() })
  await mount()
  await until(() => text().includes('Set up a model') && Boolean(rowOf('Ollama')), 'the page, with Ollama found')
  expect(rowOf('Ollama')!.textContent).toContain('qwen3:32b, llama3.1:8b')

  await click(rowOf('Ollama')!.querySelector('button')!)
  await until(() => text().includes('Hi! Ready when you are.'), 'it saying hi')
  expect((await peer.call<{ default: { model?: string } }>('agent.models', {})).default.model).toMatch(/^ollama\//)

  // A star, as the model menus have it.
  await click(button('Star llama3.1:8b'))
  await until(async () => ((await value('agent.favourites')) as string[] | null)?.includes('ollama/llama3.1:8b') ?? false, 'starred')

  await click(button('Done'))
  await until(() => !page(), 'the page gone')
  expect(await value(ONBOARDED)).toBe(true)
  // A new window on the same machine: not again.
  await act(async () => root!.unmount())
  root = undefined
  container.remove()
  await mount()
  await settle()
  expect(page()).toBeNull()
})

it('shows at once on first run, on the model that works, and counts as done once it has answered', async () => {
  // Nothing is asked of the model before the page shows: it says hi there, however long that takes.
  await start({ faux: true })
  await mount()
  await until(() => text().includes('Set up a model'), 'the page, at once')
  await until(() => text().includes('echo: Say hi'), 'the model saying hi')
  await until(async () => (await value(ONBOARDED)) === true, 'setup done')
  // Done, but still there to start from.
  expect(page()).not.toBeNull()
  await click(button('Start a thread'))
  await until(() => !page(), 'the page gone')
})

it('comes back on Set up models…, opening on the model that works, and goes when a thread is picked', async () => {
  await start({ faux: true })
  await daemon.settings.set(ONBOARDED, true)
  const registry = await mount()
  await settle()
  expect(page()).toBeNull()
  await act(async () => { await registry.router.dispatch('app.setup') })
  await until(() => text().includes('echo: Say hi'), 'the page again, the model saying hi')
  const thread = await peer.call<{ id: string }>('thread.start', { title: 'picked' })
  await act(async () => { select({ machine: 'local', thread: thread.id }) })
  await until(() => !page(), 'the page gone for a thread')
  await act(async () => { select(undefined) })
  await settle()
  expect(page()).toBeNull()
})

it("opens from a composer that couldn't send, and goes back to its thread once done", async () => {
  await start({ ollama: await mockOllama() })
  await daemon.settings.set(ONBOARDED, true)
  const thread = await peer.call<{ id: string }>('thread.start', { title: 'stuck' })
  await mount(thread.id)
  await act(async () => { select({ machine: 'local', thread: thread.id }) })
  await until(() => text().includes('No model is set up on this computer.'), 'the card')
  await click(button('Set up models…'))
  await until(() => Boolean(rowOf('Ollama')), 'the page, for the thread')
  await click(rowOf('Ollama')!.querySelector('button')!)
  await until(() => Boolean(container.querySelector('.setup__bubble')), 'it answering')
  await click(button('Back to the thread'))
  await until(() => selection?.thread === thread.id && !page(), 'back at the thread')
})

it("shows on first run when the model found doesn't answer, saying why", async () => {
  // A key in the environment that's been revoked counts as a model until it's tried.
  const baseUrl = await mockOllama({ refusing: true })
  await start()
  await peer.call('providers.save', { name: 'Revoked', baseUrl })
  expect((await peer.call<{ usable: boolean }>('setup.probe', {})).usable).toBe(true)
  await mount()
  await until(() => Boolean(page()), 'the page, though a model is set')
  await until(() => Boolean(container.querySelector('.setup__test .setup__error')), 'its test failing')
  expect(container.querySelector('.setup__test .setup__error')!.textContent).toBe('Revoked rejected the API key: Incorrect API key provided')
  expect(container.querySelector('.setup__bad')).not.toBeNull()
})

/** Type into a field as React hears it. */
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}
const way = (title: string) => rowOf(title)!.querySelector<HTMLButtonElement>('button.setup__line')!

it("tells whose a pasted key is, and refuses one that can't be a key before sending it", async () => {
  await start()
  await mount()
  await until(() => Boolean(rowOf('Paste an API key')), 'the ways in')
  await click(way('Paste an API key'))
  const field = container.querySelector<HTMLInputElement>('.setup__key input[type=password]')!
  await type(field, 'sk-proj-abcdefghijklmnopqrstuvwxyz0123')
  expect(text()).toContain('OpenAI key')
  expect(container.querySelector('.setup__key select')).toBeNull()
  // Not OpenAI's after all: its provider picked by hand.
  await click(button('Not OpenAI?'))
  expect(container.querySelector<HTMLSelectElement>('.setup__key select')!.value).toBe('openai')

  await type(field, 'hello')
  expect(container.querySelector('.setup__key select')).not.toBeNull()
  await act(async () => { container.querySelector<HTMLFormElement>('.setup__key')!.requestSubmit() })
  await settle()
  expect(text()).toContain("That doesn't look like an API key.")
  expect(container.querySelector('.auth-flow')).toBeNull()
})

it('adds a local server by its address as typed, and starts on its first model', async () => {
  const baseUrl = await mockOllama()
  await start()
  await mount()
  await until(() => Boolean(rowOf('Local model')), 'the ways in')
  await click(way('Local model'))
  // Without its scheme or /v1, as an address is often written.
  await type(container.querySelector<HTMLInputElement>('.setup__local input')!, baseUrl.replace('http://', '').replace('/v1', ''))
  await act(async () => { container.querySelector<HTMLFormElement>('.setup__local')!.requestSubmit() })
  await until(() => text().includes('Hi! Ready when you are.'), 'it saying hi')
  expect((await peer.call<{ default: { model?: string } }>('agent.models', {})).default.model).toMatch(/\/qwen3:32b$/)
})

it('finds any other provider in setup itself, and adds an endpoint of your own there', async () => {
  const baseUrl = await mockOllama()
  await start()
  await mount()
  await until(() => Boolean(rowOf('More providers')), 'the ways in')
  expect(rowOf('More providers')!.textContent).toContain('Amazon Bedrock, Google Vertex AI, Azure and')
  await click(way('More providers'))
  await type(container.querySelector<HTMLInputElement>('.setup__open input[type=search]')!, 'groq')
  expect([...container.querySelectorAll('.setup__provider .setup__what')].map((n) => n.textContent)).toEqual(['Groq'])
  await click(button('Add your own OpenAI-compatible endpoint'))
  await type(container.querySelector<HTMLInputElement>('#provider-name')!, 'Mine')
  await type(container.querySelector<HTMLInputElement>('#provider-url')!, baseUrl)
  await act(async () => { container.querySelector<HTMLFormElement>('.provider-form')!.requestSubmit() })
  await until(() => text().includes('Hi! Ready when you are.'), 'it saying hi')
  expect((await peer.call<{ default: { model?: string } }>('agent.models', {})).default.model).toBe('mine/qwen3:32b')
})

it('stops a sign-in taken away before it ended, so nothing is left waiting on the browser', async () => {
  // A ChatGPT sign-in left running held its port, and the next one couldn't start.
  await start()
  await daemon.settings.set(ONBOARDED, true)
  const events = new Map<string, AuthEvent[]>()
  peer.on('auth.event', ({ flow, event }: Notifications['auth.event']) => events.set(flow, [...events.get(flow) ?? [], event]))
  let started = ''
  await mount(undefined, async () => {
    const answer = await peer.call<{ flow: string }>('auth.signIn', { provider: 'github-copilot', type: 'oauth' })
    started = answer.flow
    return answer
  })
  await until(() => Boolean(events.get(started)?.some((e) => e.type === 'prompt')), 'the flow asking')
  await act(async () => root!.unmount())
  root = undefined
  await until(() => events.get(started)?.at(-1)?.type === 'failed', 'the flow stopped')
  expect(events.get(started)!.at(-1)).toEqual({ type: 'failed', message: 'Cancelled' })
})

it('takes what an extension found as what it is, a line on it, and the model it runs: nothing else', () => {
  const found: SetupFound = { label: 'Claude Code', detail: 'Signed in', model: 'claude-agent/sonnet' }
  // @ts-expect-error A profile in place of the model was taken before 5.9 was released, and no longer is.
  const named: SetupFound = { label: 'Claude Code', detail: 'Signed in', profile: 'claude' }
  expect([found, named].map((f) => f.label)).toEqual(['Claude Code', 'Claude Code'])
})

it("says when an answer to a sign-in's question failed, and asks it again", async () => {
  await start()
  await daemon.settings.set(ONBOARDED, true)
  const events = new Map<string, AuthEvent[]>()
  peer.on('auth.event', ({ flow, event }: Notifications['auth.event']) => events.set(flow, [...events.get(flow) ?? [], event]))
  let started = ''
  await mount(undefined, async () => {
    const answer = await peer.call<{ flow: string }>('auth.signIn', { provider: 'github-copilot', type: 'oauth' })
    started = answer.flow
    return answer
  })
  await until(() => Boolean(container.querySelector('.auth-flow__prompt input')), 'the question')
  // Answered from another window first, say.
  const call = window.superego.call
  const answering = (method: string, params: unknown) => method === 'auth.respond' || (method === 'action.run' && (params as { id?: string }).id === 'auth.respond')
  window.superego.call = (machine, method, params) => answering(method, params) ? Promise.reject(new Error('That sign-in step is no longer waiting')) : call(machine, method, params)
  await type(container.querySelector<HTMLInputElement>('.auth-flow__prompt input')!, 'github.example.com')
  await act(async () => { container.querySelector<HTMLFormElement>('.auth-flow__prompt')!.requestSubmit() })
  await until(() => text().includes('That sign-in step is no longer waiting'), 'the failure')
  expect(container.querySelector('.auth-flow__prompt input')).not.toBeNull()
  window.superego.call = call
  await peer.call('auth.cancel', { flow: started })
})
