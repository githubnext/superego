// The extension contract as a daemon keeps it: an extension the host's API can't serve is refused, what each extension
// set up is at is announced (hello, features.changed), windows' declarations are settled the same whatever order they
// come in, and the core still answers all its protocol generation released.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { contractProblem, defineApp, EXTENSION_API, FEATURES, PROTOCOL_VERSION, RELEASED, type ExtensionAbout, type ExtensionManifest, type Hello, type RpcPeer } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonExtension } from '../src/index.ts'
import { until } from './until.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-contract-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function open(extensions: DaemonExtension[] = [], dataDir = dir) {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions })
  const server = await listen(daemon, join(dataDir, 'superego.sock'))
  const connect = async () => {
    const { peer, socket } = await connectSocket(join(dataDir, 'superego.sock'))
    const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
    return { peer, hello, socket }
  }
  const first = await connect()
  return { ...first, connect, close: async () => { first.socket.destroy(); server.close(); await daemon.close() } }
}

it("refuses an extension that needs an extension API this host isn't, saying which", async () => {
  await expect(open([defineDaemonExtension({ name: 'future', version: '1.0.0', api: '^6', setup() {} })]))
    .rejects.toThrow(`Extension future needs extension API ^6, and this Superego has ${EXTENSION_API}: update Superego`)
  await expect(open([defineDaemonExtension({ name: 'sloppy', version: 'one', setup() {} })])).rejects.toThrow(/isn't major.minor.patch/)
  // Never set up: nothing of it ran.
  let ran = false
  await expect(open([defineDaemonExtension({ name: 'future', api: '>=6', setup() { ran = true } })])).rejects.toThrow(/needs extension API >=6/)
  expect(ran).toBe(false)
})

it("refuses a profile's extension that needs a newer extension API, when the profile loads", async () => {
  const home = join(dir, 'home')
  const profile = join(home, 'profiles', 'default')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./next.ts'] })\n`)
  writeFileSync(join(profile, 'next.ts'), `import { defineDaemonExtension } from 'superego'\nexport default defineDaemonExtension({ name: 'next', version: '3.0.0', api: '^5.8', setup() {} })\n`)
  const { peer, close } = await open([], home)
  await expect(peer.call('thread.start', { cwd: dir })).rejects.toThrow(/Extension next needs extension API \^5.8, and this Superego has 5.7.0/)
  await close()
})

it('announces each extension at its version, in hello and as it changes', async () => {
  const git = defineDaemonExtension({ name: 'git', version: '1.3.0', api: '^5', setup() {} })
  const mine = defineDaemonExtension({ name: 'mine', setup() {} })
  const { peer, hello, close } = await open([git, mine])
  expect(hello.api).toBe(EXTENSION_API)
  // Extensions are in `extensions` only: `features` is the protocol's.
  expect(hello.features).toEqual([...FEATURES])
  const of = (list: ExtensionManifest[] | undefined, name: string) => list?.find((e) => e.name === name)
  expect(of(hello.extensions, 'git')).toEqual({ name: 'git', version: '1.3.0', api: '^5' })
  // One that says no version is announced without one: clients count it 0.0.0.
  expect(of(hello.extensions, 'mine')).toEqual({ name: 'mine' })
  // The core's own are extensions too, at 1.0.0.
  expect(of(hello.extensions, 'coding-tools')).toMatchObject({ version: '1.0.0', api: '^5' })
  const told: { features: string[]; extensions: ExtensionManifest[] }[] = []
  peer.on('features.changed', (params: (typeof told)[number]) => { told.push(params) })
  await peer.call('settings.set', { key: 'extensions.git', value: false })
  await until(() => told.length === 1)
  expect(of(told[0]!.extensions, 'git')).toBeUndefined()
  await peer.call('settings.set', { key: 'extensions.git', value: true })
  await until(() => told.length === 2)
  expect(of(told[1]!.extensions, 'git')).toMatchObject({ version: '1.3.0' })
  await close()
})

it("still answers every method and action its protocol generation released, and refuses another generation", async () => {
  const { peer, hello, close } = await open()
  expect(RELEASED.generation).toBe(PROTOCOL_VERSION)
  for (const method of RELEASED.methods) expect(hello.methods, `${method} was released in generation ${RELEASED.generation}`).toContain(method)
  for (const feature of RELEASED.features) expect(hello.features).toContain(feature)
  await expect(peer.call('hello', { client: 'test', version: PROTOCOL_VERSION + 1 })).rejects.toMatchObject({ kind: 'version_mismatch' })
  await close()
})

/** What the machine's Settings says of `name`: its switch's title, or nothing. */
async function switchOf(peer: RpcPeer, name: string) {
  const { value } = await peer.call<{ value: { sections: { id: string; settings: { key: string; title: string; description?: string }[] }[] } }>('settings.watch', {})
  return value.sections.find((s) => s.id === 'extensions')?.settings.find((s) => s.key === `extensions.${name}`)
}

it('settles windows that declare one extension differently the same whatever order they come in: the newest version', async () => {
  const declarations: ExtensionAbout[] = [
    { name: 'links', version: '1.0.0', title: 'Links' },
    { name: 'links', version: '1.2.0', title: 'Web links' },
    { name: 'links', version: '1.2.0', title: 'Other links' },
    { name: 'links', title: 'Old links' },
    { name: 'links', version: '1.1.0', title: 'Middle links' },
  ]
  const orders = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [3, 0, 4, 1, 2]]
  const outcomes: string[] = []
  for (const [i, order] of orders.entries()) {
    const data = join(dir, `order-${i}`)
    mkdirSync(data, { recursive: true })
    const { connect, close } = await open([], data)
    // Each from a window of its own.
    for (const at of order) {
      const { peer, socket } = await connect()
      await peer.call('extension.declare', { extensions: [declarations[at]!] })
      socket.destroy()
    }
    const { peer, socket } = await connect()
    outcomes.push((await switchOf(peer, 'links'))!.title)
    socket.destroy()
    await close()
  }
  // The newest wins; the two at the newest version are settled by what they say, the same each time.
  expect(outcomes).toEqual(['Web links', 'Web links', 'Web links'])
})

it("never lets an older window's declaration take back what a newer one said", async () => {
  const { peer, close } = await open()
  await peer.call('extension.declare', { extensions: [{ name: 'links', version: '2.0.0', title: 'Links', required: true }] })
  await peer.call('extension.declare', { extensions: [{ name: 'links', version: '1.4.0', title: 'Links' }] })
  await peer.call('extension.declare', { extensions: [{ name: 'links', title: 'Links' }] })
  // Required: no switch.
  expect(await switchOf(peer, 'links')).toBeUndefined()
  // A version that isn't one is ignored.
  await peer.call('extension.declare', { extensions: [{ name: 'links', version: '9', title: 'Bad' }] })
  expect(await switchOf(peer, 'links')).toBeUndefined()
  await close()
})

it('has every bundled extension say its version and the API it needs, which this host gives', async () => {
  const { existsSync, readdirSync } = await import('node:fs')
  const root = join(import.meta.dirname, '../../../extensions')
  // Every extension that's here: a folder with a package (a renamed one leaves its ignored node_modules behind).
  const names = readdirSync(root).filter((name) => existsSync(join(root, name, 'package.json')))
  const abouts: ExtensionAbout[] = []
  for (const name of names) {
    const shared = await import(join(root, name, 'src/shared.ts')) as Record<string, unknown>
    abouts.push(...Object.values(shared).filter((v): v is ExtensionAbout => Boolean(v && typeof v === 'object' && 'name' in v && ('title' in v || 'required' in v))))
  }
  expect(abouts.length).toBeGreaterThanOrEqual(names.length)
  for (const about of abouts) {
    expect(about.version, about.name).toMatch(/^\d+\.\d+\.\d+$/)
    expect(about.api, about.name).toBeDefined()
    expect(contractProblem(about), about.name).toBeUndefined()
  }
})

// The params of the core's released actions (packages/protocol/src/released-actions.json, as a bare daemon's
// action.list gave them): a released action may gain optional fields, never lose one, change one's type, or require one
// a caller of the released schema wouldn't send.
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[]; enum?: unknown[]; const?: unknown }
const FROZEN = new URL('../../protocol/src/released-actions.json', import.meta.url)

/** How `now` breaks a caller written against `frozen`: each a path and what changed. Nothing when it only grew. */
function breaks(frozen: Schema | null, now: Schema | null, at = 'params'): string[] {
  const was = frozen ?? { type: 'object', properties: {} }
  const is = now ?? { type: 'object', properties: {} }
  const found: string[] = []
  if (was.type !== is.type && (was.type !== undefined || is.type !== undefined)) found.push(`${at}: was ${was.type ?? 'anything'}, is ${is.type ?? 'anything'}`)
  if ('const' in was && was.const !== is.const) found.push(`${at}: was ${JSON.stringify(was.const)}, is ${JSON.stringify(is.const)}`)
  for (const value of was.enum ?? []) if (!is.enum?.includes(value)) found.push(`${at}: no longer takes ${JSON.stringify(value)}`)
  for (const option of was.anyOf ?? []) {
    if (!is.anyOf?.some((other) => breaks(option, other, at).length === 0)) found.push(`${at}: no longer takes ${JSON.stringify(option)}`)
  }
  for (const [key, schema] of Object.entries(was.properties ?? {})) {
    const next = is.properties?.[key]
    if (!next) found.push(`${at}.${key}: gone`)
    else found.push(...breaks(schema, next, `${at}.${key}`))
  }
  for (const key of is.required ?? []) if (!(was.required ?? []).includes(key)) found.push(`${at}.${key}: now required`)
  if (was.items) found.push(...breaks(was.items, is.items ?? null, `${at}[]`))
  return found
}

it('keeps the params of every released action: fields are only ever added, and optional', async () => {
  const frozen = JSON.parse(readFileSync(FROZEN, 'utf8')) as Record<string, Schema | null>
  const { peer, close } = await open()
  const list = await peer.call<{ id: string; params?: Schema }[]>('action.list', {})
  await close()
  const actions = Object.fromEntries(list.map((a) => [a.id, a.params ?? null]))
  const broken = Object.entries(frozen).flatMap(([id, schema]) => id in actions ? breaks(schema, actions[id]!, id) : [`${id}: gone`])
  expect(broken, 'Changes to released params that break callers. Add an optional field instead.').toEqual([])
  expect(Object.keys(actions).filter((id) => !(id in frozen)).sort(), 'New core actions: add them, with their params from action.list, to packages/protocol/src/released-actions.json').toEqual([])
})

it('tells growing params from breaking them', () => {
  const frozen: Schema = { type: 'object', properties: { id: { type: 'string' }, kind: { anyOf: [{ const: 'a' }, { const: 'b' }] }, n: { type: 'number' } }, required: ['id'] }
  expect(breaks(frozen, { ...frozen, properties: { ...frozen.properties, extra: { type: 'boolean' } } })).toEqual([])
  expect(breaks(frozen, { ...frozen, properties: { ...frozen.properties, kind: { anyOf: [{ const: 'a' }, { const: 'b' }, { const: 'c' }] } } })).toEqual([])
  expect(breaks(frozen, { ...frozen, properties: { id: { type: 'string' }, kind: frozen.properties!.kind! } })).toEqual(['params.n: gone'])
  expect(breaks(frozen, { ...frozen, properties: { ...frozen.properties, n: { type: 'string' } } })).toEqual(['params.n: was number, is string'])
  expect(breaks(frozen, { ...frozen, properties: { ...frozen.properties, kind: { anyOf: [{ const: 'a' }] } } })).toEqual(['params.kind: no longer takes {"const":"b"}'])
  expect(breaks(frozen, { ...frozen, properties: { ...frozen.properties, extra: { type: 'string' } }, required: ['id', 'extra'] })).toEqual(['params.extra: now required'])
  expect(breaks(null, { type: 'object', properties: { x: { type: 'string' } } })).toEqual([])
  expect(breaks(null, { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] })).toEqual(['params.x: now required'])
})
