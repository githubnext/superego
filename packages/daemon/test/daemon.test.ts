import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import { defineApp, PROTOCOL_VERSION, type ActionInfo, type ActionLogEntry, type AuthEvent, type Hello, type ModelCatalog, type Notifications, type ProviderAuthInfo, type RpcPeer, type ThreadInfo, type SettingsSnapshot } from '@superego/protocol'
import { connectSocket, listen, openDaemon, type Daemon } from '../src/index.ts'

// Only the scripted model, whatever keys the machine running the tests has.
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
const open = async ({ faux = true } = {}) => {
  if (faux) process.env.SUPEREGO_MODEL = 'faux'
  else delete process.env.SUPEREGO_MODEL
  // Skills and AGENTS.md from the test's own folder, never the machine's.
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
    await expect(peer.call('hello', { client: 'test', version: 999 })).rejects.toMatchObject({ kind: 'version_mismatch' })
    await close()
  })

  it('announces its features and keeps one identity across restarts', async () => {
    const first = await open()
    const hello = await first.peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
    expect(hello.features).toEqual(expect.arrayContaining(['threads', 'settings', 'auth']))
    expect(hello.machine.id).toMatch(/^[0-9a-f-]{36}$/)
    await first.close()
    const second = await open()
    expect((await second.peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })).machine.id).toBe(hello.machine.id)
    await second.close()
  })

  it('runs a thread, streams its view as ops, and derives status', async () => {
    const { peer, close } = await open()
    const created = await peer.call<ThreadInfo>('thread.create', { title: 'first' })
    expect(created.status.state).toBe('idle')

    const watched = await peer.call<{ sub: string; value: ConversationView }>('thread.watch', { id: created.id })
    let view = watched.value
    peer.on('watch.ops', ({ sub, ops }: Notifications['watch.ops']) => { if (sub === watched.sub) view = applyImmutable(view, ops as Op[]) })

    const changes: ThreadInfo[][] = []
    const list = await peer.call<{ sub: string; value: ThreadInfo[] }>('threads.watch', {})
    peer.on('threads.changed', ({ value }: Notifications['threads.changed']) => changes.push(value))
    expect(list.value.map((s) => s.id)).toEqual([created.id])

    await peer.call('thread.submit', { id: created.id, text: 'hello superego' })
    await until(() => view.entries.some((entry) => entry.kind === 'pi.assistant'))
    const answer = view.entries.find((entry) => entry.kind === 'pi.assistant')!
    expect(JSON.stringify(answer)).toContain('echo: hello superego')

    await until(async () => (await threads(peer))[0]!.status.state === 'done')
    expect(changes.flat().some((s) => s.status.state === 'working')).toBe(true)

    await peer.call('thread.seen', { id: created.id })
    const [seen] = await threads(peer)
    expect(seen!.status.state).toBe('idle')
    // Facts for clients: the model it runs with, and when it last did something.
    expect(seen).toMatchObject({ model: 'faux-1' })
    expect(seen!.activeAt).toBeGreaterThanOrEqual(seen!.createdAt)
    await close()
  })

  it('keeps threads across a daemon restart', async () => {
    const first = await open()
    const created = await first.peer.call<ThreadInfo>('thread.create', {})
    await first.peer.call('thread.submit', { id: created.id, text: 'remember me' })
    await until(async () => (await threads(first.peer))[0]!.status.state === 'done')
    await first.close()

    const second = await open()
    const [again] = await threads(second.peer)
    expect(again).toMatchObject({ id: created.id, title: 'remember me', status: { state: 'done' } })
    const { value } = await second.peer.call<{ value: ConversationView }>('thread.watch', { id: created.id })
    expect(JSON.stringify(value.entries)).toContain('echo: remember me')
    await second.close()
  })

  it('refuses to run without a model, pointing at settings', async () => {
    const { peer, close } = await open({ faux: false })
    const created = await peer.call<ThreadInfo>('thread.create', {})
    await expect(peer.call('thread.submit', { id: created.id, text: 'hi' })).rejects.toMatchObject({ kind: 'no_model', hint: expect.stringContaining('Settings') })
    await close()
  })

  it('serves settings: sections, validated values, persisted across restarts', async () => {
    const first = await open()
    const { value } = await first.peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
    expect(value.sections.map((s) => s.id)).toEqual(['model', 'providers', 'extensions', 'profiles', 'web'])
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
    await peer.call('auth.login', { provider: 'anthropic', type: 'api_key', key: 'sk-ant-test' })
    await until(() => events.some((e) => e.type === 'done' || e.type === 'failed'))
    expect(events.at(-1)).toEqual({ type: 'done' })
    await until(() => providers(snapshot).find((p) => p.id === 'anthropic')?.stored === true)
    // Signed in, the model resolves automatically to the provider's preferred one.
    const model = snapshot.sections[0]!.settings.find((s) => s.key === 'agent.model')!
    expect(model.type === 'choice' && model.nullLabel).toContain('claude')

    await peer.call('auth.logout', { provider: 'anthropic' })
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

    await expect(peer.call('thread.create', { cwd: join(dir, 'nope') })).rejects.toMatchObject({ kind: 'invalid', message: expect.stringContaining('No folder') })
    await expect(peer.call('thread.create', { model: 'nope/nope' })).rejects.toMatchObject({ kind: 'invalid' })

    const created = await peer.call<ThreadInfo>('thread.create', { cwd: dir, model: 'faux/faux-1', prompt: 'first words' })
    expect(created).toMatchObject({ cwd: dir, title: 'first words', ownModel: true, chosen: { model: 'faux/faux-1' } })
    await until(async () => (await threads(peer))[0]!.status.state === 'done')
    // Changing this machine's default leaves the thread on its own model.
    await peer.call('settings.set', { key: 'agent.model', value: 'faux/faux-1' })
    await peer.call('thread.submit', { id: created.id, text: 'again' })
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
    const created = await peer.call<ThreadInfo>('thread.create', {})
    await peer.call('thread.submit', { id: created.id, text: 'go' })
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
    const one = await first.peer.call<ThreadInfo>('thread.create', {})
    await first.peer.call('thread.submit', { id: one.id, text: 'first' })
    await until(async () => (await threads(first.peer))[0]!.status.state === 'done')
    await first.peer.call('thread.submit', { id: one.id, text: 'second' })
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
    const created = await peer.call<ThreadInfo>('thread.create', {})
    const answers: string[] = []
    for (const text of ['anything', 'else', 'more']) {
      await peer.call('thread.submit', { id: created.id, text })
      await until(async () => (await threads(peer))[0]!.status.state === 'done')
      const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: created.id })
      answers.push(JSON.stringify(value.entries.filter((e) => e.kind === 'pi.assistant').at(-1)))
      await peer.call('thread.seen', { id: created.id })
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
    expect(actions.map((a) => a.id)).toEqual(expect.arrayContaining(['thread.create', 'thread.submit', 'settings.set', 'daemon.restart']))
    expect(actions.find((a) => a.id === 'thread.rename')).toMatchObject({ thread: true, expose: expect.arrayContaining(['cli']) })
    const created = await peer.call<ThreadInfo>('action.run', { id: 'thread.create', params: { title: 'from cli' }, exposure: 'cli' })
    await peer.call('action.run', { id: 'thread.rename', params: { id: created.id, title: 'renamed' }, exposure: 'cli' })
    expect((await threads(peer)).find((s) => s.id === created.id)?.title).toBe('renamed')
    await expect(peer.call('action.run', { id: 'thread.rename', params: { id: created.id }, exposure: 'cli' })).rejects.toMatchObject({ kind: 'invalid_params' })
    await expect(peer.call('action.run', { id: 'nope.nope', exposure: 'cli' })).rejects.toMatchObject({ kind: 'unknown_action' })
    // Served under its own id, too: the app calls actions directly.
    await peer.call('thread.seen', { id: created.id })
    const log = await peer.call<ActionLogEntry[]>('action.log', {})
    expect(log.map((e) => [e.id, e.source, e.ok])).toEqual(expect.arrayContaining([
      ['thread.create', 'cli', true], ['thread.rename', 'cli', true], ['thread.rename', 'cli', false], ['thread.seen', 'test', true],
    ]))
    await close()
  })

  it('archives a thread out of the list, readable but taking nothing, and back', async () => {
    const { peer, close } = await open()
    const kept = await peer.call<ThreadInfo>('thread.create', { title: 'kept' })
    const old = await peer.call<ThreadInfo>('thread.create', { title: 'old' })
    await peer.call('thread.archive', { id: old.id })
    expect((await threads(peer)).map((s) => s.id)).toEqual([kept.id])
    const archived = await peer.call<ThreadInfo[]>('thread.list', { archived: true })
    expect(archived.map((s) => s.id)).toEqual([old.id])
    expect(archived[0]!.archived).toBe(true)
    // Put away, it can still be read, but not sent to.
    await expect(peer.call('thread.watch', { id: old.id })).resolves.toMatchObject({ sub: expect.any(String) })
    await expect(peer.call('thread.submit', { id: old.id, text: 'hi' })).rejects.toMatchObject({ kind: 'archived' })
    await peer.call('thread.unarchive', { id: old.id })
    expect((await threads(peer)).find((s) => s.id === old.id)?.archived).toBeUndefined()
    expect((await threads(peer)).map((s) => s.id).sort()).toEqual([kept.id, old.id].sort())
    await close()
  })

  it('keeps panes with a thread: open (beside, the same one once), focus, close', async () => {
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.create', { title: 'panes' })
    const diff = await peer.call<{ id: string }>('pane.open', { id: thread.id, kind: 'diff' })
    const preview = await peer.call<{ id: string }>('pane.open', { id: thread.id, kind: 'preview', params: { url: 'http://localhost:3000' } })
    expect((await peer.call<{ id: string }>('pane.open', { id: thread.id, kind: 'diff' })).id).toBe(diff.id)
    let info = (await threads(peer)).find((s) => s.id === thread.id)!
    expect(info.panes?.map((p) => p.kind)).toEqual(['diff', 'preview'])
    expect(info.pane).toBeUndefined()
    await peer.call('pane.focus', { id: thread.id, pane: diff.id })
    expect((await threads(peer)).find((s) => s.id === thread.id)!.pane).toBe(diff.id)
    await peer.call('pane.focus', { id: thread.id })
    expect((await threads(peer)).find((s) => s.id === thread.id)!.pane).toBeUndefined()
    await peer.call('pane.focus', { id: thread.id, pane: diff.id })
    await peer.call('pane.focus', { id: thread.id, pane: preview.id })
    await peer.call('pane.close', { id: thread.id, pane: preview.id })
    info = (await threads(peer)).find((s) => s.id === thread.id)!
    expect(info.panes?.map((p) => p.kind)).toEqual(['diff'])
    expect(info.pane).toBe(diff.id)
    // Params sent as a string of JSON, as models sometimes do, are kept as what they say.
    const note = await peer.call<{ params: unknown }>('pane.open', { id: thread.id, kind: 'editor', params: '{"path": "a.md"}' })
    expect(note.params).toEqual({ path: 'a.md' })
    await close()
  })

  it("reads and writes files in a thread's folder only, and diffs it by git", async () => {
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '-q', dir]); execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'start'])
    await writeFile(join(dir, 'notes.md'), 'one\n')
    execFileSync('git', ['-C', dir, 'add', 'notes.md']); execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'notes'])
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
    expect((await peer.call<{ content: string }>('file.read', { id: thread.id, path: 'notes.md' })).content).toBe('one\n')
    await expect(peer.call('file.read', { id: thread.id, path: '../../etc/passwd' })).rejects.toMatchObject({ kind: 'invalid' })
    await peer.call('file.write', { id: thread.id, path: 'notes.md', content: 'two\n' })
    await writeFile(join(dir, 'new.md'), 'new\n')
    const changes = await peer.call<{ diff: string; untracked: string[]; repo: boolean }>('thread.diff', { id: thread.id })
    expect(changes.repo).toBe(true)
    expect(changes.diff).toContain('-one')
    expect(changes.diff).toContain('+two')
    expect(changes.untracked).toContain('new.md')
    await close()
  })

  it('gives a thread in a repository a worktree of its own when asked, in the same session, removed when archived clean', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdir, realpath } = await import('node:fs/promises')
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
    execFileSync('git', ['init', '-q', dir])
    await mkdir(join(dir, 'app'))
    await writeFile(join(dir, 'app/readme.md'), 'hi\n')
    git('add', '.'); git('commit', '-q', '-m', 'start')
    const root = await realpath(dir)
    const { peer, close } = await open()
    // Started in a folder below the top: the same folder, in its own worktree.
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: join(dir, 'app'), title: 'Fix the login flow', worktree: true })
    expect(thread.worktree?.branch).toMatch(/^superego\/fix-the-login-flow-[0-9a-f]{6}$/)
    expect(thread.cwd).toBe(join(thread.worktree!.path, 'app'))
    expect(thread.session).toEqual({ root, name: basename(root) })
    expect(git('branch', '--list', thread.worktree!.branch)).toContain(thread.worktree!.branch)
    // Otherwise in place: the same session.
    const here = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
    expect(here.worktree).toBeUndefined()
    expect(here.session.root).toBe(root)
    // Archived with nothing uncommitted: the worktree goes, the branch stays; unarchived, it's back.
    expect(await peer.call('thread.archive', { id: thread.id })).toEqual({ worktree: 'removed' })
    expect(existsSync(thread.worktree!.path)).toBe(false)
    expect(git('branch', '--list', thread.worktree!.branch)).toContain(thread.worktree!.branch)
    await peer.call('thread.unarchive', { id: thread.id })
    expect(existsSync(join(thread.worktree!.path, 'app/readme.md'))).toBe(true)
    // With changes in it, archiving leaves it be.
    await writeFile(join(thread.worktree!.path, 'app/wip.md'), 'wip\n')
    expect(await peer.call('thread.archive', { id: thread.id })).toEqual({ worktree: 'kept' })
    expect(existsSync(join(thread.worktree!.path, 'app/wip.md'))).toBe(true)
    await close()
  })

  it('sends files with a message: saved on the machine, named to the agent, images as images', async () => {
    const { readFile } = await import('node:fs/promises')
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    await peer.call('thread.submit', { id: thread.id, text: 'look', attachments: [
      { name: 'shot.png', mimeType: 'image/png', data: png },
      { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('# Hi\n').toString('base64') },
      { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('again\n').toString('base64') },
    ] })
    await until(async () => (await threads(peer)).find((t) => t.id === thread.id)!.status.state === 'done')
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: thread.id })
    const user = value.entries.find((e) => e.kind === 'pi.user')!.model![0] as { content: { type: string; text?: string; mimeType?: string }[] }
    expect(user.content.map((b) => b.type)).toEqual(['text', 'text', 'image', 'text', 'text'])
    expect(user.content[0]!.text).toBe('look')
    expect(user.content[2]!.mimeType).toBe('image/png')
    const saved = join(dir, 'attachments', thread.id)
    expect(user.content[3]!.text).toBe(`<attachment name="notes.md" type="text/markdown" path="${join(saved, 'notes.md')}">\n# Hi\n\n</attachment>`)
    expect(user.content[4]!.text).toContain(`path="${join(saved, 'notes-2.md')}"`)
    expect(await readFile(join(saved, 'shot.png'), 'base64')).toBe(png)
    // A message can be files alone; nothing at all is refused.
    await peer.call('thread.submit', { id: thread.id, text: '', attachments: [{ name: 'a.txt', mimeType: 'text/plain', data: '' }] })
    await expect(peer.call('thread.submit', { id: thread.id, text: '  ' })).rejects.toMatchObject({ kind: 'invalid' })
    await close()
  })

  it("keeps superego's own agent as one hidden thread per machine, in its data folder, knowing superego and only reading", async () => {
    const first = await open()
    const meta = await first.peer.call<ThreadInfo>('thread.meta', { prompt: 'help me add a machine' })
    expect(meta).toMatchObject({ meta: true, cwd: dir, title: 'superego', session: { name: 'superego' } })
    const ego = async (peer: RpcPeer) => (await peer.call<{ value: ThreadInfo | null }>('meta.watch', {})).value
    await until(async () => (await ego(first.peer))!.status.state === 'done')
    // The same thread again, not another; and in no list.
    expect((await first.peer.call<ThreadInfo>('thread.meta', {})).id).toBe(meta.id)
    expect(await threads(first.peer)).toEqual([])
    expect(await first.peer.call('thread.list', { archived: true })).toEqual([])
    expect((await first.peer.call<{ value: ThreadInfo[] }>('threads.watch', {})).value).toEqual([])
    // Never archived.
    await expect(first.peer.call('thread.archive', { id: meta.id })).rejects.toMatchObject({ kind: 'invalid' })
    const { value } = await first.peer.call<{ value: ConversationView }>('thread.watch', { id: meta.id })
    const all = JSON.stringify(value.entries)
    expect(all).toContain("You are superego's own agent")
    expect(all).toContain('you do no work yourself')
    // Tools that read, and thread_start; none that change things.
    const tools = (value.entries.find((e) => e.kind === 'pi.system')!.model![0] as { toolsAdded: { name: string }[] }).toolsAdded.map((t) => t.name)
    expect(tools.sort()).toEqual(['ls', 'open_pane', 'read', 'superego_actions', 'superego_profiles', 'superego_settings', 'thread_list', 'thread_read', 'thread_start'])
    // Other threads don't get its tools or prompt, and don't see it.
    const plain = await first.peer.call<ThreadInfo>('thread.create', { cwd: dir, prompt: 'hi' })
    await until(async () => (await threads(first.peer)).find((t) => t.id === plain.id)!.status.state === 'done')
    expect((await threads(first.peer)).map((t) => t.id)).toEqual([plain.id])
    const other = JSON.stringify((await first.peer.call<{ value: ConversationView }>('thread.watch', { id: plain.id })).value.entries)
    expect(other).not.toContain('superego_settings')
    expect(other).not.toContain("You are superego's own agent")
    // A thread started with it as its parent (as from the command line) is top-level all the same.
    const started = await first.peer.call<ThreadInfo>('thread.create', { cwd: dir, parent: meta.id })
    expect(started.parent).toBeUndefined()
    await first.close()
    // Kept across restarts.
    const second = await open()
    expect((await second.peer.call<ThreadInfo>('thread.meta', {})).id).toBe(meta.id)
    expect((await ego(second.peer))!.id).toBe(meta.id)
    await second.close()
  })

  it('makes one Ego of the meta threads from before it was kept apart, and lists none of them', async () => {
    // A database as an older daemon left it: meta threads among the listed ones, the newest in use, one archived.
    const { Harness, createRegistry, defineDoc } = await import('@earendil-works/pi-durable')
    const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
    const { createModels } = await import('@earendil-works/pi-ai/models')
    const Catalog = defineDoc<{ ids: number[] }>({ kind: 'superego.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true })
    const ThreadDoc = defineDoc<{ title: string; cwd: string; createdAt: number; meta?: boolean; archived?: boolean }>({
      kind: 'superego.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ title: '', cwd: '', createdAt: 0 }), checkpointWhen: () => true,
    })
    const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context')
    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'superego.sqlite')), { models: createModels(), registry: createRegistry() }, context)
    const ids: number[] = []
    for (const meta of [{ title: 'Set up superego', meta: true }, { title: 'Plain' }, { title: 'Set up superego', meta: true }, { title: 'Set up superego', meta: true, archived: true }]) {
      const conversation = await harness.createConversation({
        ownership: { kind: 'ownerless' }, agent: { cwd: dir },
        init: async (tx, created) => { Object.assign(await tx.doc(ThreadDoc, created), { cwd: dir, createdAt: 1, ...meta }); (await tx.doc(Catalog)).ids.push(created) },
      }, context)
      ids.push(Number(conversation.id))
    }
    await harness.close(context)
    const { peer, close } = await open()
    expect((await threads(peer)).map((t) => t.title)).toEqual(['Plain'])
    expect(await peer.call('thread.list', { archived: true })).toEqual([])
    expect(await peer.call<ThreadInfo>('thread.meta', {})).toMatchObject({ id: String(ids[2]), meta: true, title: 'superego' })
    await expect(peer.call('thread.watch', { id: String(ids[0]) })).rejects.toMatchObject({ kind: 'not_found' })
    await close()
  })

  it("clears superego's own agent: the same thread, starting empty again", async () => {
    const { peer, close } = await open()
    expect((await peer.call<{ value: ThreadInfo | null }>('meta.watch', {})).value).toBeNull()
    const meta = await peer.call<ThreadInfo>('thread.meta', { prompt: 'what is a profile?' })
    const state = async () => (await peer.call<{ value: ThreadInfo }>('meta.watch', {})).value.status.state
    await until(async () => await state() === 'done')
    const ended: string[] = []
    peer.on('watch.end', (params: { sub: string; reason: string }) => { ended.push(`${params.sub}:${params.reason}`) })
    const open1 = await peer.call<{ sub: string; value: ConversationView }>('thread.watch', { id: meta.id })
    expect(open1.value.entries.length).toBeGreaterThan(0)
    const cleared = await peer.call<ThreadInfo>('thread.meta.clear', {})
    expect(cleared.id).toBe(meta.id)
    // Windows watching it are told to watch again; then it's empty, with nothing earlier to page back to.
    await until(() => ended.includes(`${open1.sub}:stopped`))
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: meta.id })
    expect(value.entries).toEqual([])
    expect(value.before).toBeUndefined()
    expect(await peer.call('thread.history', { id: meta.id, before: open1.value.entries.at(-1)!.id as number + 1000 })).toEqual({ entries: [], more: false })
    expect((await peer.call<ThreadInfo>('thread.meta', {})).id).toBe(meta.id)
    // It goes on from there.
    await peer.call('thread.submit', { id: meta.id, text: 'again' })
    await until(async () => await state() === 'done')
    const after = (await peer.call<{ value: ConversationView }>('thread.watch', { id: meta.id })).value.entries
    expect(JSON.stringify(after)).toContain('again')
    expect(JSON.stringify(after)).not.toContain('what is a profile?')
    await close()
  })

  it('offers ~/.agents skills to the agent, sends one a message names, and reads AGENTS.md', async () => {
    const { mkdir } = await import('node:fs/promises')
    const skill = async (name: string, front: string, body: string) => {
      await mkdir(join(dir, 'agents', 'skills', name), { recursive: true })
      await writeFile(join(dir, 'agents', 'skills', name, 'SKILL.md'), `---\n${front}\n---\n\n${body}\n`)
    }
    await skill('commit', 'name: commit\ndescription: >-\n  Write commit\n  messages.', '# Commits\nImperative subjects.')
    await skill('secret', 'name: secret\ndescription: Only by name.\ndisable-model-invocation: true', 'Hush.')
    await writeFile(join(dir, 'agents', 'AGENTS.md'), 'Always be kind.')
    await writeFile(join(dir, 'AGENTS.md'), 'This project uses pnpm.')
    const { peer, close } = await open()
    expect(await peer.call('skill.list', {})).toEqual([
      { name: 'commit', description: 'Write commit messages.' }, { name: 'secret', description: 'Only by name.' },
    ])
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
    await peer.call('thread.submit', { id: thread.id, text: 'do $commit and /skill:secret, not $HOME' })
    await until(async () => (await threads(peer)).find((t) => t.id === thread.id)!.status.state === 'done')
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: thread.id })
    const all = JSON.stringify(value.entries)
    // The agent is told what each skill is for and where it is, but not about one kept to being named.
    expect(all).toContain(`<skill name=\\"commit\\" location=\\"${join(dir, 'agents', 'skills', 'commit', 'SKILL.md')}\\">Write commit messages.</skill>`)
    expect(all).not.toContain('Only by name.')
    expect(all).toContain('Always be kind.')
    expect(all).toContain('This project uses pnpm.')
    const user = value.entries.find((e) => e.kind === 'pi.user')!.model![0] as { content: { type: string; text?: string }[] }
    expect(user.content[0]!.text).toBe('do $commit and /skill:secret, not $HOME')
    expect(user.content).toHaveLength(3)
    expect(user.content[1]!.text).toMatch(/^<skill name="commit" [^]*Imperative subjects\.\n<\/skill>$/)
    expect(user.content[1]!.text).not.toContain('description:')
    expect(user.content[2]!.text).toContain('Hush.')
    await close()
  })

  it('watches a file: every change on disk, a save by renaming over it too, and its going', async () => {
    const { rename, unlink } = await import('node:fs/promises')
    await writeFile(join(dir, 'note.md'), 'one\n')
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
    const seen: (string | null)[] = []
    peer.on('file.changed', (params: { content: string | null }) => { seen.push(params.content) })
    const { content } = await peer.call<{ sub: string; content: string }>('file.watch', { id: thread.id, path: 'note.md' })
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
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
    for (const text of ['one', 'two', 'three']) {
      await peer.call('thread.submit', { id: thread.id, text })
      await until(async () => (await threads(peer)).find((t) => t.id === thread.id)!.status.state === 'done')
    }
    const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: thread.id })
    const last = value.entries.at(-1)!.id as number
    const page = await peer.call<{ entries: { id: number; kind: string }[]; more: boolean }>('thread.history', { id: thread.id, before: last, limit: 2 })
    expect(page.entries).toHaveLength(2)
    expect(page.entries[0]!.id).toBeLessThan(page.entries[1]!.id)
    expect(page.entries[1]!.id).toBeLessThan(last)
    expect(page.more).toBe(true)
    const all = await peer.call<{ entries: { id: number }[]; more: boolean }>('thread.history', { id: thread.id, before: last, limit: 200 })
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
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
    const find = async (name: string) => (await peer.call<{ path: string | null }>('file.find', { id: thread.id, name })).path
    expect(await find('Plan')).toBe('Work/Plan.md')
    expect(await find('plan')).toBe('Work/Plan.md')
    expect(await find('Work/Old/Plan')).toBe('Work/Old/Plan.md')
    expect(await find('diagram.png')).toBe('Work/diagram.png')
    expect(await find('Readme')).toBeNull()
    expect(await find('../../etc/passwd')).toBeNull()
    // Paths as agents write them: a folder, a line, the whole path, or one past the folder.
    const where = async (name: string) => peer.call('file.find', { id: thread.id, name })
    expect(await where('Work/Old/')).toEqual({ path: 'Work/Old', folder: true })
    expect(await where('Work/Plan.md:12')).toEqual({ path: 'Work/Plan.md', line: 12 })
    expect(await where('Work/Plan.md#L3-L9')).toEqual({ path: 'Work/Plan.md', line: 3 })
    expect(await where(join(dir, 'Work/Plan.md'))).toEqual({ path: 'Work/Plan.md' })
    expect(await where(dir)).toEqual({ path: '', folder: true })
    expect(await where('/etc/passwd')).toEqual({ path: null, outside: true })
    await close()
  })
})



