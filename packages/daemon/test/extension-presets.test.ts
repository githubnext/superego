// A machine's preset of extensions (Settings → Extensions' "Start from"): Full unless Core is picked, each switch the
// preset's until the user changes it, so a new extension follows the preset; experimental ones apart, on or off by their
// own word, and left as they are when a preset is picked again.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, inPreset, onByDefault, PROTOCOL_VERSION, type Hello, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonExtension } from '../src/index.ts'
import { until } from './until.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-presets-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const terminal = defineDaemonExtension({ name: 'terminal', title: 'Terminal', group: 'beside' })
const images = defineDaemonExtension({ name: 'images', title: 'Images', group: 'thread', core: true })
const claude = defineDaemonExtension({ name: 'claude-agent', title: 'Claude Agent', experimental: true })
const lab = defineDaemonExtension({ name: 'lab', title: 'Lab', experimental: 'off' })

async function open(extensions: DaemonExtension[]) {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  const snapshot = async () => (await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})).value
  /** Each optional extension's switch, by name. */
  const on = async () => {
    const { values } = await snapshot()
    return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('extensions.') && key !== 'extensions.preset').map(([key, value]) => [key.slice('extensions.'.length), value]))
  }
  return { peer, daemon, snapshot, on, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

it('puts an extension in a preset by what it says of itself: Core its few, Full all but the experimental', () => {
  expect(inPreset({ core: true }, 'core')).toBe(true)
  expect(inPreset({}, 'core')).toBe(false)
  expect(inPreset({}, 'full')).toBe(true)
  expect(inPreset({ experimental: true }, 'full')).toBe(false)
  expect(inPreset({ experimental: true, core: true }, 'core')).toBe(false)
  // Apart from the presets, an experimental one is on by its own word: unless it says 'off'.
  expect(onByDefault({ experimental: true }, 'core')).toBe(true)
  expect(onByDefault({ experimental: 'off' }, 'full')).toBe(false)
  expect(onByDefault({ core: true }, 'core')).toBe(true)
  expect(onByDefault({}, 'core')).toBe(false)
})

it('starts from Full, the experimental as each says; Core turns on only its own, and a thread goes without the rest', async () => {
  const { peer, snapshot, on, close } = await open([terminal, images, claude, lab])
  expect((await snapshot()).values['extensions.preset']).toBe('full')
  expect(await on()).toEqual({ 'coding-tools': true, panes: true, 'agents-md': true, terminal: true, images: true, 'claude-agent': true, lab: false })

  await peer.call('extensions.preset', { preset: 'core' })
  expect(await on()).toEqual({ 'coding-tools': true, panes: true, 'agents-md': true, terminal: false, images: true, 'claude-agent': true, lab: false })
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)?.without?.join() === 'lab,terminal')
  // What each switch is when the user hasn't changed it: the preset's word, said with the rows Settings draws.
  const section = (await snapshot()).sections.find((s) => s.id === 'extensions')!
  expect(section.ui).toBe('extensions')
  expect(section.settings.find((s) => s.key === 'extensions.terminal')!.default).toBe(false)
  expect(section.data).toContainEqual({ name: 'images', title: 'Images', group: 'thread', core: true })
  expect(section.data).toContainEqual({ name: 'claude-agent', title: 'Claude Agent', experimental: true })
  expect(section.data).toContainEqual({ name: 'lab', title: 'Lab', experimental: 'off' })
  await close()
})

it("keeps the user's changes over the preset, until a preset is picked again: but not an experimental one's", async () => {
  const { peer, daemon, on, close } = await open([terminal, images, claude, lab])
  await peer.call('settings.set', { key: 'extensions.terminal', value: false })
  await peer.call('settings.set', { key: 'extensions.claude-agent', value: false })
  await peer.call('settings.set', { key: 'extensions.lab', value: true })
  expect(await on()).toMatchObject({ terminal: false, images: true, 'claude-agent': false, lab: true })

  await peer.call('extensions.preset', { preset: 'full' })
  expect(await on()).toMatchObject({ terminal: true, images: true, 'claude-agent': false, lab: true })
  expect(daemon.settings.isSet('extensions.terminal')).toBe(false)

  await peer.call('settings.set', { key: 'extensions.images', value: false })
  await peer.call('extensions.preset', { preset: 'core' })
  expect(await on()).toMatchObject({ terminal: false, images: true, 'claude-agent': false, lab: true })
  await expect(peer.call('extensions.preset', { preset: 'most' })).rejects.toMatchObject({ kind: 'invalid_params' })
  await close()
})

it('has an extension new to the machine follow the preset underneath, the changes kept', async () => {
  const first = await open([images])
  await first.peer.call('extensions.preset', { preset: 'core' })
  await first.peer.call('settings.set', { key: 'extensions.images', value: false })
  await first.close()

  // A release later, with two more: the one not in Core comes in off, the one in it on; the change stays.
  const mermaid = defineDaemonExtension({ name: 'mermaid', title: 'Mermaid', group: 'thread' })
  const ego = defineDaemonExtension({ name: 'ego', title: 'Ego', group: 'around', core: true })
  const again = await open([images, mermaid, ego])
  expect(await again.on()).toMatchObject({ images: false, mermaid: false, ego: true })
  // A window's, declared: in Core too.
  await again.peer.call('extension.declare', { extensions: [{ name: 'links', title: 'Links', group: 'thread' }, { name: 'focus', title: 'Focus', core: true }] })
  expect(await again.on()).toMatchObject({ links: false, focus: true })
  // Full: all of them, and the change undone.
  await again.peer.call('extensions.preset', { preset: 'full' })
  expect(await again.on()).toMatchObject({ images: true, mermaid: true, ego: true, links: true, focus: true })
  await again.close()
})

it("takes only an about's own groups, core only as true and experimental as true or 'off'", async () => {
  const { peer, snapshot, close } = await open([])
  await peer.call('extension.declare', { extensions: [{ name: 'links', group: 'sidebar', core: 'yes', experimental: 1 }, { name: 'focus', experimental: 'on' }] })
  const data = (await snapshot()).sections.find((s) => s.id === 'extensions')!.data
  expect(data).toContainEqual({ name: 'links' })
  expect(data).toContainEqual({ name: 'focus' })
  await close()
})
