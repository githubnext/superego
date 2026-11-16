import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import { defineApp, PROTOCOL_VERSION, versionOf, type ActionInfo, type ActionLogEntry, type AuthEvent, type Hello, type ModelCatalog, type Notifications, type ProviderAuthInfo, type RpcPeer, type ThreadInfo, type SettingsSnapshot } from '@superego/protocol'
import { connectSocket, listen, openDaemon, type Daemon } from '../src/index.ts'

// Only the scripted model, whatever keys the machine running the tests has.
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
const open = async ({ faux = true } = {}) => {
  if (faux) process.env.SUPEREGO_MODEL = 'faux'
  else delete process.env.SUPEREGO_MODEL
  // AGENTS.md from the test's own folder, never the machine's.
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { daemon, peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const threads = (peer: RpcPeer) => peer.call<ThreadInfo[]>('thread.list', {})

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-test-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('daemon', () => {
  it('rejects a client speaking another protocol version', async () => {
    const { peer, close } = await open()
    await expect(peer.call('hello', { client: 'test', version: 999 })).rejects.toMatchObject({
      kind: 'version_mismatch', message: expect.stringContaining('generation 2, and this client speaks generation 999'), hint: expect.stringMatching(/^Update superego on /),
    })
    await close()
  })

  it('keeps one identity across restarts', async () => {
    const first = await open()
    const hello = await first.peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
    expect(hello.machine.id).toMatch(/^[0-9a-f-]{36}$/)
    await first.close()
    const second = await open()
    expect((await second.peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })).machine.id).toBe(hello.machine.id)
    await second.close()
  })

  it('says which Superego it runs: build, protocol, and the commit it was checked out at', async () => {
    const { peer, close } = await open()
    const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
    const [commit, seconds] = execFileSync('git', ['log', '-1', '--format=%H %ct'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim().split(' ')
    expect(hello.version).toBe(PROTOCOL_VERSION)
    expect(hello.machine).toMatchObject({ build: 'dev', commit, committedAt: Number(seconds) * 1000 })
    expect(versionOf(hello)).toEqual({ build: 'dev', protocol: PROTOCOL_VERSION, commit, committedAt: Number(seconds) * 1000 })
    await close()
  })

  it('runs a thread, streams its view as ops, and derives status', async () => {
    const { peer, close } = await open()
    const created = await peer.call<ThreadInfo>('thread.start', { title: 'first' })
    expect(created.status.state).toBe('idle')

    const watched = await peer.call<{ sub: string; value: ConversationView }>('thread.watch', { thread: created.id })
    let view = watched.value
    peer.on('watch.ops', ({ sub, ops }: Notifications['watch.ops']) => { if (sub === watched.sub) view = applyImmutable(view, ops as Op[]) })

    const changes: ThreadInfo[][] = []
    const list = await peer.call<{ sub: string; value: ThreadInfo[] }>('threads.watch', {})
    peer.on('threads.changed', ({ value }: Notifications['threads.changed']) => changes.push(value))
    expect(list.value.map((s) => s.id)).toEqual([created.id])

    await peer.call('thread.send', { thread: created.id, text: 'hello superego' })
    await until(() => view.entries.some((entry) => entry.kind === 'pi.assistant'))
    const answer = view.entries.find((entry) => entry.kind === 'pi.assistant')!
    expect(JSON.stringify(answer)).toContain('echo: hello superego')

    await until(async () => (await threads(peer))[0]!.status.state === 'done')
    expect(changes.flat().some((s) => s.status.state === 'working')).toBe(true)

    await peer.call('thread.seen', { thread: created.id })
    const [seen] = await threads(peer)
    expect(seen!.status.state).toBe('idle')
    // Facts for clients: the model it runs with, and when it last did something.
    expect(seen).toMatchObject({ model: 'faux-1' })
    expect(seen!.activeAt).toBeGreaterThanOrEqual(seen!.createdAt)
    await close()
  })

  it('keeps threads across a daemon restart', async () => {
    const first = await open()
    const created = await first.peer.call<ThreadInfo>('thread.start', {})
    await first.peer.call('thread.send', { thread: created.id, text: 'remember me' })
    await until(async () => (await threads(first.peer))[0]!.status.state === 'done')
    await first.close()

    const second = await open()
    const [again] = await threads(second.peer)
    expect(again).toMatchObject({ id: created.id, title: 'remember me', status: { state: 'done' } })
    const { value } = await second.peer.call<{ value: ConversationView }>('thread.watch', { thread: created.id })
    expect(JSON.stringify(value.entries)).toContain('echo: remember me')
    await second.close()
  })

  it('refuses to run without a model, pointing at settings', async () => {
    const { peer, close } = await open({ faux: false })
    const created = await peer.call<ThreadInfo>('thread.start', {})
    await expect(peer.call('thread.send', { thread: created.id, text: 'hi' })).rejects.toMatchObject({ kind: 'no_model', hint: expect.stringContaining('Settings') })
    await close()
  })

  it('serves settings: sections, validated values, persisted across restarts', async () => {
    const first = await open()
    const { value } = await first.peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
    expect(value.sections.map((s) => s.id)).toEqual(['model', 'providers', 'extensions', 'profiles', 'web', 'outside', 'clients', 'onboarding'])
    const model = value.sections[0]!.settings.find((s) => s.key === 'agent.model')!
    expect(model.type === 'choice' && model.options.map((o) => o.value)).toContain('faux/faux-1')
    await expect(first.peer.call('settings.set', { key: 'agent.model', value: 'nope/nope' })).rejects.toMatchObject({ kind: 'invalid_setting' })
    await first.peer.call('settings.set', { key: 'agent.model', value: 'faux/faux-1' })
    await first.close()

    const second = await open()
    const again = await second.peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
    expect(again.value.values['agent.model']).toBe('faux/faux-1')
    await second.close()
  })

  it('signs in with an API key and out again, updating watchers', async () => {
    const { peer, close } = await open({ faux: false })
    const providers = (snapshot: SettingsSnapshot) => snapshot.sections.find((s) => s.id === 'providers')!.data as ProviderAuthInfo[]
    const watched = await peer.call<{ sub: string; value: SettingsSnapshot }>('settings.watch', {})
    let snapshot = watched.value
    peer.on('settings.changed', ({ value }: Notifications['settings.changed']) => { snapshot = value })
    expect(providers(snapshot).find((p) => p.id === 'anthropic')?.auth).toBeUndefined()

    const events: AuthEvent[] = []
    peer.on('auth.event', ({ event }: Notifications['auth.event']) => events.push(event))
    await peer.call('auth.signIn', { provider: 'anthropic', type: 'api_key', key: 'sk-ant-test' })
    await until(() => events.some((e) => e.type === 'done' || e.type === 'failed'))
    expect(events.at(-1)).toEqual({ type: 'done' })
    await until(() => providers(snapshot).find((p) => p.id === 'anthropic')?.stored === true)
    // Signed in, the model resolves automatically to the provider's preferred one.
    const model = snapshot.sections[0]!.settings.find((s) => s.key === 'agent.model')!
    expect(model.type === 'choice' && model.nullLabel).toContain('claude')

    await peer.call('auth.signOut', { provider: 'anthropic' })
    await until(() => providers(snapshot).find((p) => p.id === 'anthropic')?.stored === false)
    await close()
  })
})

describe('new threads', () => {
  it('start in a folder with a first prompt and their own model, which later turns keep', async () => {
    const { peer, close } = await open()
    const catalog = await peer.call<ModelCatalog>('agent.models', {})
    expect(catalog.models.map((m) => m.value)).toContain('faux/faux-1')
    expect(catalog.default.model).toBe('faux/faux-1')

    await expect(peer.call('thread.start', { cwd: join(dir, 'nope') })).rejects.toMatchObject({ kind: 'invalid', message: expect.stringContaining('No folder') })
    await expect(peer.call('thread.start', { model: 'nope/nope' })).rejects.toMatchObject({ kind: 'invalid' })

    const created = await peer.call<ThreadInfo>('thread.start', { cwd: dir, model: 'faux/faux-1', prompt: 'first words' })
    expect(created).toMatchObject({ cwd: dir, title: 'first words', ownModel: true, chosen: { model: 'faux/faux-1' } })
    await until(async () => (await threads(peer))[0]!.status.state === 'done')
    // Changing this machine's default leaves the thread on its own model.
    await peer.call('settings.set', { key: 'agent.model', value: 'faux/faux-1' })
    await peer.call('thread.send', { thread: created.id, text: 'again' })
    await until(async () => (await threads(peer))[0]!.status.state === 'done')
    expect((await threads(peer))[0]).toMatchObject({ model: 'faux-1', ownModel: true })
    await close()
  })
})

describe('restart', () => {
  it('refuses while a thread works unless interrupting, then stops taking work', async () => {
    // A long answer replayed slowly keeps the thread working for as long as the test needs.
    const recording = join(dir, 'slow.jsonl')
    await writeFile(recording, JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content: [{ type: 'text', text: 'word '.repeat(2000) }], stopReason: 'stop' } }) + '\n')
    process.env.SUPEREGO_MODEL = 'replay:' + recording
    process.env.SUPEREGO_REPLAY_SPEED = '20'
    let restarts = 0
    let successorEnv: Record<string, string> | undefined
    const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, build: 'b1', onRestart: (env) => { restarts++; successorEnv = env } })
    delete process.env.SUPEREGO_REPLAY_SPEED
    const server = await listen(daemon, join(dir, 'superego.sock'))
    const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    await peer.call('settings.set', { key: 'agent.model', value: 'replay/replay' })

    await expect(peer.call('daemon.restart', { build: 'other' })).rejects.toMatchObject({ kind: 'changed' })
    const created = await peer.call<ThreadInfo>('thread.start', {})
    await peer.call('thread.send', { thread: created.id, text: 'go' })
    await until(async () => (await threads(peer))[0]!.status.state === 'working')
    expect(await peer.call('daemon.restart', { build: 'b1' })).toEqual({ restarted: false, busy: true })
    expect(restarts).toBe(0)

    expect(await peer.call('daemon.restart', { build: 'b1', interrupt: true, env: { ANTHROPIC_API_KEY: 'k', BAD: 1 } })).toEqual({ restarted: true, busy: true })
    await until(() => restarts === 1)
    expect(successorEnv).toEqual({ ANTHROPIC_API_KEY: 'k' })
    await expect(peer.call('thread.list', {})).rejects.toMatchObject({ kind: 'restarting' })
    socket.destroy(); server.close(); await daemon.close()
  })
})

describe('record and replay', () => {
  it('records answers and plays them back in order', async () => {
    const recording = join(dir, 'turns.jsonl')
    process.env.SUPEREGO_RECORD = recording
    const first = await open()
    const one = await first.peer.call<ThreadInfo>('thread.start', {})
    await first.peer.call('thread.send', { thread: one.id, text: 'first' })
    await until(async () => (await threads(first.peer))[0]!.status.state === 'done')
    await first.peer.call('thread.send', { thread: one.id, text: 'second' })
    await until(async () => (await threads(first.peer))[0]!.status.state === 'done')
    await first.close()
    delete process.env.SUPEREGO_RECORD

    const replayDir = join(dir, 'replay')
    process.env.SUPEREGO_MODEL = 'replay:' + recording
    process.env.SUPEREGO_REPLAY_SPEED = '0'
    const daemon = await openDaemon({ app: SUPEREGO, dataDir: replayDir, defaultCwd: dir })
    const server = await listen(daemon, join(replayDir, 'superego.sock'))
    const { peer, socket } = await connectSocket(join(replayDir, 'superego.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    const created = await peer.call<ThreadInfo>('thread.start', {})
    const answers: string[] = []
    for (const text of ['anything', 'else', 'more']) {
      await peer.call('thread.send', { thread: created.id, text })
      await until(async () => (await threads(peer))[0]!.status.state === 'done')
      const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: created.id })
      answers.push(JSON.stringify(value.entries.filter((e) => e.kind === 'pi.assistant').at(-1)))
      await peer.call('thread.seen', { thread: created.id })
    }
    expect(answers[0]).toContain('echo: first')
    expect(answers[1]).toContain('echo: second')
    expect(answers[2]).toContain('Replay finished')
    socket.destroy(); server.close(); await daemon.close()
    delete process.env.SUPEREGO_REPLAY_SPEED
  })

  it('lists its actions, runs them from the command line with coerced params, and logs each dispatch', async () => {
    const { peer, close } = await open()
    const actions = await peer.call<ActionInfo[]>('action.list', {})
    expect(actions.map((a) => a.id)).toEqual(expect.arrayContaining(['thread.start', 'thread.send', 'settings.set', 'daemon.restart']))
    expect(actions.find((a) => a.id === 'thread.rename')).toMatchObject({ thread: true, expose: expect.arrayContaining(['cli']) })
    const created = await peer.call<ThreadInfo>('action.run', { id: 'thread.start', params: { title: 'from cli' }, exposure: 'cli' })
    await peer.call('action.run', { id: 'thread.rename', params: { thread: created.id, title: 'renamed' }, exposure: 'cli' })
    expect((await threads(peer)).find((s) => s.id === created.id)?.title).toBe('renamed')
    await expect(peer.call('action.run', { id: 'thread.rename', params: { thread: created.id }, exposure: 'cli' })).rejects.toMatchObject({ kind: 'invalid_params' })
    await expect(peer.call('action.run', { id: 'nope.nope', exposure: 'cli' })).rejects.toMatchObject({ kind: 'unknown_action' })
    // Served under its own id, too: the app calls actions directly.
    await peer.call('thread.seen', { thread: created.id })
    const log = await peer.call<ActionLogEntry[]>('action.log', {})
    expect(log.map((e) => [e.id, e.source, e.ok])).toEqual(expect.arrayContaining([
      ['thread.start', 'cli', true], ['thread.rename', 'cli', true], ['thread.rename', 'cli', false], ['thread.seen', 'test', true],
    ]))
    await close()
  })

  it('archives a thread out of the list, readable but taking nothing, and back', async () => {
    const { peer, close } = await open()
    const kept = await peer.call<ThreadInfo>('thread.start', { title: 'kept' })
    const old = await peer.call<ThreadInfo>('thread.start', { title: 'old' })
    await peer.call('thread.archive', { thread: old.id })
    expect((await threads(peer)).map((s) => s.id)).toEqual([kept.id])
    const archived = await peer.call<ThreadInfo[]>('thread.list', { archived: true })
    expect(archived.map((s) => s.id)).toEqual([old.id])
    expect(archived[0]!.archived).toBe(true)
    // Put away, it can still be read, but not sent to.
    await expect(peer.call('thread.watch', { thread: old.id })).resolves.toMatchObject({ sub: expect.any(String) })
    await expect(peer.call('thread.send', { thread: old.id, text: 'hi' })).rejects.toMatchObject({ kind: 'archived' })
    await peer.call('thread.unarchive', { thread: old.id })
    expect((await threads(peer)).find((s) => s.id === old.id)?.archived).toBeUndefined()
    expect((await threads(peer)).map((s) => s.id).sort()).toEqual([kept.id, old.id].sort())
    await close()
  })

  it('keeps panes with a thread: open (beside, the same one once), focus, close', async () => {
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.start', { title: 'panes' })
    const diff = await peer.call<{ id: string }>('pane.open', { thread: thread.id, kind: 'diff' })
    const preview = await peer.call<{ id: string }>('pane.open', { thread: thread.id, kind: 'preview', params: { url: 'http://localhost:3000' } })
    expect((await peer.call<{ id: string }>('pane.open', { thread: thread.id, kind: 'diff' })).id).toBe(diff.id)
    let info = (await threads(peer)).find((s) => s.id === thread.id)!
    expect(info.panes?.map((p) => p.kind)).toEqual(['diff', 'preview'])
    expect(info.pane).toBeUndefined()
    await peer.call('pane.focus', { thread: thread.id, pane: diff.id })
    expect((await threads(peer)).find((s) => s.id === thread.id)!.pane).toBe(diff.id)
    await peer.call('pane.focus', { thread: thread.id })
    expect((await threads(peer)).find((s) => s.id === thread.id)!.pane).toBeUndefined()
    await peer.call('pane.focus', { thread: thread.id, pane: diff.id })
    await peer.call('pane.focus', { thread: thread.id, pane: preview.id })
    await peer.call('pane.close', { thread: thread.id, pane: preview.id })
    info = (await threads(peer)).find((s) => s.id === thread.id)!
    expect(info.panes?.map((p) => p.kind)).toEqual(['diff'])
    expect(info.pane).toBe(diff.id)
    // Params sent as a string of JSON, as models sometimes do, are kept as what they say.
    const note = await peer.call<{ params: unknown }>('pane.open', { thread: thread.id, kind: 'editor', params: '{"path": "a.md"}' })
    expect(note.params).toEqual({ path: 'a.md' })
    await close()
  })

  it("reads and writes files in a thread's folder only", async () => {
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
    await writeFile(join(dir, 'notes.md'), 'one\n')
    expect((await peer.call<{ content: string }>('file.read', { thread: thread.id, path: 'notes.md' })).content).toBe('one\n')
    await expect(peer.call('file.read', { thread: thread.id, path: '../../etc/passwd' })).rejects.toMatchObject({ kind: 'invalid' })
    await peer.call('file.write', { thread: thread.id, path: 'notes.md', content: 'two\n' })
    expect((await peer.call<{ content: string }>('file.read', { thread: thread.id, path: 'notes.md' })).content).toBe('two\n')
    await close()
  })

  it("says which version of a thread's files there is, by the same rules as reading them", async () => {
    const { utimes } = await import('node:fs/promises')
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
    await writeFile(join(dir, 'shot.png'), 'one')
    await utimes(join(dir, 'shot.png'), 1000, 1000)
    const read = await peer.call<{ mtimeMs: number; size: number }>('file.read', { thread: thread.id, path: 'shot.png', base64: true })
    expect(read).toMatchObject({ mtimeMs: 1_000_000, size: 3 })
    const stat = (...paths: string[]) => peer.call<{ files: unknown[] }>('file.stat', { thread: thread.id, paths })
    expect(await stat('shot.png')).toEqual({ files: [{ mtimeMs: 1_000_000, size: 3 }] })
    await writeFile(join(dir, 'shot.png'), 'three')
    await utimes(join(dir, 'shot.png'), 2000, 2000)
    // Outside its folder, missing, or a folder: none, without failing the rest.
    expect(await stat('shot.png', '../../etc/passwd', '/etc/hosts', 'gone.png', '.')).toEqual({
      files: [{ mtimeMs: 2_000_000, size: 5 }, null, null, null, null],
    })
    await close()
  })

  it('sends files with a message: saved on the machine, named to the agent, images as images', async () => {
    const { readFile } = await import('node:fs/promises')
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    await peer.call('thread.send', { thread: thread.id, text: 'look', attachments: [
      { name: 'shot.png', mimeType: 'image/png', data: png },
      { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('# Hi\n').toString('base64') },
      { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('again\n').toString('base64') },
    ] })
    await until(async () => (await threads(peer)).find((t) => t.id === thread.id)!.status.state === 'done')
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
    const user = value.entries.find((e) => e.kind === 'pi.user')!.model![0] as { content: { type: string; text?: string; mimeType?: string }[] }
    expect(user.content.map((b) => b.type)).toEqual(['text', 'text', 'image', 'text', 'text'])
    expect(user.content[0]!.text).toBe('look')
    expect(user.content[2]!.mimeType).toBe('image/png')
    const saved = join(dir, 'attachments', thread.id)
    expect(user.content[3]!.text).toBe(`<attachment name="notes.md" type="text/markdown" path="${join(saved, 'notes.md')}">\n# Hi\n\n</attachment>`)
    expect(user.content[4]!.text).toContain(`path="${join(saved, 'notes-2.md')}"`)
    expect(await readFile(join(saved, 'shot.png'), 'base64')).toBe(png)
    // A message can be files alone; nothing at all is refused.
    await peer.call('thread.send', { thread: thread.id, text: '', attachments: [{ name: 'a.txt', mimeType: 'text/plain', data: '' }] })
    await expect(peer.call('thread.send', { thread: thread.id, text: '  ' })).rejects.toMatchObject({ kind: 'invalid' })
    await close()
  })

  it('reads AGENTS.md: the shared one, then those from the root down to the thread\'s folder', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'agents'), { recursive: true })
    await writeFile(join(dir, 'agents', 'AGENTS.md'), 'Always be kind.')
    await writeFile(join(dir, 'AGENTS.md'), 'This project uses pnpm.')
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
    await peer.call('thread.send', { thread: thread.id, text: 'hi' })
    await until(async () => (await threads(peer)).find((t) => t.id === thread.id)!.status.state === 'done')
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
    const all = JSON.stringify(value)
    expect(all).toMatch(/Always be kind\.[^]*This project uses pnpm\./)
    await close()
  })

  it('watches a file: every change on disk, a save by renaming over it too, and its going', async () => {
    const { rename, unlink } = await import('node:fs/promises')
    await writeFile(join(dir, 'note.md'), 'one\n')
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
    const seen: (string | null)[] = []
    peer.on('file.changed', (params: { content: string | null }) => { seen.push(params.content) })
    const { content } = await peer.call<{ sub: string; content: string }>('file.watch', { thread: thread.id, path: 'note.md' })
    expect(content).toBe('one\n')
    await writeFile(join(dir, 'note.md'), 'two\n')
    await until(() => seen.at(-1) === 'two\n')
    await writeFile(join(dir, '.note.md.tmp'), 'three\n')
    await rename(join(dir, '.note.md.tmp'), join(dir, 'note.md'))
    await until(() => seen.at(-1) === 'three\n')
    await unlink(join(dir, 'note.md'))
    await until(() => seen.at(-1) === null)
    await close()
  })

  it('pages back through a thread older than its watch holds', async () => {
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
    for (const text of ['one', 'two', 'three']) {
      await peer.call('thread.send', { thread: thread.id, text })
      await until(async () => (await threads(peer)).find((t) => t.id === thread.id)!.status.state === 'done')
    }
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
    const last = value.entries.at(-1)!.id as number
    const page = await peer.call<{ entries: { id: number; kind: string }[]; more: boolean }>('thread.history', { thread: thread.id, before: last, limit: 2 })
    expect(page.entries).toHaveLength(2)
    expect(page.entries[0]!.id).toBeLessThan(page.entries[1]!.id)
    expect(page.entries[1]!.id).toBeLessThan(last)
    expect(page.more).toBe(true)
    const all = await peer.call<{ entries: { id: number }[]; more: boolean }>('thread.history', { thread: thread.id, before: last, limit: 200 })
    expect(all.more).toBe(false)
    expect(all.entries.length).toBe(value.entries.filter((e) => (e.id as number) < last).length)
    await close()
  })

  it('finds a file by the name a link gives it, as Obsidian resolves [[links]]', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'Work/Old'), { recursive: true })
    await mkdir(join(dir, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(dir, 'Work/Old/Plan.md'), 'old\n')
    await writeFile(join(dir, 'Work/Plan.md'), 'plan\n')
    await writeFile(join(dir, 'node_modules/pkg/Readme.md'), 'no\n')
    await writeFile(join(dir, 'Work/diagram.png'), '')
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
    const find = async (name: string) => (await peer.call<{ path: string | null }>('file.find', { thread: thread.id, name })).path
    expect(await find('Plan')).toBe('Work/Plan.md')
    expect(await find('plan')).toBe('Work/Plan.md')
    expect(await find('Work/Old/Plan')).toBe('Work/Old/Plan.md')
    expect(await find('diagram.png')).toBe('Work/diagram.png')
    expect(await find('Readme')).toBeNull()
    expect(await find('../../etc/passwd')).toBeNull()
    // Paths as agents write them: a folder, a line, the whole path, or one past the folder.
    const where = async (name: string) => peer.call('file.find', { thread: thread.id, name })
    expect(await where('Work/Old/')).toEqual({ path: 'Work/Old', folder: true })
    expect(await where('Work/Plan.md:12')).toEqual({ path: 'Work/Plan.md', line: 12 })
    expect(await where('Work/Plan.md#L3-L9')).toEqual({ path: 'Work/Plan.md', line: 3 })
    expect(await where(join(dir, 'Work/Plan.md'))).toEqual({ path: 'Work/Plan.md' })
    expect(await where(dir)).toEqual({ path: '', folder: true })
    expect(await where('/etc/passwd')).toEqual({ path: null, outside: true })
    await close()
  })
})



