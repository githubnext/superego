import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, PROTOCOL_VERSION, type ProfileInfo, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
let home: string
let project: string

const open = async () => {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: home, defaultCwd: dir })
  const server = await listen(daemon, join(home, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(home, 'superego.sock'))
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

/** The extensions and instructions a thread's agent has, once a turn configured it. */
async function agentOf(peer: RpcPeer, id: string) {
  const { value } = await peer.call<{ value: { docs: Record<string, unknown> } }>('thread.watch', { id })
  const agent = value.docs['pi.agent'] as { extensions?: string[]; instructions?: string } | undefined
  return { extensions: agent?.extensions ?? [], instructions: agent?.instructions }
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 30)) }
  throw new Error('timed out')
}
const done = (peer: RpcPeer, id: string) => until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((s) => s.id === id)?.status.state === 'done')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-profiles-'))
  home = join(dir, 'home')
  project = join(dir, 'acme')
  mkdirSync(join(project, 'src'), { recursive: true })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('runs plain superego where there are no profiles', async () => {
  const { peer, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project })
  expect(thread.profile).toBeUndefined()
  expect(await peer.call<ProfileInfo[]>('profile.list', { cwd: project })).toEqual([])
  await close()
})

it("takes the user's default profile: its prompt and model", async () => {
  write(join(home, 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ description: 'Mine', prompt: 'Answer in haiku.' })\n`,
  })
  const { peer, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hello' })
  expect(thread.profile).toMatchObject({ name: 'default', scope: 'user' })
  await done(peer, thread.id)
  const agent = await agentOf(peer, thread.id)
  expect(agent.instructions).toBe('Answer in haiku.')
  await close()
})

it("runs a project's profile and its extensions only once allowed, and again after it changes", async () => {
  const profile = join(project, '.superego', 'profiles', 'support')
  write(profile, {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'You answer customer email.', extensions: ['./orders.ts'], without: ['ask-user'] })\n`,
    'orders.ts': `import { defineExtension, defineTool, obj, str } from 'superego'
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
  await expect(peer.call('thread.create', { cwd: project, profile: 'support' })).rejects.toMatchObject({ kind: 'untrusted_profile' })

  await peer.call('profile.allow', { cwd: project, name: 'support' })
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: join(project, 'src'), profile: 'support', prompt: 'where is 42?' })
  expect(thread.profile).toMatchObject({ name: 'support', scope: 'project' })
  await done(peer, thread.id)
  const agent = await agentOf(peer, thread.id)
  expect(agent.extensions).toContain('project:support/orders')
  expect(agent.extensions).toContain('coding-tools')
  expect(agent.extensions).not.toContain('ask-user')
  expect(agent.instructions).toBe('You answer customer email.')

  // An edit is new code: the next turn waits for it to be allowed.
  write(profile, { 'orders.ts': `export default { name: 'orders' }\n` })
  await expect(peer.call('thread.submit', { id: thread.id, text: 'again' })).rejects.toMatchObject({ kind: 'untrusted_profile' })
  await close()
})

it("lets a project's profile replace the user's, or extend it", async () => {
  write(join(home, 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'Be kind.' })\n`,
  })
  write(join(project, '.superego', 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extends: 'user:default', prompt: 'Know the Acme codebase.' })\n`,
  })
  const { peer, close } = await open()
  expect((await peer.call<ProfileInfo[]>('profile.list', { cwd: project })).map((p) => `${p.scope}:${p.name}`)).toEqual(['project:default'])
  await peer.call('profile.allow', { cwd: project })
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hi' })
  expect(thread.profile).toMatchObject({ name: 'default', scope: 'project' })
  await done(peer, thread.id)
  expect((await agentOf(peer, thread.id)).instructions).toBe('Be kind.\n\nKnow the Acme codebase.')
  await close()
})

it("keeps the test shim for 'superego' in step with the SDK", async () => {
  const { SDK_EXPORTS } = await import('../src/profiles.ts')
  const shim = await import('../src/sdk-shim.ts')
  expect(Object.keys(shim).filter((key) => key !== 'default').sort()).toEqual([...SDK_EXPORTS].sort())
})

it("serves a profile's UI modules, types stripped, only from inside it and only once allowed", async () => {
  const profile = join(project, '.superego', 'profiles', 'default')
  write(profile, {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ ui: ['./ui/badge.ts'] })\n`,
    'ui/badge.ts': `import { defineUiExtension, h } from 'superego/ui'\nimport { label } from './label.ts'\nconst n: number = 1\nexport default defineUiExtension({ name: 'badge', setup(superego) { superego.slot('thread.header', () => h('span', null, label)) } })\n`,
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
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ ui: ['./ui/badge.tsx'] })\n`,
    'ui/badge.tsx': `import { defineUiExtension } from 'superego/ui'\nconst label: string = 'Acme'\nexport default defineUiExtension({ name: 'badge', setup(superego) { superego.slot('thread.header', () => <span className="badge">{label}</span>) } })\n`,
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
  const extension = (answer: string) => `import { defineDaemonExtension, defineAction, defineExtension, defineTool, obj, str } from 'superego'
export default defineDaemonExtension({
  name: 'vault',
  setup(superego) {
    const count = superego.value('vault.count', 0)
    superego.action(defineAction({ id: 'vault.answer', title: 'Answer', params: obj({ id: str() }), async run({ id }) {
      const thread = (await superego.threads.list()).find((s) => s.id === id)
      count.update((n) => n + 1)
      return { answer: '${answer}', cwd: thread.cwd }
    } }))
    superego.agent(defineExtension({ name: 'notes', tools: [defineTool({ name: 'note', description: 'A note.', parameters: obj({}), async execute() { return { output: [{ type: 'text', text: 'hi' }] } } })] }))
  },
})
`
  write(profile, { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': extension('one') })
  const { peer, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hi' })
  await done(peer, thread.id)
  expect(await peer.call('action.run', { id: 'vault.answer', params: { id: thread.id } })).toEqual({ answer: 'one', cwd: project })
  expect((await peer.call<{ value: number }>('value.watch', { key: 'vault.count' })).value).toBe(1)
  expect((await agentOf(peer, thread.id)).extensions).toContain('user:default/notes')
  // Changed: the old action goes, the new one answers.
  write(profile, { 'vault.ts': extension('two') })
  await peer.call('thread.submit', { id: thread.id, text: 'again' })
  expect(await peer.call('action.run', { id: 'vault.answer', params: { id: thread.id } })).toMatchObject({ answer: 'two' })
  await close()
})

it("undoes a profile's actions when a later part of it fails, so it loads once fixed", async () => {
  const profile = join(home, 'profiles', 'default')
  // Its action registers, then its agent extension fails to install (a section key pi refuses).
  const extension = (key: string) => `import { defineDaemonExtension, defineAction, defineExtension, obj, section } from 'superego'
export default defineDaemonExtension({
  name: 'vault',
  setup(superego) {
    superego.action(defineAction({ id: 'vault.ping', title: 'Ping', params: obj({}), async run() { return 'pong' } }))
    superego.agent(defineExtension({ name: 'notes', sections: [section('${key}', () => 'notes')] }))
  },
})
`
  write(profile, { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': extension('Not A Key') })
  const { peer, close } = await open()
  await expect(peer.call('thread.create', { cwd: project })).rejects.toThrow(/Section key/)
  write(profile, { 'vault.ts': extension('notes') })
  await peer.call<ThreadInfo>('thread.create', { cwd: project })
  expect(await peer.call('action.run', { id: 'vault.ping', params: {} })).toBe('pong')
  await close()
})

/** A tool that waits for the file `gate`, once it wrote `started`: a run that stays in it until let go. */
const slowTool = (started: string, gate: string) => `defineTool({
    name: 'slow_tool', description: 'Waits.', parameters: obj({}), replay: 'safe',
    async execute(_args, _api, context) {
      writeFileSync(${JSON.stringify(started)}, '')
      while (!existsSync(${JSON.stringify(gate)})) {
        if (context.abortSignal?.aborted) throw new Error('stopped')
        await new Promise((r) => setTimeout(r, 20))
      }
      return { output: [{ type: 'text', text: 'slow done' }] }
    },
  })`

/** A daemon whose model calls slow_tool, then answers. */
async function openSlow() {
  const recording = join(dir, 'slow.jsonl')
  const turn = (message: unknown) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message }) + '\n'
  writeFileSync(recording, turn({ role: 'assistant', content: [{ type: 'toolCall', id: 'slow-1', name: 'slow_tool', arguments: {} }], stopReason: 'toolUse' })
    + turn({ role: 'assistant', content: [{ type: 'text', text: 'All done.' }], stopReason: 'stop' }))
  process.env.SUPEREGO_MODEL = 'replay:' + recording
  process.env.SUPEREGO_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: home, defaultCwd: dir })
  const server = await listen(daemon, join(home, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(home, 'superego.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close(); delete process.env.SUPEREGO_REPLAY_SPEED } }
}

/** The tool results in a thread's transcript. */
async function toolResults(peer: RpcPeer, id: string) {
  const { value } = await peer.call<{ value: { entries: { model?: { role?: string; content?: { text?: string }[]; isError?: boolean }[] }[] } }>('thread.watch', { id })
  return value.entries.map((e) => e.model?.[0]).filter((m) => m?.role === 'toolResult')
}

it("resumes a run interrupted in a profile's tool with that tool, after a restart", async () => {
  const profile = join(home, 'profiles', 'default')
  const gate = join(dir, 'gate')
  const started = join(dir, 'started')
  write(profile, {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./slow.ts'] })\n`,
    'slow.ts': `import { defineExtension, defineTool, obj } from 'superego'
import { existsSync, writeFileSync } from 'node:fs'
export default defineExtension({ name: 'slow', tools: [${slowTool(started, gate)}] })
`,
  })
  const first = await openSlow()
  const thread = await first.peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'go' })
  await until(async () => existsSync(started))
  await first.close()
  writeFileSync(gate, '')
  const second = await openSlow()
  await done(second.peer, thread.id)
  expect((await toolResults(second.peer, thread.id))[0]).toMatchObject({ isError: false, content: [{ text: 'slow done' }] })
  await second.close()
})

it('ends a run interrupted in a profile that no longer loads, rather than not starting', async () => {
  const profile = join(home, 'profiles', 'default')
  const gate = join(dir, 'gate')
  const started = join(dir, 'started')
  write(profile, {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./slow.ts'] })\n`,
    'slow.ts': `import { defineExtension, defineTool, obj } from 'superego'
import { existsSync, writeFileSync } from 'node:fs'
export default defineExtension({ name: 'slow', tools: [${slowTool(started, gate)}] })
`,
  })
  const first = await openSlow()
  const thread = await first.peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'go' })
  await until(async () => existsSync(started))
  await first.close()
  write(profile, { 'slow.ts': `throw new Error('broken')\n` })
  const second = await openSlow()
  await until(async () => (await second.peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state !== 'working')
  expect((await toolResults(second.peer, thread.id)).some((r) => r?.content?.[0]?.text === 'slow done')).toBe(false)
  await second.close()
})

it("doesn't load a profile again under a run: a change waits for the run to end", async () => {
  const profile = join(home, 'profiles', 'default')
  const gate = join(dir, 'gate')
  const started = join(dir, 'started')
  const slow = (version: string) => `import { defineDaemonExtension, defineAction, defineExtension, defineTool, obj } from 'superego'
import { existsSync, writeFileSync } from 'node:fs'
export default defineDaemonExtension({
  name: 'slow',
  setup(superego) {
    superego.action(defineAction({ id: 'slow.version', title: 'Version', params: obj({}), async run() { return '${version}' } }))
    superego.agent(defineExtension({ name: 'slow', tools: [${slowTool(started, gate)}] }))
  },
})
`
  write(profile, { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./slow.ts'] })\n`, 'slow.ts': slow('one') })
  const { peer, close } = await openSlow()
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'go' })
  await until(async () => existsSync(started))
  write(profile, { 'slow.ts': slow('two') })
  const ref = { scope: 'user', name: 'default', dir: profile }
  await peer.call('profile.ui', ref)
  expect(await peer.call('action.run', { id: 'slow.version', params: {} })).toBe('one')
  writeFileSync(gate, '')
  await done(peer, thread.id)
  expect((await toolResults(peer, thread.id))[0]).toMatchObject({ isError: false, content: [{ text: 'slow done' }] })
  await peer.call('profile.ui', ref)
  expect(await peer.call('action.run', { id: 'slow.version', params: {} })).toBe('two')
  await close()
})

it("owns everything a profile's daemon extension registers: settings, values and its name, undone on reload", async () => {
  const profile = join(home, 'profiles', 'default')
  const extension = (title: string) => `import { defineDaemonExtension } from 'superego'
export default defineDaemonExtension({
  name: 'vault',
  setup(superego) {
    superego.settings.register({ id: 'vault', title: '${title}', settings: [{ key: 'vault.path', title: 'Path', default: '~/notes', type: { type: 'string' } }] })
    superego.value('vault.status', '${title}')
  },
})
`
  write(profile, { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': extension('Vault') })
  const { peer, close } = await open()
  // Watched before anything publishes it: it waits, then takes the value.
  const watched = await peer.call<{ sub: string; value: unknown }>('value.watch', { key: 'vault.status' })
  expect(watched.value).toBeNull()
  const changes: unknown[] = []
  peer.on('value.changed', (params: { sub: string; value: unknown }) => { if (params.sub === watched.sub) changes.push(params.value) })
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hi' })
  await done(peer, thread.id)
  await until(async () => changes.includes('Vault'))
  const sections = async () => (await peer.call<{ value: { sections: { id: string; title: string }[] } }>('settings.watch', {})).value.sections
  expect((await sections()).find((s) => s.id === 'vault')?.title).toBe('Vault')
  // Changed: its section is replaced, not registered twice.
  write(profile, { 'vault.ts': extension('Notes') })
  await peer.call('thread.submit', { id: thread.id, text: 'again' })
  await done(peer, thread.id)
  expect((await sections()).filter((s) => s.id === 'vault').map((s) => s.title)).toEqual(['Notes'])
  await until(async () => changes.includes('Notes'))
  // Its name is announced to clients that say hello now.
  const hello = await peer.call<{ features: string[] }>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.features).toContain('ext:vault')
  await close()
})

it("refuses a profile's extension that takes a name already in use, or settings outside its name", async () => {
  const profile = join(home, 'profiles', 'default')
  write(profile, {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./a.ts', './b.ts'] })\n`,
    'a.ts': `import { defineDaemonExtension } from 'superego'\nexport default defineDaemonExtension({ name: 'twin', setup() {} })\n`,
    'b.ts': `import { defineDaemonExtension } from 'superego'\nexport default defineDaemonExtension({ name: 'twin', setup() {} })\n`,
  })
  const { peer, close } = await open()
  await expect(peer.call('thread.create', { cwd: project })).rejects.toThrow(/already set up/)
  write(profile, {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./a.ts'] })\n`,
    'a.ts': `import { defineDaemonExtension } from 'superego'\nexport default defineDaemonExtension({ name: 'twin', setup(superego) { superego.settings.register({ id: 'agent', title: 'Mine', settings: [] }) } })\n`,
  })
  await expect(peer.call('thread.create', { cwd: project })).rejects.toThrow(/must name its settings/)
  await close()
})

it("tells clients what a profile's threads go without, and its agent goes without their parts", async () => {
  write(join(home, 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ without: ['thread-tools', 'agents-md'] })\n`,
  })
  const { peer, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hi' })
  await done(peer, thread.id)
  expect((await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)?.without).toEqual(['agents-md', 'thread-tools'])
  const agent = await agentOf(peer, thread.id)
  expect(agent.extensions).not.toContain('thread-tools')
  expect(agent.extensions).not.toContain('agents-md')
  expect(agent.extensions).toContain('coding-tools')
  await close()
})

/** A daemon extension `vault` whose action answers `answer`, and an agent part `notes` of its own. */
const vault = (answer: string) => `import { defineDaemonExtension, defineAction, defineExtension, obj, section } from 'superego'
export default defineDaemonExtension({
  name: 'vault',
  setup(superego) {
    superego.action(defineAction({ id: 'vault.answer', title: 'Answer', params: obj({}), async run() { return '${answer}' } }))
    superego.agent(defineExtension({ name: 'notes', sections: [section('notes', () => 'notes')] }))
  },
})
`

it("shares a daemon extension between profiles that have it: one extending another, or two naming the same file", async () => {
  write(join(home, 'profiles', 'default'), { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': vault('one') })
  write(join(home, 'profiles', 'work'), { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extends: 'user:default', prompt: 'Work.' })\n` })
  write(join(home, 'profiles', 'play'), { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['../default/vault.ts'] })\n` })
  const { peer, close } = await open()
  const first = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hi' })
  const second = await peer.call<ThreadInfo>('thread.create', { cwd: project, profile: 'work', prompt: 'hi' })
  const third = await peer.call<ThreadInfo>('thread.create', { cwd: project, profile: 'play', prompt: 'hi' })
  for (const thread of [first, second, third]) await done(peer, thread.id)
  expect(await peer.call('action.run', { id: 'vault.answer', params: {} })).toBe('one')
  // Each has its agent parts.
  for (const thread of [first, second]) expect((await agentOf(peer, thread.id)).extensions).toContain('user:default/notes')
  // Named for the profile whose folder holds the file, not the one that loaded it first.
  expect((await agentOf(peer, third.id)).extensions).toContain('user:default/notes')
  // Changed: every profile that has it loads the new version, and they share that.
  write(join(home, 'profiles', 'default'), { 'vault.ts': vault('two') })
  await peer.call('thread.submit', { id: second.id, text: 'again' })
  await done(peer, second.id)
  expect(await peer.call('action.run', { id: 'vault.answer', params: {} })).toBe('two')
  await peer.call('thread.submit', { id: first.id, text: 'again' })
  await peer.call('thread.submit', { id: third.id, text: 'again' })
  for (const thread of [first, third]) await done(peer, thread.id)
  expect(await peer.call('action.run', { id: 'vault.answer', params: {} })).toBe('two')
  expect((await agentOf(peer, second.id)).extensions).toContain('user:default/notes')
  await close()
})

it("names a shared file's agent parts the same whichever profile loads it first", async () => {
  write(dir, { 'shared/vault.ts': vault('one') })
  for (const name of ['a', 'b']) write(join(home, 'profiles', name), { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['../../../shared/vault.ts'] })\n` })
  const notes = async (order: string[]) => {
    const { peer, close } = await open()
    const names: string[] = []
    for (const profile of order) {
      const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, profile, prompt: 'hi' })
      await done(peer, thread.id)
      names.push(...(await agentOf(peer, thread.id)).extensions.filter((name) => name.endsWith('/notes')))
    }
    await close()
    return names
  }
  const first = await notes(['a', 'b'])
  expect(first).toHaveLength(2)
  expect(first[0]).toMatch(/^file:[0-9a-f]+\/notes$/)
  expect(first[1]).toBe(first[0])
  expect(await notes(['b', 'a'])).toEqual(first)
})

it('loads a profile one version at a time, the newest last', async () => {
  const profile = join(home, 'profiles', 'default')
  write(profile, { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': vault('one') })
  const { peer, close } = await open()
  await peer.call<ThreadInfo>('thread.create', { cwd: project })
  const ref = { scope: 'user', name: 'default', dir: profile }
  // Saved twice in a row, each save seen by a call while the last still loads.
  write(profile, { 'vault.ts': vault('two') })
  const a = peer.call('profile.ui', ref)
  write(profile, { 'vault.ts': vault('three') })
  const b = peer.call('profile.ui', ref)
  await Promise.all([a, b])
  expect(await peer.call('action.run', { id: 'vault.answer', params: {} })).toBe('three')
  await close()
})

it("lets go of a profile whose folder is gone: its extensions and its name", async () => {
  const profile = join(home, 'profiles', 'default')
  write(profile, { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': vault('one') })
  const { peer, close } = await open()
  await peer.call<ThreadInfo>('thread.create', { cwd: project })
  expect(await peer.call('action.run', { id: 'vault.answer', params: {} })).toBe('one')
  await rm(profile, { recursive: true })
  await expect(peer.call('profile.ui', { scope: 'user', name: 'default', dir: profile })).rejects.toMatchObject({ kind: 'not_found' })
  await expect(peer.call('action.run', { id: 'vault.answer', params: {} })).rejects.toBeDefined()
  const hello = await peer.call<{ features: string[] }>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.features).not.toContain('ext:vault')
  await close()
})

it("tears down every part of a profile's daemon extension on reload: actions, methods, status, pane kinds, agent parts", async () => {
  const profile = join(home, 'profiles', 'default')
  const full = `import { defineDaemonExtension, defineAction, defineExtension, obj, section, str } from 'superego'
let blocked = ''
export default defineDaemonExtension({
  name: 'vault',
  setup(superego) {
    superego.action(defineAction({ id: 'vault.block', title: 'Block', params: obj({ id: str() }), async run({ id }) { blocked = id; superego.invalidate(); return null } }))
    superego.method('vault.read', async () => 'read')
    superego.status((id) => id === blocked ? { kind: 'question' } : undefined)
    superego.pane('vault-pane', 'the vault; no params')
    superego.agent(defineExtension({ name: 'notes', sections: [section('notes', () => 'notes')] }))
  },
})
`
  write(profile, { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': full })
  const { peer, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hi' })
  await done(peer, thread.id)
  expect(JSON.stringify((await peer.call<{ value: unknown }>('thread.watch', { id: thread.id })).value)).toContain('vault-pane')
  expect((await agentOf(peer, thread.id)).extensions).toContain('user:default/notes')
  expect(await peer.call('vault.read', {})).toBe('read')
  await peer.call('action.run', { id: 'vault.block', params: { id: thread.id } })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'blocked')

  write(profile, { 'vault.ts': `import { defineDaemonExtension } from 'superego'\nexport default defineDaemonExtension({ name: 'vault', setup() {} })\n` })
  await peer.call('profile.ui', { scope: 'user', name: 'default', dir: profile })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state !== 'blocked')
  expect((await peer.call<{ id: string }[]>('action.list', {})).map((a) => a.id)).not.toContain('vault.block')
  await expect(peer.call('vault.read', {})).rejects.toMatchObject({ kind: 'unknown_method' })
  await peer.call('thread.submit', { id: thread.id, text: 'again' })
  await done(peer, thread.id)
  const { value } = await peer.call<{ value: { docs: Record<string, unknown> } }>('thread.watch', { id: thread.id })
  expect(JSON.stringify(value.docs['pi.agent'])).not.toContain('vault-pane')
  expect((await agentOf(peer, thread.id)).extensions).not.toContain('user:default/notes')
  await close()
})

it('sets a value back to null when the extension that published it is torn down, and tells its watchers', async () => {
  const profile = join(home, 'profiles', 'default')
  const extension = (publish: boolean) => `import { defineDaemonExtension } from 'superego'
export default defineDaemonExtension({ name: 'vault', setup(superego) { ${publish ? "superego.value('vault.status', 'open')" : ''} } })
`
  write(profile, { 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./vault.ts'] })\n`, 'vault.ts': extension(true) })
  const { peer, close } = await open()
  await peer.call<ThreadInfo>('thread.create', { cwd: project })
  const watched = await peer.call<{ sub: string; value: unknown }>('value.watch', { key: 'vault.status' })
  expect(watched.value).toBe('open')
  const changes: unknown[] = []
  peer.on('value.changed', (params: { sub: string; value: unknown }) => { if (params.sub === watched.sub) changes.push(params.value) })
  write(profile, { 'vault.ts': extension(false) })
  await peer.call('profile.ui', { scope: 'user', name: 'default', dir: profile })
  await until(async () => changes.includes(null))
  expect((await peer.call<{ value: unknown }>('value.watch', { key: 'vault.status' })).value).toBeNull()
  await close()
})

it("maps a profile's `without` of an extension's old name to its new one", async () => {
  write(join(home, 'profiles', 'default'), {
    'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ without: ['threads'] })\n`,
  })
  const { peer, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: project, prompt: 'hi' })
  await done(peer, thread.id)
  expect((await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.without).toEqual(['thread-tools'])
  expect((await agentOf(peer, thread.id)).extensions).not.toContain('thread-tools')
  await close()
})
