// Whether a machine's onboarding was seen (ONBOARDED): not on a fresh data folder until it's set; kept across restarts;
// and a folder that already has threads, from before the flag, counts as seen.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, ONBOARDED, PROTOCOL_VERSION } from '@superego/protocol'
import { connectSocket, listen, openDaemon, type Daemon } from '../src/index.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
let daemon: Daemon | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-onboarding-')) })
afterEach(async () => { await daemon?.close(); daemon = undefined; await rm(dir, { recursive: true, force: true }) })

async function open() {
  process.env.SUPEREGO_MODEL = 'faux'
  await daemon?.close()
  daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  return daemon
}
const seen = async (d: Daemon) => (await d.settings.snapshot()).values[ONBOARDED]

it('is unseen on a fresh folder, seen once set, and stays so', async () => {
  let d = await open()
  expect(await seen(d)).toBe(false)
  // Hidden: Settings doesn't list it.
  const snapshot = await d.settings.snapshot()
  expect(snapshot.sections.find((s) => s.id === 'onboarding')?.settings.every((s) => s.hidden)).toBe(true)
  await d.settings.set(ONBOARDED, true)
  d = await open()
  expect(await seen(d)).toBe(true)
})

it('counts a folder with threads from before it as seen', async () => {
  let d = await open()
  const server = await listen(d, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  await peer.call('thread.start', { title: 'old' })
  socket.destroy()
  server.close()
  // Data from before the flag: threads, and no word of onboarding.
  const file = join(dir, 'settings.json')
  const values = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))
  delete values[ONBOARDED]
  await writeFile(file, JSON.stringify(values))
  d = await open()
  expect(await seen(d)).toBe(true)
})
