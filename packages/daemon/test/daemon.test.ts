import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import { defineApp, PROTOCOL_VERSION, type ActionInfo, type ActionLogEntry, type AuthEvent, type Hello, type ModelCatalog, type Notifications, type ProviderAuthInfo, type RpcPeer, type ThreadInfo, type SettingsSnapshot } from '@mu/protocol'
import { connectSocket, listen, openDaemon, type Daemon } from '../src/index.ts'

// Only the scripted model, whatever keys the machine running the tests has.
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

const MU = defineApp({ name: 'mu', id: 'mu' })
let dir: string
const open = async ({ faux = true } = {}) => {
  if (faux) process.env.MU_MODEL = 'faux'
  else delete process.env.MU_MODEL
  const daemon = await openDaemon({ app: MU, dataDir: dir, defaultCwd: dir })
  const server = await listen(daemon, join(dir, 'mu.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'mu.sock'))
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

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mu-test-')) })
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

    await peer.call('thread.submit', { id: created.id, text: 'hello mu' })
    await until(() => view.entries.some((entry) => entry.kind === 'pi.assistant'))
    const answer = view.entries.find((entry) => entry.kind === 'pi.assistant')!
    expect(JSON.stringify(answer)).toContain('echo: hello mu')

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
    expect(value.sections.map((s) => s.id)).toEqual(['model', 'providers', 'web'])
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
    expect(created).toMatchObject({ cwd: dir, title: 'first words', ownModel: true })
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
    process.env.MU_MODEL = 'replay:' + recording
    process.env.MU_REPLAY_SPEED = '20'
    let restarts = 0
    const daemon = await openDaemon({ app: MU, dataDir: dir, defaultCwd: dir, build: 'b1', onRestart: () => restarts++ })
    delete process.env.MU_REPLAY_SPEED
    const server = await listen(daemon, join(dir, 'mu.sock'))
    const { peer, socket } = await connectSocket(join(dir, 'mu.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    await peer.call('settings.set', { key: 'agent.model', value: 'replay/replay' })

    await expect(peer.call('daemon.restart', { build: 'other' })).rejects.toMatchObject({ kind: 'changed' })
    const created = await peer.call<ThreadInfo>('thread.create', {})
    await peer.call('thread.submit', { id: created.id, text: 'go' })
    await until(async () => (await threads(peer))[0]!.status.state === 'working')
    expect(await peer.call('daemon.restart', { build: 'b1' })).toEqual({ restarted: false, busy: true })
    expect(restarts).toBe(0)

    expect(await peer.call('daemon.restart', { build: 'b1', interrupt: true })).toEqual({ restarted: true, busy: true })
    await until(() => restarts === 1)
    await expect(peer.call('thread.list', {})).rejects.toMatchObject({ kind: 'restarting' })
    socket.destroy(); server.close(); await daemon.close()
  })
})

describe('record and replay', () => {
  it('records answers and plays them back in order', async () => {
    const recording = join(dir, 'turns.jsonl')
    process.env.MU_RECORD = recording
    const first = await open()
    const one = await first.peer.call<ThreadInfo>('thread.create', {})
    await first.peer.call('thread.submit', { id: one.id, text: 'first' })
    await until(async () => (await threads(first.peer))[0]!.status.state === 'done')
    await first.peer.call('thread.submit', { id: one.id, text: 'second' })
    await until(async () => (await threads(first.peer))[0]!.status.state === 'done')
    await first.close()
    delete process.env.MU_RECORD

    const replayDir = join(dir, 'replay')
    process.env.MU_MODEL = 'replay:' + recording
    process.env.MU_REPLAY_SPEED = '0'
    const daemon = await openDaemon({ app: MU, dataDir: replayDir, defaultCwd: dir })
    const server = await listen(daemon, join(replayDir, 'mu.sock'))
    const { peer, socket } = await connectSocket(join(replayDir, 'mu.sock'))
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
    delete process.env.MU_REPLAY_SPEED
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

  it('archives a thread out of the list, and back', async () => {
    const { peer, close } = await open()
    const kept = await peer.call<ThreadInfo>('thread.create', { title: 'kept' })
    const old = await peer.call<ThreadInfo>('thread.create', { title: 'old' })
    await peer.call('thread.archive', { id: old.id })
    expect((await threads(peer)).map((s) => s.id)).toEqual([kept.id])
    expect((await peer.call<ThreadInfo[]>('thread.list', { archived: true })).map((s) => s.id)).toEqual([old.id])
    await peer.call('thread.unarchive', { id: old.id })
    expect((await threads(peer)).map((s) => s.id).sort()).toEqual([kept.id, old.id].sort())
    await close()
  })

  it('keeps panes with a thread: open (the same one again comes forward), focus, close', async () => {
    const { peer, close } = await open()
    const thread = await peer.call<ThreadInfo>('thread.create', { title: 'panes' })
    const diff = await peer.call<{ id: string }>('pane.open', { id: thread.id, kind: 'diff' })
    const preview = await peer.call<{ id: string }>('pane.open', { id: thread.id, kind: 'preview', params: { url: 'http://localhost:3000' } })
    expect((await peer.call<{ id: string }>('pane.open', { id: thread.id, kind: 'diff' })).id).toBe(diff.id)
    let info = (await threads(peer)).find((s) => s.id === thread.id)!
    expect(info.panes?.map((p) => p.kind)).toEqual(['diff', 'preview'])
    expect(info.pane).toBe(diff.id)
    await peer.call('pane.focus', { id: thread.id })
    expect((await threads(peer)).find((s) => s.id === thread.id)!.pane).toBeUndefined()
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
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir, worktree: false })
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

  it('gives a thread in a repository a worktree of its own, in the same session, removed when archived clean', async () => {
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
    const thread = await peer.call<ThreadInfo>('thread.create', { cwd: join(dir, 'app'), title: 'Fix the login flow' })
    expect(thread.worktree?.branch).toMatch(/^mu\/fix-the-login-flow-[0-9a-f]{6}$/)
    expect(thread.cwd).toBe(join(thread.worktree!.path, 'app'))
    expect(thread.session).toEqual({ root, name: basename(root) })
    expect(git('branch', '--list', thread.worktree!.branch)).toContain(thread.worktree!.branch)
    // In place, when asked: the same session.
    const here = await peer.call<ThreadInfo>('thread.create', { cwd: dir, worktree: false })
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
    await close()
  })
})



