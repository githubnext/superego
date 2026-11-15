// The profile in a real daemon (from the Superego checkout): it loads, check_in is a tool, and a check-in set before a
// restart fires after it. Run as staff.test.ts says.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type ThreadInfo } from '@superego/protocol'

const staffFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'staff.ts')
const app = defineApp({ name: 'test', id: 'stafftest' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'staff-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
const until = async (check: () => Promise<boolean>, tries = 400) => {
  for (let i = 0; i < tries; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
async function open(turns: string[]) {
  await writeFile(join(dir, 'turns.jsonl'), turns.join('\n') + '\n')
  process.env.STAFFTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.STAFFTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  const entries = async (id: string) => JSON.stringify((await peer.call<{ value: { entries: unknown[] } }>('thread.watch', { id })).value.entries)
  return { peer, entries, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

it('fires a check-in set before a restart, after it', async () => {
  // The profile as the real one, but looking often.
  const profile = join(dir, 'profiles', 'chief-of-staff')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./ext.ts'] })\n`)
  await writeFile(join(profile, 'ext.ts'), `import { staff } from ${JSON.stringify(staffFile)}\nexport default staff({ tickMs: 200 })\n`)
  const first = await open([
    turn([{ type: 'toolCall', id: 'c1', name: 'check_in', arguments: { minutes: 0.05, note: 'Look at the lanes' } }], 'toolUse'),
    turn([{ type: 'text', text: 'Set.' }], 'stop'),
  ])
  const lead = await first.peer.call<ThreadInfo>('thread.create', { prompt: 'go', profile: 'chief-of-staff', title: 'Lead' })
  await until(async () => (await first.entries(lead.id)).includes('Set.'))
  expect(await first.entries(lead.id)).toContain('Check-in set for')
  await first.close()
  // Down past when it was due; up again, it comes.
  await new Promise((r) => setTimeout(r, 3_500))
  const second = await open([turn([{ type: 'text', text: 'Looked.' }], 'stop')])
  await until(async () => (await second.entries(lead.id)).includes('Looked.'))
  expect(await second.entries(lead.id)).toContain('Check-in: Look at the lanes')
  await second.close()
})
