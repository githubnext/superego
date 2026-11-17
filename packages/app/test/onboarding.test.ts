// @vitest-environment happy-dom
// The first-launch page, against a real daemon: it shows on a fresh data folder with nothing selected, its switches are
// Settings → Extensions' own (`extensions.<name>`, one by one and all at once), and Get started puts it away for good.
// Show onboarding brings it back.
import { mkdtemp, rm } from 'node:fs/promises'
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
import { Onboarding, useOnboarding } from '../src/renderer/Onboarding.tsx'
import { ShellStateProvider, useMachines, useSelection } from '../src/renderer/state.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const app = defineApp({ name: 'Superego', id: 'superego' })

let dir: string
let daemon: Daemon
let peer: RpcPeer
let close: () => Promise<void>
let root: Root | undefined
let container: HTMLElement

beforeEach(async () => {
  process.env.SUPEREGO_MODEL = 'faux'
  dir = await mkdtemp(join(tmpdir(), 'superego-onboarding-'))
  daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 'superego.sock'))
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
  localStorage.clear()
  close = async () => { connected.socket.destroy(); server.close(); await daemon.close() }
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
  await close()
  await rm(dir, { recursive: true, force: true })
})

let select: ReturnType<typeof useSelection>['select']
/** Where the shell puts it: in place of "Select or start a thread", with the router's context as the shell sets it. */
function Main() {
  const registry = useRegistry()
  const machines = useMachines()
  const selection = useSelection()
  select = selection.select
  registry.router.setContext({
    app, machines, selection: selection.selection, select: selection.select, openSettings() {}, newThread() {}, togglePalette() {}, toggleNavigator() {}, togglePanePicker() {},
    showLog() {}, threadOf: () => undefined, projects: [], sidebar: { pinned: [], projects: [], folded: [] }, lastThread: {}, fold() {}, appSetting: () => undefined, toggleSidebar() {}, back() {}, forward() {}, railTabs: () => [],
  })
  return useOnboarding() ? h(Onboarding) : h('p', { className: 'empty' }, 'Select or start a thread.')
}

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) }
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) { if (check()) return; await settle() }
  throw new Error(`waiting for ${what}: ${container.textContent}`)
}
async function mount() {
  const registry = windowRegistry(app, [])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(h(RegistryProvider, { registry, children: h(ShellStateProvider, { children: h(Main) }) })) })
  await settle()
  return registry
}
const page = () => container.querySelector('.onboarding')
const rows = () => [...container.querySelectorAll<HTMLElement>('.onboarding__extension')]
const switchOf = (name: string) => container.querySelector<HTMLElement>(`[data-extension="${name}"] [role="switch"]`)!
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const click = async (element: HTMLElement) => { await act(async () => { element.click() }); await settle() }
const value = async (key: string) => (await daemon.settings.snapshot()).values[key]

it('shows on a fresh folder, with Settings → Extensions as its switches, and goes for good on Get started', async () => {
  await mount()
  await until(() => rows().length > 0, 'the page')
  // The machine's own optional extensions, as Settings lists them.
  const listed = (await daemon.settings.snapshot()).sections.find((s) => s.id === 'extensions')!.settings.map((s) => s.key.slice('extensions.'.length))
  expect(rows().map((row) => row.dataset.extension)).toEqual(listed)
  const name = listed[0]!
  expect(switchOf(name).getAttribute('aria-checked')).toBe('true')

  // One switch: the very setting, on this machine.
  await click(switchOf(name))
  await until(() => switchOf(name).getAttribute('aria-checked') === 'false', 'the switch off')
  expect(await value(`extensions.${name}`)).toBe(false)

  // All off, then all on.
  await click(button('Disable all'))
  await until(() => rows().every((row) => row.querySelector('[role="switch"]')!.getAttribute('aria-checked') === 'false'), 'all off')
  for (const n of listed) expect(await value(`extensions.${n}`)).toBe(false)
  expect(button('Disable all').disabled).toBe(true)
  await click(button('Enable all'))
  await until(() => rows().every((row) => row.querySelector('[role="switch"]')!.getAttribute('aria-checked') === 'true'), 'all on')
  for (const n of listed) expect(await value(`extensions.${n}`)).toBe(true)

  await click(button('Get started'))
  await until(() => !page(), 'the page gone')
  expect(await value(ONBOARDED)).toBe(true)
  // A new window on the same machine: not again.
  await act(async () => root!.unmount())
  root = undefined
  container.remove()
  await mount()
  await settle()
  expect(page()).toBeNull()
  expect(container.textContent).toContain('Select or start a thread.')
})

it('comes back on Show onboarding, and goes when a thread is picked', async () => {
  await daemon.settings.set(ONBOARDED, true)
  const registry = await mount()
  await settle()
  expect(page()).toBeNull()
  await act(async () => { await registry.router.dispatch('app.onboarding') })
  await until(() => Boolean(page()), 'the page again')
  const thread = await peer.call<{ id: string }>('thread.start', { title: 'picked' })
  await act(async () => { select({ machine: 'local', thread: thread.id }) })
  await until(() => !page(), 'the page gone for a thread')
  await act(async () => { select(undefined) })
  await settle()
  expect(page()).toBeNull()
})

it('steps aside for a selected thread, unseen still', async () => {
  const thread = await peer.call<{ id: string }>('thread.start', { title: 'first' })
  await mount()
  await until(() => Boolean(page()), 'the page')
  await act(async () => { select({ machine: 'local', thread: thread.id }) })
  await until(() => !page(), 'the page aside')
  expect(await value(ONBOARDED)).toBe(false)
  await act(async () => { select(undefined) })
  await until(() => Boolean(page()), 'the page back')
})
