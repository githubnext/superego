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
  expect(session.profile).toMatchObject({ name: 'default', scope: 'user' })
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
  expect(session.profile).toMatchObject({ name: 'support', scope: 'project' })
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
  expect(session.profile).toMatchObject({ name: 'default', scope: 'project' })
  await done(peer, session.id)
  expect((await agentOf(peer, session.id)).instructions).toBe('Be kind.\n\nKnow the Acme codebase.')
  await close()
})

it("keeps the test shim for 'mu' in step with the SDK", async () => {
  const { SDK_EXPORTS } = await import('../src/profiles.ts')
  const shim = await import('../src/sdk-shim.ts')
  expect(Object.keys(shim).filter((key) => key !== 'default').sort()).toEqual([...SDK_EXPORTS].sort())
})

it("serves a profile's UI modules, types stripped, only from inside it and only once allowed", async () => {
  const profile = join(project, '.mu', 'profiles', 'default')
  write(profile, {
    'profile.ts': `import { defineProfile } from 'mu'\nexport default defineProfile({ ui: ['./ui/badge.ts'] })\n`,
    'ui/badge.ts': `import { defineUiExtension, h } from 'mu/ui'\nimport { label } from './label.ts'\nconst n: number = 1\nexport default defineUiExtension({ name: 'badge', setup(mu) { mu.slot('session.header', () => h('span', null, label)) } })\n`,
    'ui/label.ts': `export const label: string = 'Acme'\n`,
  })
  const { peer, close } = await open()
  const ref = { scope: 'project', name: 'default', dir: profile }
  await expect(peer.call('profile.ui', ref)).rejects.toMatchObject({ kind: 'untrusted_profile' })
  await peer.call('profile.allow', { cwd: project })
  expect(await peer.call('profile.ui', ref)).toMatchObject({ entries: ['./ui/badge.ts'] })
  const badge = await peer.call<{ path: string; code: string }>('profile.module', { ...ref, path: 'ui/badge' })
  expect(badge.path).toBe('ui/badge.ts')
  expect(badge.code).not.toContain(': number')
  expect(badge.code).toContain(`from './label.ts'`)
  await expect(peer.call('profile.module', { ...ref, path: '../../../src/secret.ts' })).rejects.toMatchObject({ kind: 'invalid' })
  await expect(peer.call('profile.ui', { ...ref, dir: join(project, 'src') })).rejects.toMatchObject({ kind: 'not_found' })
  await close()
})

it("compiles a profile's UI written in TSX to calls into the window's React", async () => {
  write(join(home, 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'mu'\nexport default defineProfile({ ui: ['./ui/badge.tsx'] })\n`,
    'ui/badge.tsx': `import { defineUiExtension } from 'mu/ui'\nconst label: string = 'Acme'\nexport default defineUiExtension({ name: 'badge', setup(mu) { mu.slot('session.header', () => <span className="badge">{label}</span>) } })\n`,
  })
  const { peer, close } = await open()
  const ref = { scope: 'user', name: 'default', dir: join(home, 'profiles', 'default') }
  const badge = await peer.call<{ path: string; code: string }>('profile.module', { ...ref, path: 'ui/badge' })
  expect(badge.path).toBe('ui/badge.tsx')
  expect(badge.code).toContain('react/jsx-runtime')
  expect(badge.code).not.toContain('<span')
  expect(badge.code).not.toContain(': string')
  await close()
})

it("sets up a profile's daemon extensions (actions, values, tools of their own) and tears them down when it changes", async () => {
  const profile = join(home, 'profiles', 'default')
  const extension = (answer: string) => `import { defineDaemonExtension, defineAction, defineExtension, defineTool, obj, str } from 'mu'
export default defineDaemonExtension({
  name: 'vault',
  setup(mu) {
    const count = mu.value('vault.count', 0)
    mu.action(defineAction({ id: 'vault.answer', title: 'Answer', params: obj({ id: str() }), async run({ id }) {
      const session = (await mu.sessions.list()).find((s) => s.id === id)
      count.update((n) => n + 1)
      return { answer: '${answer}', cwd: session.cwd }
    } }))
    mu.agent(defineExtension({ name: 'notes', tools: [defineTool({ name: 'note', description: 'A note.', parameters: obj({}), async execute() { return { output: [{ type: 'text', text: 'hi' }] } } })] }))
  },
})
`
  write(profile, { 'profile.ts': `import { defineProfile } from 'mu'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': extension('one') })
  const { peer, close } = await open()
  const session = await peer.call<SessionInfo>('session.create', { cwd: project, prompt: 'hi' })
  await done(peer, session.id)
  expect(await peer.call('action.run', { id: 'vault.answer', params: { id: session.id } })).toEqual({ answer: 'one', cwd: project })
  expect((await peer.call<{ value: number }>('value.watch', { key: 'vault.count' })).value).toBe(1)
  expect((await agentOf(peer, session.id)).extensions).toContain('user:default/notes')
  // Changed: the old action goes, the new one answers.
  write(profile, { 'vault.ts': extension('two') })
  await peer.call('session.submit', { id: session.id, text: 'again' })
  expect(await peer.call('action.run', { id: 'vault.answer', params: { id: session.id } })).toMatchObject({ answer: 'two' })
  await close()
})

it("undoes a profile's actions when a later part of it fails, so it loads once fixed", async () => {
  const profile = join(home, 'profiles', 'default')
  // Its action registers, then its agent extension fails to install (a section key pi refuses).
  const extension = (key: string) => `import { defineDaemonExtension, defineAction, defineExtension, obj, section } from 'mu'
export default defineDaemonExtension({
  name: 'vault',
  setup(mu) {
    mu.action(defineAction({ id: 'vault.ping', title: 'Ping', params: obj({}), async run() { return 'pong' } }))
    mu.agent(defineExtension({ name: 'notes', sections: [section('${key}', () => 'notes')] }))
  },
})
`
  write(profile, { 'profile.ts': `import { defineProfile } from 'mu'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': extension('Not A Key') })
  const { peer, close } = await open()
  await expect(peer.call('session.create', { cwd: project })).rejects.toThrow(/Section key/)
  write(profile, { 'vault.ts': extension('notes') })
  await peer.call<SessionInfo>('session.create', { cwd: project })
  expect(await peer.call('action.run', { id: 'vault.ping', params: {} })).toBe('pong')
  await close()
})
