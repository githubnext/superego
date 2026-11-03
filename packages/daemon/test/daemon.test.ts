import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import { PROTOCOL_VERSION, type AuthEvent, type Hello, type Notifications, type ProviderAuthInfo, type RpcPeer, type SessionInfo, type SettingsSnapshot } from '@mu/protocol'
import { connectSocket, listen, openDaemon, type Daemon } from '../src/index.ts'

// Only the scripted model, whatever keys the machine running the tests has.
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

let dir: string
const open = async ({ faux = true } = {}) => {
  if (faux) process.env.MU_MODEL = 'faux'
  else delete process.env.MU_MODEL
  const daemon = await openDaemon({ dataDir: dir, defaultCwd: dir })
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

const sessions = (peer: RpcPeer) => peer.call<SessionInfo[]>('session.list', {})

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
    expect(hello.features).toEqual(expect.arrayContaining(['sessions', 'settings', 'auth']))
    expect(hello.machine.id).toMatch(/^[0-9a-f-]{36}$/)
    await first.close()
    const second = await open()
    expect((await second.peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })).machine.id).toBe(hello.machine.id)
    await second.close()
  })

  it('runs a session, streams its view as ops, and derives status', async () => {
    const { peer, close } = await open()
    const created = await peer.call<SessionInfo>('session.create', { title: 'first' })
    expect(created.status.state).toBe('idle')

    const watched = await peer.call<{ sub: string; value: ConversationView }>('session.watch', { id: created.id })
    let view = watched.value
    peer.on('watch.ops', ({ sub, ops }: Notifications['watch.ops']) => { if (sub === watched.sub) view = applyImmutable(view, ops as Op[]) })

    const changes: SessionInfo[][] = []
    const list = await peer.call<{ sub: string; value: SessionInfo[] }>('sessions.watch', {})
    peer.on('sessions.changed', ({ value }: Notifications['sessions.changed']) => changes.push(value))
    expect(list.value.map((s) => s.id)).toEqual([created.id])

    await peer.call('session.submit', { id: created.id, text: 'hello mu' })
    await until(() => view.entries.some((entry) => entry.kind === 'pi.assistant'))
    const answer = view.entries.find((entry) => entry.kind === 'pi.assistant')!
    expect(JSON.stringify(answer)).toContain('echo: hello mu')

    await until(async () => (await sessions(peer))[0]!.status.state === 'done')
    expect(changes.flat().some((s) => s.status.state === 'working')).toBe(true)

    await peer.call('session.seen', { id: created.id })
    expect((await sessions(peer))[0]!.status.state).toBe('idle')
    await close()
  })

  it('keeps sessions across a daemon restart', async () => {
    const first = await open()
    const created = await first.peer.call<SessionInfo>('session.create', {})
    await first.peer.call('session.submit', { id: created.id, text: 'remember me' })
    await until(async () => (await sessions(first.peer))[0]!.status.state === 'done')
    await first.close()

    const second = await open()
    const [again] = await sessions(second.peer)
    expect(again).toMatchObject({ id: created.id, title: 'remember me', status: { state: 'done' } })
    const { value } = await second.peer.call<{ value: ConversationView }>('session.watch', { id: created.id })
    expect(JSON.stringify(value.entries)).toContain('echo: remember me')
    await second.close()
  })

  it('refuses to run without a model, pointing at settings', async () => {
    const { peer, close } = await open({ faux: false })
    const created = await peer.call<SessionInfo>('session.create', {})
    await expect(peer.call('session.submit', { id: created.id, text: 'hi' })).rejects.toMatchObject({ kind: 'no_model', hint: expect.stringContaining('Settings') })
    await close()
  })

  it('serves settings: sections, validated values, persisted across restarts', async () => {
    const first = await open()
    const { value } = await first.peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
    expect(value.sections.map((s) => s.id)).toEqual(['model', 'providers'])
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

describe('record and replay', () => {
  it('records answers and plays them back in order', async () => {
    const recording = join(dir, 'turns.jsonl')
    process.env.MU_RECORD = recording
    const first = await open()
    const one = await first.peer.call<SessionInfo>('session.create', {})
    await first.peer.call('session.submit', { id: one.id, text: 'first' })
    await until(async () => (await sessions(first.peer))[0]!.status.state === 'done')
    await first.peer.call('session.submit', { id: one.id, text: 'second' })
    await until(async () => (await sessions(first.peer))[0]!.status.state === 'done')
    await first.close()
    delete process.env.MU_RECORD

    const replayDir = join(dir, 'replay')
    process.env.MU_MODEL = 'replay:' + recording
    process.env.MU_REPLAY_SPEED = '0'
    const daemon = await openDaemon({ dataDir: replayDir, defaultCwd: dir })
    const server = await listen(daemon, join(replayDir, 'mu.sock'))
    const { peer, socket } = await connectSocket(join(replayDir, 'mu.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    const created = await peer.call<SessionInfo>('session.create', {})
    const answers: string[] = []
    for (const text of ['anything', 'else', 'more']) {
      await peer.call('session.submit', { id: created.id, text })
      await until(async () => (await sessions(peer))[0]!.status.state === 'done')
      const { value } = await peer.call<{ value: ConversationView }>('session.watch', { id: created.id })
      answers.push(JSON.stringify(value.entries.filter((e) => e.kind === 'pi.assistant').at(-1)))
      await peer.call('session.seen', { id: created.id })
    }
    expect(answers[0]).toContain('echo: first')
    expect(answers[1]).toContain('echo: second')
    expect(answers[2]).toContain('Replay finished')
    socket.destroy(); server.close(); await daemon.close()
    delete process.env.MU_REPLAY_SPEED
  })
})
