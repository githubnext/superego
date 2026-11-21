// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true}}}
// First-run setup, against a real daemon: it shows on a fresh data folder while no model works (and not when one
// does), finds a local model server (a mock, as Ollama), uses it, has it say hi, stars a model, and goes for good once
// done. Set up models… brings it back; from a composer that couldn't send, it goes back to that thread once done.
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon, type Daemon } from '@superego/daemon'
import { defineApp, ONBOARDED, PROTOCOL_VERSION, RELEASED, type Hello, type RpcPeer } from '@superego/protocol'
import type { MachineEntry, SuperegoEvent } from '../src/shared/bridge.ts'
import { RegistryProvider, useRegistry } from '../src/renderer/registry.tsx'
import { windowRegistry } from '../src/renderer/index.tsx'
import { NoModel, SetupPage, useSetup } from '../src/renderer/Setup.tsx'
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

/** An OpenAI-compatible server, as Ollama is: two models, and one line for every chat. */
async function mockOllama() {
  server = createServer((request, response) => {
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
function Main({ card }: { card?: string }) {
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
  return h('div', null,
    card && local && selected.selection ? h(NoModel, { machine: local, back: { machine: 'local', thread: card } }) : null,
    setup ? h(SetupPage, { key: setup, machine: setup }) : h('p', { className: 'empty' }, 'Select or start a thread.'))
}

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) }
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await settle() }
  throw new Error(`waiting for ${what}: ${container.textContent}`)
}
async function mount(card?: string) {
  const registry = windowRegistry(app, [])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(h(RegistryProvider, { registry, children: h(ShellStateProvider, { children: h(Main, { card }) }) })) })
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
  expect(rowOf('Ollama')!.textContent).toContain('llama3.1:8b, qwen3:32b')

  await click(rowOf('Ollama')!.querySelector('button')!)
  await until(() => text().includes('Hi! Ready when you are.'), 'it saying hi')
  expect((await peer.call<{ default: { model?: string } }>('agent.models', {})).default.model).toMatch(/^ollama\//)

  // A star, as the model menus have it.
  await click(button('Star qwen3:32b'))
  await until(async () => ((await value('agent.favourites')) as string[] | null)?.includes('ollama/qwen3:32b') ?? false, 'starred')

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

it("doesn't show when a model works already, and counts as done", async () => {
  await start({ faux: true })
  await mount()
  await until(async () => (await value(ONBOARDED)) === true, 'setup done')
  expect(page()).toBeNull()
  expect(text()).toContain('Select or start a thread.')
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
  await until(() => text().includes('No model is set up on This computer.'), 'the card')
  await click(button('Set up models…'))
  await until(() => Boolean(rowOf('Ollama')), 'the page, for the thread')
  await click(rowOf('Ollama')!.querySelector('button')!)
  await until(() => Boolean(container.querySelector('.setup__bubble')), 'it answering')
  await click(button('Back to the thread'))
  await until(() => selection?.thread === thread.id && !page(), 'back at the thread')
})
