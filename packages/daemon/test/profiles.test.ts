import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, PROTOCOL_VERSION, type ProfileInfo, type RpcPeer, type SessionInfo } from '@mu/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

const MU = defineApp({ name: 'mu', id: 'mu' })
let dir: string
let home: string
let project: string

const open = async () => {
  process.env.MU_MODEL = 'faux'
  const daemon = await openDaemon({ app: MU, dataDir: home, defaultCwd: dir })
  const server = await listen(daemon, join(home, 'mu.sock'))
  const { peer, socket } = await connectSocket(join(home, 'mu.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

/** Write `files` (path → content) under `root`. */
const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

/** The extensions and instructions a session's agent has, once a turn configured it. */
async function agentOf(peer: RpcPeer, id: string) {
  const { value } = await peer.call<{ value: { docs: Record<string, unknown> } }>('session.watch', { id })
  const agent = value.docs['pi.agent'] as { extensions?: string[]; instructions?: string } | undefined
  return { extensions: agent?.extensions ?? [], instructions: agent?.instructions }
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 30)) }
  throw new Error('timed out')
}
const done = (peer: RpcPeer, id: string) => until(async () => (await peer.call<SessionInfo[]>('session.list', {})).find((s) => s.id === id)?.status.state === 'done')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mu-profiles-'))
  home = join(dir, 'home')
  project = join(dir, 'acme')
  mkdirSync(join(project, 'src'), { recursive: true })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('runs plain mu where there are no profiles', async () => {
  const { peer, close } = await open()
  const session = await peer.call<SessionInfo>('session.create', { cwd: project })
  expect(session.profile).toBeUndefined()
  expect(await peer.call<ProfileInfo[]>('profile.list', { cwd: project })).toEqual([])
  await close()
})

it("takes the user's default profile: its prompt and model", async () => {
  write(join(home, 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'mu'\nexport default defineProfile({ description: 'Mine', prompt: 'Answer in haiku.' })\n`,
  })
  const { peer, close } = await open()
  const session = await peer.call<SessionInfo>('session.create', { cwd: project, prompt: 'hello' })
  expect(session.profile).toEqual({ name: 'default', scope: 'user' })
  await done(peer, session.id)
  const agent = await agentOf(peer, session.id)
  expect(agent.instructions).toBe('Answer in haiku.')
  await close()
})

it("runs a project's profile and its extensions only once allowed, and again after it changes", async () => {
  const profile = join(project, '.mu', 'profiles', 'support')
  write(profile, {
    'profile.ts': `import { defineProfile } from 'mu'\nexport default defineProfile({ prompt: 'You answer customer email.', extensions: ['./orders.ts'], without: ['ask-user'] })\n`,
    'orders.ts': `import { defineExtension, defineTool, obj, str } from 'mu'
export default defineExtension({
  name: 'orders',
  tools: [defineTool({
    name: 'find_order', label: 'Find order', description: 'Look up an order by number.',
    parameters: obj({ number: str() }),
    async execute({ number }) { return { output: [{ type: 'text', text: 'Order ' + number + ' shipped' }] } },
  })],
})
`,
  })
  const { peer, close } = await open()
  const listed = await peer.call<ProfileInfo[]>('profile.list', { cwd: join(project, 'src') })
  expect(listed).toMatchObject([{ name: 'support', scope: 'project', allowed: false }])
  await expect(peer.call('session.create', { cwd: project, profile: 'support' })).rejects.toMatchObject({ kind: 'untrusted_profile' })

  await peer.call('profile.allow', { cwd: project, name: 'support' })
  const session = await peer.call<SessionInfo>('session.create', { cwd: join(project, 'src'), profile: 'support', prompt: 'where is 42?' })
  expect(session.profile).toEqual({ name: 'support', scope: 'project' })
  await done(peer, session.id)
  const agent = await agentOf(peer, session.id)
  expect(agent.extensions).toContain('project:support/orders')
  expect(agent.extensions).toContain('coding-tools')
  expect(agent.extensions).not.toContain('ask-user')
  expect(agent.instructions).toBe('You answer customer email.')

  // An edit is new code: the next turn waits for it to be allowed.
  write(profile, { 'orders.ts': `export default { name: 'orders' }\n` })
  await expect(peer.call('session.submit', { id: session.id, text: 'again' })).rejects.toMatchObject({ kind: 'untrusted_profile' })
  await close()
})

it("lets a project's profile replace the user's, or extend it", async () => {
  write(join(home, 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'mu'\nexport default defineProfile({ prompt: 'Be kind.' })\n`,
  })
  write(join(project, '.mu', 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'mu'\nexport default defineProfile({ extends: 'user:default', prompt: 'Know the Acme codebase.' })\n`,
  })
  const { peer, close } = await open()
  expect((await peer.call<ProfileInfo[]>('profile.list', { cwd: project })).map((p) => `${p.scope}:${p.name}`)).toEqual(['project:default'])
  await peer.call('profile.allow', { cwd: project })
  const session = await peer.call<SessionInfo>('session.create', { cwd: project, prompt: 'hi' })
  expect(session.profile).toEqual({ name: 'default', scope: 'project' })
  await done(peer, session.id)
  expect((await agentOf(peer, session.id)).instructions).toBe('Be kind.\n\nKnow the Acme codebase.')
  await close()
})

it("keeps the test shim for 'mu' in step with the SDK", async () => {
  const { SDK_EXPORTS } = await import('../src/profiles.ts')
  const shim = await import('../src/sdk-shim.ts')
  expect(Object.keys(shim).filter((key) => key !== 'default').sort()).toEqual([...SDK_EXPORTS].sort())
})
