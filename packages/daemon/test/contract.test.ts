// The frozen contract (packages/protocol/contract.json): what a bare daemon serves, which only grows within a protocol
// generation. A method, notification or feature named there must never disappear; a new one is added to the file, so
// it is frozen from then on.
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, NOTIFICATIONS, PROTOCOL_VERSION, type Hello } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'

const CONTRACT = new URL('../../protocol/contract.json', import.meta.url)
const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as { generation: number; methods: string[]; notifications: string[]; features: string[] }
const HOW = 'Add it to packages/protocol/contract.json (sorted); once there, it stays for this generation.'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-contract-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function bareHello(): Promise<Hello> {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: defineApp({ name: 'superego', id: 'superego' }), dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  try {
    return await peer.call<Hello>('hello', { client: 'contract', version: PROTOCOL_VERSION })
  } finally {
    socket.destroy()
    server.close()
    await daemon.close()
  }
}

const without = (all: readonly string[], some: readonly string[]) => all.filter((name) => !some.includes(name)).sort()

it('is the contract of this protocol generation', () => {
  expect(contract.generation, 'A new generation starts a new contract: freeze the old one under its number first.').toBe(PROTOCOL_VERSION)
})

it('keeps everything the frozen contract names', async () => {
  const hello = await bareHello()
  expect(without(contract.methods, hello.methods), 'Methods a daemon no longer serves; the table only grows').toEqual([])
  expect(without(contract.features, hello.features), 'Features a daemon no longer announces').toEqual([])
  expect(without(contract.notifications, NOTIFICATIONS), 'Notifications gone from the protocol').toEqual([])
})

it('names everything a bare daemon serves', async () => {
  const hello = await bareHello()
  expect(without(hello.methods, contract.methods), `New methods. ${HOW}`).toEqual([])
  expect(without(hello.features, contract.features), `New features. ${HOW}`).toEqual([])
  expect(without(NOTIFICATIONS, contract.notifications), `New notifications. ${HOW}`).toEqual([])
})
