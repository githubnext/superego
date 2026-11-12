// The frozen contract (packages/protocol/contract.json): what a bare daemon serves, which only grows within a protocol
// generation. A method, notification, feature or action named there must never disappear; a new one is added to the
// file, so it is frozen from then on. A frozen action's params (its schema from `action.list`) may gain optional fields
// but never lose one, change one's type, or require one a caller of the frozen schema wouldn't send.
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, NOTIFICATIONS, PROTOCOL_VERSION, type ActionInfo, type Hello } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'

const CONTRACT = new URL('../../protocol/contract.json', import.meta.url)
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[]; enum?: unknown[]; const?: unknown }
const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as { generation: number; methods: string[]; notifications: string[]; features: string[]; actions: Record<string, Schema | null> }
const HOW = 'Add it to packages/protocol/contract.json (sorted); once there, it stays for this generation.'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-contract-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function bare(): Promise<{ hello: Hello; actions: Record<string, Schema | null> }> {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: defineApp({ name: 'superego', id: 'superego' }), dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  try {
    const hello = await peer.call<Hello>('hello', { client: 'contract', version: PROTOCOL_VERSION })
    const list = await peer.call<ActionInfo[]>('action.list', {})
    return { hello, actions: Object.fromEntries(list.map((action) => [action.id, (action.params as Schema | undefined) ?? null])) }
  } finally {
    socket.destroy()
    server.close()
    await daemon.close()
  }
}

const bareHello = async () => (await bare()).hello
const without = (all: readonly string[], some: readonly string[]) => all.filter((name) => !some.includes(name)).sort()

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

it('is the contract of this protocol generation', () => {
  expect(contract.generation, 'A new generation starts a new contract: freeze the old one under its number first.').toBe(PROTOCOL_VERSION)
})

it('keeps everything the frozen contract names', async () => {
  const hello = await bareHello()
  expect(without(contract.methods, hello.methods), 'Methods a daemon no longer serves; the table only grows').toEqual([])
  expect(without(contract.features, hello.features), 'Features a daemon no longer announces').toEqual([])
  expect(without(contract.notifications, NOTIFICATIONS), 'Notifications gone from the protocol').toEqual([])
})

it('keeps the params of every frozen action: fields are only ever added, and optional', async () => {
  const { actions } = await bare()
  expect(without(Object.keys(contract.actions), Object.keys(actions)), 'Actions a daemon no longer serves').toEqual([])
  const broken = Object.entries(contract.actions).flatMap(([id, frozen]) => id in actions ? breaks(frozen, actions[id]!, id) : [])
  expect(broken, 'Changes to frozen params that break callers. Add an optional field instead.').toEqual([])
  expect(without(Object.keys(actions), Object.keys(contract.actions)), `New actions. ${HOW.replace('(sorted)', 'with their params from action.list')}`).toEqual([])
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

it('names everything a bare daemon serves', async () => {
  const hello = await bareHello()
  expect(without(hello.methods, contract.methods), `New methods. ${HOW}`).toEqual([])
  expect(without(hello.features, contract.features), `New features. ${HOW}`).toEqual([])
  expect(without(NOTIFICATIONS, contract.notifications), `New notifications. ${HOW}`).toEqual([])
})
