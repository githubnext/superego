// A real daemon for a test, in a folder of its own: your extensions set up as the app's, or your profile copied in as
// this machine's user profile, and a scripted model that answers each turn as you wrote it. Close it after.
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connectSocket, listen, openDaemon, type DaemonExtension } from '@superego/daemon'
import { defineApp, envName, PROTOCOL_VERSION, type ExtensionManifest, type Hello, type Json, type Notifications, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import type { Turn } from './model.ts'

/** What `testDaemon` sets up: your extensions or your profile, and the model's script. */
export type TestDaemonOptions = {
  /** Extensions set up as the app's own (bundled), for the daemon's life. */
  extensions?: DaemonExtension[]
  /**
   * A profile: its folder (copied, so edits in the test don't touch yours), or its files by path (`{ 'profile.ts': … }`).
   * It's this machine's user profile `profileName`, and threads start with it.
   */
  profile?: string | Record<string, string>
  /** Its name: `default` unless given. */
  profileName?: string
  /** The model's turns, one per request, in order; after the last, it says it ran out. */
  model?: Turn[]
  /** The daemon's data folder: a new one in tmp unless given (`restart` keeps it). */
  dataDir?: string
  /** How long a setup may take (15s in the app): shorter, to test one that hangs. */
  setupTimeout?: number
}

/** A live value as a test follows it: what it is now, every value it took, and a wait for one. */
export type Watched<T> = {
  readonly value: T
  readonly seen: T[]
  until(check: (value: T) => boolean, what?: string): Promise<T>
  stop(): Promise<void>
}

/** A daemon running for a test, and a client of it: start threads, send them messages, watch values, run actions. */
export type TestDaemon = {
  /** Its data folder. */
  dataDir: string
  /** The profile's folder there (the copy), if it was given one. */
  profileDir: string | undefined
  /** What it said at `hello`, kept current: its protocol features. */
  readonly features: string[]
  /** The extensions set up there, each at its version. */
  readonly extensions: ExtensionManifest[]
  /** The connection, to call anything a client can. */
  peer: RpcPeer
  /** Call a method, as a client would (`thread.list`, an extension's `<name>.<method>`). */
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  /** Run an action by id, as the window would (`action.run`). */
  dispatch<T = unknown>(id: string, params?: Record<string, unknown>): Promise<T>
  /** Start a thread (with the profile, if there is one); with a prompt, sent and waited out. */
  thread(prompt?: string, options?: { cwd?: string; profile?: string; title?: string }): Promise<ThreadInfo>
  /** Send a thread a message and wait for its run to end. */
  send(id: string, text: string): Promise<ThreadInfo>
  /** Wait until a thread's run ended (or it's waiting on the user): its info then. */
  idle(id: string): Promise<ThreadInfo>
  /** A thread's transcript, as JSON text: to look for what was said and what tools answered. */
  transcript(id: string): Promise<string>
  /** Follow a live value (`scope`: one thread's, by its id). */
  watch<T = Json>(key: string, options?: { scope?: string }): Promise<Watched<T>>
  /** Change a file of the profile's copy (`''` removes it). The daemon loads it with the next turn, or `reload()`. */
  edit(path: string, content: string): Promise<void>
  /** Load the profile again now, as the next turn would; resolves once it's set up (or failed: rejects with why). */
  reload(): Promise<void>
  /** Wait until `check` holds, trying every 25ms. */
  until(check: () => boolean | Promise<boolean>, what?: string, timeout?: number): Promise<void>
  /** Stop it and start it again on the same folder (threads, state and the profile kept), with a new script. */
  restart(options?: { model?: Turn[] }): Promise<TestDaemon>
  /** Stop it, and remove its folder (unless it was given one). */
  close(): Promise<void>
}

let opened = 0

/**
 * A real daemon for a test, in a folder of its own: your extensions set up as the app's, or your profile copied in as
 * this machine's user profile, and a scripted model that answers each turn as you wrote it. Close it after.
 *
 *   const daemon = await testDaemon({ profile: here, model: [callTool('enqueue', { what: 'lint' }), say('Queued.')] })
 *   const thread = await daemon.thread('Queue a lint')
 *   expect(await daemon.transcript(thread.id)).toContain('Queued.')
 *   await daemon.close()
 */
export async function testDaemon(options: TestDaemonOptions = {}): Promise<TestDaemon> {
  const given = Boolean(options.dataDir)
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'superego-test-'))
  const name = options.profileName ?? 'default'
  let profileDir: string | undefined
  if (options.profile !== undefined) {
    profileDir = join(dataDir, 'profiles', name)
    // Restarted on the same folder: the copy (and any edits to it) stays.
    const there = await readdir(profileDir).then(() => true, () => false)
    if (!there) {
      await mkdir(profileDir, { recursive: true })
      if (typeof options.profile === 'string') {
        await cp(resolve(options.profile), profileDir, { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(src.slice(resolve(options.profile as string).length)) })
      } else {
        for (const [path, content] of Object.entries(options.profile)) {
          await mkdir(join(profileDir, path, '..'), { recursive: true })
          await writeFile(join(profileDir, path), content)
        }
      }
    }
  }
  // An app of its own: its environment (the model) is this daemon's alone; restarted, the same (its database is named for it).
  const app = defineApp({ name: 'Superego test', id: (options as { appId?: string }).appId ?? `superego-test-${process.pid}-${++opened}` })
  const turns = join(dataDir, `turns-${++opened}.jsonl`)
  await writeFile(turns, (options.model ?? []).map((turn) => JSON.stringify(turn)).join('\n') + '\n')
  process.env[envName(app, 'MODEL')] = `replay:${turns}`
  process.env[envName(app, 'REPLAY_SPEED')] = '0'
  const work = join(dataDir, 'work')
  await mkdir(work, { recursive: true })
  const daemon = await openDaemon({
    app, dataDir, defaultCwd: work, agentsDir: join(dataDir, 'agents'), extensions: options.extensions ?? [],
    ...(options.setupTimeout ? { setupTimeout: options.setupTimeout } : {}),
  })
  const socket = join(dataDir, `d${opened}.sock`)
  const server = await listen(daemon, socket)
  const { peer, socket: connection } = await connectSocket(socket)
  let hello = await peer.call<Hello>('hello', { client: 'superego/testing', version: PROTOCOL_VERSION })
  peer.on('features.changed', ({ features, extensions }: Notifications['features.changed']) => { hello = { ...hello, features, extensions } })

  const until = async (check: () => boolean | Promise<boolean>, what = 'the condition', timeout = 15_000) => {
    const end = Date.now() + timeout
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  const info = async (id: string) => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)
    ?? (await peer.call<ThreadInfo[]>('thread.list', { archived: true })).find((t) => t.id === id)
  const idle = async (id: string) => {
    let now: ThreadInfo | undefined
    await until(async () => { now = await info(id); return Boolean(now && now.status.state !== 'working') }, `thread ${id} to finish its run`)
    return now!
  }

  const test: TestDaemon = {
    dataDir, profileDir, peer,
    get features() { return hello.features },
    get extensions() { return hello.extensions },
    call: (method, params = {}) => peer.call(method, params),
    dispatch: (id, params = {}) => peer.call('action.run', { id, params }),
    async thread(prompt, { cwd, profile, title } = {}) {
      const which = profile ?? (profileDir ? name : undefined)
      const thread = await peer.call<ThreadInfo>('thread.start', { ...(cwd ? { cwd } : {}), ...(which ? { profile: which } : {}), ...(title ? { title } : {}) })
      if (prompt === undefined) return thread
      return test.send(thread.id, prompt)
    },
    async send(id, text) {
      const before = (await info(id))?.activeAt ?? 0
      await peer.call('thread.send', { thread: id, text })
      // Its run started (or already ended) before waiting it out.
      await until(async () => { const now = await info(id); return Boolean(now && (now.status.state === 'working' || (now.activeAt ?? 0) > before)) }, `thread ${id} to take the message`)
      return idle(id)
    },
    idle,
    async transcript(id) {
      const { sub, value } = await peer.call<{ sub: string; value: { entries: unknown[] } }>('thread.watch', { thread: id })
      await peer.call('unwatch', { sub })
      return JSON.stringify(value.entries)
    },
    async watch<T>(key: string, { scope }: { scope?: string } = {}) {
      // Heard from before the watch answers: a value read as it's first watched may be told before the answer comes.
      const early: Notifications['value.changed'][] = []
      let take = (params: Notifications['value.changed']) => { early.push(params) }
      const off = peer.on('value.changed', (params: Notifications['value.changed']) => take(params))
      const { sub, value } = await peer.call<{ sub: string; value: T }>('value.watch', { key, ...(scope !== undefined ? { scope } : {}) })
      let now = value
      const seen = [value]
      take = (params) => {
        if (params.sub !== sub) return
        now = params.value as T
        seen.push(now)
      }
      for (const params of early) take(params)
      return {
        get value() { return now },
        seen,
        async until(check, what = `${key} to change`) { await until(() => check(now), what); return now },
        async stop() { off(); await peer.call('unwatch', { sub }).catch(() => {}) },
      } satisfies Watched<T>
    },
    async edit(path, content) {
      if (!profileDir) throw new Error('This test daemon has no profile to edit')
      const file = join(profileDir, path)
      if (content === '') { await rm(file, { force: true }); return }
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, content)
    },
    async reload() {
      if (!profileDir) throw new Error('This test daemon has no profile to reload')
      await peer.call('action.run', { id: 'profile.reload', params: { name } })
    },
    until,
    async restart({ model } = {}) {
      await stop()
      return testDaemon({ ...options, dataDir, model: model ?? [], appId: app.id } as TestDaemonOptions).then((next) => {
        // The folder is this test's still: the new one removes it when it closes, unless it was given.
        if (!given) (next as { close(): Promise<void> }).close = closeAndRemove(next.close)
        return next
      })
    },
    async close() {
      await stop()
      if (!given) await rm(dataDir, { recursive: true, force: true })
    },
  }
  let stopped = false
  async function stop() {
    if (stopped) return
    stopped = true
    connection.destroy()
    server.close()
    await daemon.close()
    delete process.env[envName(app, 'MODEL')]
    delete process.env[envName(app, 'REPLAY_SPEED')]
  }
  const closeAndRemove = (close: () => Promise<void>) => async () => { await close(); await rm(dataDir, { recursive: true, force: true }) }
  return test
}
