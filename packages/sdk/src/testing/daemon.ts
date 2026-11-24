// A real daemon for a test, in a folder of its own: your extensions set up as the app's, or your profile copied in as
// this machine's user profile, and a scripted model that answers each turn as you wrote it. Close it after.
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connectSocket, listen, openDaemon, type DaemonExtension } from '@superego/daemon'
import { defineApp, envName, PROTOCOL_VERSION, type AppConfig, type ExtensionManifest, type Hello, type Json, type Notifications, type ProfileRef, type RpcPeer, type ThreadInfo } from '@superego/protocol'
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
  /**
   * The model's turns, one per request, in order; after the last, it says it ran out. `'echo'`: a model that answers
   * every request with the last user message, for as many turns as it's asked (a side call to the thread's model too).
   */
  model?: Turn[] | 'echo'
  /** The daemon's data folder: a new one in tmp unless given (made if it isn't there; `restart` keeps it). */
  dataDir?: string
  /** How long a setup may take (15s in the app): shorter, to test one that hangs. */
  setupTimeout?: number
  /** The port sign-in pages send the browser back to (the app's `callbackPort`): a free one, to test a sign-in. */
  callbackPort?: number
  /** How long each extension's `agentParts` may take at a send (5s in the app): longer, for a slow one under test. */
  agentPartsLimit?: number
}

/**
 * A live value as a test follows it: what it is now, every value it took, and a wait for one. It follows the value
 * across `restart`: what the restarted daemon says goes on into `value` and `seen`.
 *
 *   const queue = await daemon.watch<Build[]>('builds.queue', { scope: thread.id })
 *   await queue.until((builds) => builds.length === 2, 'two builds queued')
 *   expect(queue.seen[0]).toEqual([])
 */
export type Watched<T> = {
  readonly value: T
  readonly seen: T[]
  /** Wait until `check` holds for the value (tried as each value comes in, and every 25ms): the value then. */
  until(check: (value: T) => boolean, what?: string): Promise<T>
  stop(): Promise<void>
}

/** A thread, by its id or as the daemon gave it (`ThreadInfo`). */
export type ThreadRef = string | { id: string }

/** A tool call a thread made, as its transcript has it: what the agent asked, and how it went (no `result`: still running). */
export type ToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
  /** `text`: what the model was told (an error's message, when `isError`), its text parts joined. */
  result?: { isError: boolean; text: string }
}

/**
 * A daemon running for a test, and a client of it: start threads, send them messages, watch values, run actions. The
 * handle stays good across `restart`: its connection, `peer` and watches follow the new daemon.
 */
export type TestDaemon = {
  /** The app it runs as: its own id, so its environment, and the names it gives (branches, `.<id>` folders), are its own. */
  app: AppConfig
  /** Its data folder: a temporary one unless given, so each extension's `superego.dir` (`<dataDir>/extensions/<name>`) is the test's own. */
  dataDir: string
  /** The folder agents share (`<dataDir>/agents`): skills in `skills/`. */
  agentsDir: string
  /** The profile's folder there (the copy), if it was given one. */
  profileDir: string | undefined
  /** The profile its threads start with, as a thread's `profile` says it: what `mountUi` takes it as, unless given another. */
  profile: ProfileRef | undefined
  /** What it said at `hello`, kept current: its protocol features. */
  readonly features: string[]
  /** The extensions set up there, each at its version. */
  readonly extensions: ExtensionManifest[]
  /** The socket it listens on (a new one after `restart`): for a `superego` command line to reach it (`<APPID>_SOCKET`). */
  readonly socket: string
  /** The connection, to call anything a client can (open a channel: `Channels.of(daemon.peer)`): the new one after `restart`. */
  readonly peer: RpcPeer
  /** Another client's connection (said hello), as a second window's: closed with the daemon (or a restart), or by `close()` before. */
  connect(): Promise<{ peer: RpcPeer; close(): void }>
  /** Call a method, as a client would (`thread.list`, an extension's `<name>.<method>`). */
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  /**
   * Run an action by id, as the window would. It goes as an `action.run` call (so a `fakeMachine`'s `calls` list it as
   * `{ method: 'action.run', params: { id, params } }`).
   *
   *   await daemon.dispatch('builds.cancel', { thread: thread.id })
   */
  dispatch<T = unknown>(id: string, params?: Record<string, unknown>): Promise<T>
  /**
   * Set one of an extension's secrets (a `secret` setting, by its key), as the user does in Settings; `null` clears it.
   * Its extension reads it with `superego.secrets.get(key)`. A test daemon keeps secrets in its data folder (encrypted),
   * never in your keychain.
   *
   *   await daemon.setSecret('email.token', 'fmu1-test')
   */
  setSecret(key: string, value: string | null): Promise<void>
  /**
   * Start a thread (with the profile, if there is one); with a prompt, sent and waited out.
   *
   *   const thread = await daemon.thread('Queue a lint')   // the model's script ran; its info once idle
   *   const empty = await daemon.thread()                 // started, nothing sent
   */
  thread(prompt?: string, options?: { cwd?: string; profile?: string; title?: string }): Promise<ThreadInfo>
  /** Send a thread a message and wait for its run to end. */
  send(thread: ThreadRef, text: string): Promise<ThreadInfo>
  /** Wait until a thread's run ended (or it's waiting on the user): its info then. */
  idle(thread: ThreadRef): Promise<ThreadInfo>
  /** A thread as the daemon lists it now (archived or hidden too). */
  info(thread: ThreadRef): Promise<ThreadInfo>
  /**
   * What extensions say about a thread (`superego.facts`), by extension name: `{}` when none say anything.
   *
   *   expect((await daemon.facts(thread)).worktrees).toEqual({ branch: 'superego/fix-it' })
   */
  facts(thread: ThreadRef): Promise<Record<string, Json>>
  /**
   * The tool calls a thread made, in order, each with its args and how it went: what the agent asked, without
   * digging in the transcript.
   *
   *   const [call] = await daemon.toolCalls(thread)
   *   expect(call).toMatchObject({ name: 'enqueue', args: { what: 'lint' }, result: { isError: false, text: 'Queued lint' } })
   */
  toolCalls(thread: ThreadRef): Promise<ToolCall[]>
  /** A thread's transcript, its entries as JSON text: to look for what was said and what tools answered (`toolCalls` for its calls). */
  transcript(thread: ThreadRef): Promise<string>
  /**
   * Follow a live value (`scope`: one thread's, by its id). It goes on across `restart`.
   *
   *   const queue = await daemon.watch<Build[]>('builds.queue', { scope: thread.id })
   *   await queue.until((builds) => builds[0]?.state === 'done')
   */
  watch<T = Json>(key: string, options?: { scope?: string }): Promise<Watched<T>>
  /** Change a file of the profile's copy (`''` removes it). The daemon loads it with the next turn, or `reload()`. */
  edit(path: string, content: string): Promise<void>
  /** Load the profile again now, as the next turn would; resolves once it's set up (or failed: rejects with why). */
  reload(): Promise<void>
  /**
   * Wait until `check` holds (true, or a promise of true), trying every 25ms; a timeout fails with `what`.
   *
   *   await daemon.until(async () => (await daemon.toolCalls(thread)).length === 2, 'both calls', 5_000)
   */
  until(check: () => boolean | Promise<boolean>, what?: string, timeout?: number): Promise<void>
  /**
   * Stop it and start it again on the same folder (threads, state and the profile kept), with a new script (the echo
   * model stays). `whileStopped` runs between: what changes while no daemon runs (a branch merged by hand). This handle
   * goes on working (it's the one returned): its calls, watches and a window over it (`mountUi`) reach the new daemon.
   *
   *   await daemon.restart({ model: [say('Back.')] })
   *   expect((await daemon.send(thread, 'Still there?')).status.msg).toBe('Back.')
   */
  restart(options?: { model?: Turn[] | 'echo'; whileStopped?: () => unknown }): Promise<TestDaemon>
  /** Stop it, and remove its folder (unless it was given one). */
  close(): Promise<void>
}

let opened = 0

/** A restart as it goes: the daemon is `stopping`, then `started` again (on a new connection). */
type Restarting = (phase: 'stopping' | 'started') => unknown
/** Who's told of each daemon's restarts: a window over it, which follows it as the app follows a daemon reconnecting. */
const restarted = new WeakMap<TestDaemon, Set<Restarting>>()
/** Be told as `daemon` restarts (awaited), until the function returned is called. */
export function onRestart(daemon: TestDaemon, tell: Restarting): () => void {
  const set = restarted.get(daemon)
  if (!set) return () => {}
  set.add(tell)
  return () => { set.delete(tell) }
}

/** The id of a thread given either way. */
const idOf = (thread: ThreadRef) => typeof thread === 'string' ? thread : thread.id

/** One daemon process's worth: what a restart replaces. */
type Running = {
  peer: RpcPeer
  hello: Hello
  socket: string
  others: Set<{ destroy(): void }>
  stop(): Promise<void>
}

/**
 * A real daemon for a test, in a folder of its own: your extensions set up as the app's, or your profile copied in as
 * this machine's user profile, and a scripted model that answers each turn as you wrote it. Close it after.
 *
 *   const daemon = await testDaemon({ profile: here, model: [callTool('enqueue', { what: 'lint' }), say('Queued.')] })
 *   const thread = await daemon.thread('Queue a lint')
 *   expect(await daemon.toolCalls(thread)).toMatchObject([{ name: 'enqueue', result: { text: 'Queued lint' } }])
 *   await daemon.close()
 */
export async function testDaemon(options: TestDaemonOptions = {}): Promise<TestDaemon> {
  const given = Boolean(options.dataDir)
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'superego-test-'))
  await mkdir(dataDir, { recursive: true })
  const name = options.profileName ?? 'default'
  let profileDir: string | undefined
  if (options.profile !== undefined) {
    profileDir = join(dataDir, 'profiles', name)
    // On a folder given again (a test's own restart): the copy (and any edits to it) stays.
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
  const app = defineApp({
    // `appId`: the repo's own tests', for one that needs the app's own id (its environment's names).
    name: 'Superego test', id: (options as { appId?: string }).appId ?? `superego-test-${process.pid}-${++opened}`,
    ...(options.callbackPort ? { callbackPort: options.callbackPort } : {}),
  })
  const echo = options.model === 'echo'

  /** Start a daemon on the folder, answering with `model`, and connect to it. */
  async function start(model: Turn[] | 'echo'): Promise<Running> {
    const turns = join(dataDir, `turns-${++opened}.jsonl`)
    if (model !== 'echo') await writeFile(turns, model.map((turn) => JSON.stringify(turn)).join('\n') + '\n')
    // The echo model is pi-durable's faux provider.
    process.env[envName(app, 'MODEL')] = model === 'echo' ? 'faux' : `replay:${turns}`
    process.env[envName(app, 'REPLAY_SPEED')] = '0'
    const work = join(dataDir, 'work')
    await mkdir(work, { recursive: true })
    const daemon = await openDaemon({
      app, dataDir, defaultCwd: work, agentsDir: join(dataDir, 'agents'), extensions: options.extensions ?? [], secrets: 'file',
      // Setup finds no model server of the machine's (an Ollama running there): what a test sees is its own.
      localServers: [],
      ...(options.setupTimeout ? { setupTimeout: options.setupTimeout } : {}),
      ...(options.agentPartsLimit ? { agentPartsLimit: options.agentPartsLimit } : {}),
    })
    // Its threads' profiles loaded first, as a window reconnecting finds them once the app's daemon is up a moment: what
    // the test checks right after a start or `restart` (its extensions, a profile's values) is there, not on its way.
    await daemon.profilesLoaded
    const socket = join(dataDir, `d${opened}.sock`)
    const server = await listen(daemon, socket)
    const { peer, socket: connection } = await connectSocket(socket)
    // Heard from before hello answers: what changes right after is told as the answer arrives, and would be missed by a
    // listener added once it's read.
    let offered: Pick<Hello, 'features' | 'extensions'> | undefined
    let ready: Running | undefined
    peer.on('features.changed', ({ features, extensions }: Notifications['features.changed']) => {
      offered = { features, extensions }
      if (ready) ready.hello = { ...ready.hello, ...offered }
    })
    const hello = await peer.call<Hello>('hello', { client: 'superego/testing', version: PROTOCOL_VERSION })
    const running: Running = {
      peer, socket, others: new Set(),
      hello: { ...hello, ...offered },
      async stop() {
        for (const other of running.others) other.destroy()
        connection.destroy()
        server.close()
        await daemon.close()
        delete process.env[envName(app, 'MODEL')]
        delete process.env[envName(app, 'REPLAY_SPEED')]
      },
    }
    ready = running
    return running
  }

  let running: Running | undefined = await start(options.model ?? [])
  const now = () => {
    if (!running) throw new Error('This test daemon is closed')
    return running
  }
  const peer = () => now().peer

  const until = async (check: () => boolean | Promise<boolean>, what = 'the condition', timeout = 15_000) => {
    const end = Date.now() + timeout
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  // Any thread: archived, or hidden (an extension's own), too.
  const find = async (id: string) => {
    for (const list of [{}, { archived: true }, { hidden: true }, { hidden: true, archived: true }]) {
      const found = (await peer().call<ThreadInfo[]>('thread.list', list)).find((t) => t.id === id)
      if (found) return found
    }
    return undefined
  }
  const idle = async (thread: ThreadRef) => {
    const id = idOf(thread)
    let info: ThreadInfo | undefined
    await until(async () => { info = await find(id); return Boolean(info && info.status.state !== 'working') }, `thread ${id} to finish its run`)
    return info!
  }
  /** Every entry of a thread's transcript, oldest first: the watch's window, and what's before it. */
  const entries = async (thread: ThreadRef): Promise<Entry[]> => {
    const id = idOf(thread)
    const { sub, value } = await peer().call<{ sub: string; value: { entries: Entry[]; before?: number } }>('thread.watch', { thread: id })
    await peer().call('unwatch', { sub })
    let all = [...value.entries]
    let before = all[0]?.id ?? (value.before !== undefined ? value.before + 1 : undefined)
    while (value.before !== undefined && before !== undefined) {
      const page = await peer().call<{ entries: Entry[]; more: boolean }>('thread.history', { thread: id, before, limit: 200 })
      all = [...page.entries, ...all]
      if (!page.more || !page.entries.length) break
      before = page.entries[0]!.id
    }
    return all
  }

  /** The values followed: each subscribes again on a restarted daemon. */
  const watches = new Set<{ subscribe(): Promise<void> }>()
  const tellRestarted = new Set<Restarting>()

  const test: TestDaemon = {
    app, dataDir, agentsDir: join(dataDir, 'agents'), profileDir,
    profile: profileDir ? { scope: 'user', name, dir: profileDir } : undefined,
    get socket() { return now().socket },
    get peer() { return peer() },
    get features() { return now().hello.features },
    get extensions() { return now().hello.extensions },
    async connect() {
      const at = now()
      const { peer: other, socket: connection } = await connectSocket(at.socket)
      at.others.add(connection)
      await other.call<Hello>('hello', { client: 'superego/testing', version: PROTOCOL_VERSION })
      return { peer: other, close: () => { at.others.delete(connection); connection.destroy() } }
    },
    call: (method, params = {}) => peer().call(method, params),
    dispatch: (id, params = {}) => peer().call('action.run', { id, params }),
    async setSecret(key, value) { await peer().call('action.run', { id: 'secrets.set', params: { key, value } }) },
    async thread(prompt, { cwd, profile, title } = {}) {
      const which = profile ?? (profileDir ? name : undefined)
      const thread = await peer().call<ThreadInfo>('thread.start', { ...(cwd ? { cwd } : {}), ...(which ? { profile: which } : {}), ...(title ? { title } : {}) })
      if (prompt === undefined) return thread
      return test.send(thread.id, prompt)
    },
    async send(thread, text) {
      const id = idOf(thread)
      const before = (await find(id))?.activeAt ?? 0
      await peer().call('thread.send', { thread: id, text })
      // Its run started (or already ended) before waiting it out.
      await until(async () => { const info = await find(id); return Boolean(info && (info.status.state === 'working' || (info.activeAt ?? 0) > before)) }, `thread ${id} to take the message`)
      return idle(id)
    },
    idle,
    async info(thread) {
      const found = await find(idOf(thread))
      if (!found) throw new Error(`No thread ${idOf(thread)} on this test daemon`)
      return found
    },
    async facts(thread) {
      return (await test.info(thread)).facts ?? {}
    },
    async toolCalls(thread) {
      const calls: ToolCall[] = []
      for (const entry of await entries(thread)) {
        for (const message of entry.model ?? []) {
          if (message.role === 'assistant' && Array.isArray(message.content)) {
            for (const part of message.content as { type: string; id: string; name: string; arguments?: Record<string, unknown> }[]) {
              if (part.type === 'toolCall') calls.push({ id: part.id, name: part.name, args: part.arguments ?? {} })
            }
          } else if (message.role === 'toolResult') {
            const call = calls.findLast((c) => c.id === message.toolCallId)
            if (!call) continue
            const text = Array.isArray(message.content)
              ? (message.content as { type: string; text?: string }[]).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n')
              : String(message.content ?? '')
            call.result = { isError: Boolean(message.isError), text }
          }
        }
      }
      return calls
    },
    async transcript(thread) {
      return JSON.stringify(await entries(thread))
    },
    async watch<T>(key: string, { scope }: { scope?: string } = {}) {
      let now: T | undefined
      const seen: T[] = []
      let sub: string | undefined
      let off = () => {}
      const take = (value: T) => { now = value; seen.push(value) }
      const watch = {
        async subscribe() {
          const at = peer()
          // Heard from before the watch answers: a value read as it's first watched may be told before the answer comes.
          const early: Notifications['value.changed'][] = []
          let hear = (params: Notifications['value.changed']) => { early.push(params) }
          off = at.on('value.changed', (params: Notifications['value.changed']) => hear(params))
          const answer = await at.call<{ sub: string; value: T }>('value.watch', { key, ...(scope !== undefined ? { scope } : {}) })
          sub = answer.sub
          take(answer.value)
          hear = (params) => { if (params.sub === sub) take(params.value as T) }
          for (const params of early) hear(params)
        },
      }
      await watch.subscribe()
      watches.add(watch)
      return {
        get value() { return now as T },
        seen,
        async until(check, what = `${key} to change`) { await until(() => check(now as T), what); return now as T },
        async stop() {
          watches.delete(watch)
          off()
          // The daemon closed already (the test closing it first): nothing left to stop watching there.
          if (running && sub) await running.peer.call('unwatch', { sub }).catch(() => {})
        },
      } satisfies Watched<T>
    },
    async edit(path, content) {
      if (!profileDir) throw new Error('This test daemon has no profile to edit: give testDaemon a profile')
      const file = join(profileDir, path)
      if (content === '') { await rm(file, { force: true }); return }
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, content)
    },
    async reload() {
      if (!profileDir) throw new Error('This test daemon has no profile to reload: give testDaemon a profile')
      await peer().call('action.run', { id: 'profile.reload', params: { name } })
    },
    until,
    async restart({ model, whileStopped } = {}) {
      for (const tell of [...tellRestarted]) await tell('stopping')
      // Closed already, it starts again all the same: on its folder, if it was given one (else a new, empty one).
      const was = running
      running = undefined
      await was?.stop()
      await mkdir(dataDir, { recursive: true })
      await whileStopped?.()
      running = await start(model ?? (echo ? 'echo' : []))
      for (const watch of watches) await watch.subscribe()
      for (const tell of [...tellRestarted]) await tell('started')
      return test
    },
    async close() {
      const was = running
      running = undefined
      watches.clear()
      await was?.stop()
      if (!given) await rm(dataDir, { recursive: true, force: true })
    },
  }
  restarted.set(test, tellRestarted)
  return test
}

/** A transcript entry, as far as `toolCalls` reads it. */
type Entry = { id: number; kind: string; model?: { role: string; content?: unknown; toolCallId?: string; isError?: boolean }[] }
