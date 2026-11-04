// The mu daemon: one per user per machine. It owns a pi-durable Harness on SQLite, the session catalog, and every
// live subscription. Clients (the Electron app, the CLI, a remote app over ssh) speak the protocol in @mu/protocol.
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  type Conversation, type ConversationId, type ConversationView, createRegistry, defineDoc, Harness, type LiveState,
  type Storage,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createCodingTools } from '@earendil-works/pi-durable/tools'
import {
  deriveStatus, FEATURES, PROTOCOL_VERSION, RpcError, type AppConfig, type Json, type MachineInfo, type Methods, type Notifications, type RpcPeer, type SessionInfo,
} from '@mu/protocol'
import { serveSettings, SettingsRegistry, type SettingsStore } from '@mu/settings'
import { FileSettingsStore } from '@mu/settings/file'
import { createAgentSettings } from './agent-settings.ts'
import type { DaemonApi, DaemonExtension, LiveValue, StatusContribution } from './extension.ts'

const context = BACKGROUND_CONTEXT

/** Which conversations are sessions, newest last. Child conversations (subagents) are not listed here. */
const Catalog = defineDoc<{ ids: number[] }>({
  kind: 'mu.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true,
})

/** A session's own metadata, next to its transcript. */
type SessionMeta = { title: string; cwd: string; createdAt: number; seen?: { entryId?: number; failureTaskId?: number } }
const SessionDoc = defineDoc<SessionMeta>({
  kind: 'mu.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current',
  initial: () => ({ title: '', cwd: '', createdAt: 0 }), checkpointWhen: () => true,
})

export type DaemonOptions = {
  app: AppConfig
  dataDir: string
  /** Defaults to `settings.json` in `dataDir`. */
  settingsStore?: SettingsStore
  /** Defaults to SQLite in `dataDir`. */
  storage?: Storage
  /** The app's extensions (their daemon halves), set up in order. */
  extensions?: DaemonExtension[]
  /** Where sessions work when created without a cwd. */
  defaultCwd?: string
  /** The build of the code running, reported in `hello`. */
  build?: string
  /** Called once a restart was accepted and answered; the host closes the daemon and exits. */
  onRestart?: () => void
}

/** One mounted session: its conversation and a small watch that keeps its status current. */
type Mounted = { conversation: Conversation; meta: SessionMeta; live?: LiveState; lastEntryId?: number; stop(): Promise<unknown> }

export type Daemon = {
  machine: MachineInfo
  settings: SettingsRegistry
  /** Register this daemon's methods on a connection's peer; returns a cleanup for when it disconnects. */
  serve(peer: RpcPeer): () => void
  close(): Promise<void>
}

/**
 * This machine's identity, created once and kept in the data dir. Written to a temporary file and hard-linked into
 * place, which is atomic and fails if the id exists: two daemons starting at once agree on whichever linked first.
 */
async function machineId(dataDir: string) {
  const path = join(dataDir, 'machine-id')
  const existing = (await readFile(path, 'utf8').catch(() => '')).trim()
  if (existing) return existing
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, randomUUID(), { mode: 0o600 })
  await link(temp, path).catch(() => {})
  await rm(temp, { force: true })
  return (await readFile(path, 'utf8')).trim()
}

/**
 * A session's title from its first message: the first sentence, up to 72 characters, cut at a word with an ellipsis
 * when longer. The rest of the message stays in the transcript.
 */
export function titleOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentence = flat.match(/^.+?[.?!](?=\s|$)/)?.[0] ?? flat
  if (sentence.length <= 72) return sentence
  const cut = sentence.slice(0, 72)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 72).replace(/[,;:]$/, '')}…`
}

export async function openDaemon(options: DaemonOptions): Promise<Daemon> {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const settings = new SettingsRegistry(options.settingsStore ?? new FileSettingsStore(join(options.dataDir, 'settings.json')))
  const agent = await createAgentSettings(settings, options.dataDir, options.app)
  const registry = createRegistry()
  registry.install(createCodingTools())

  const storage = options.storage ?? await openNodeSqliteStorage(join(options.dataDir, `${options.app.id}.sqlite`))
  const defaultCwd = options.defaultCwd ?? process.cwd()
  const harness = await Harness.open(storage, {
    models: agent.models,
    registry,
    // Attribution names the app to providers that show it; without a url there is nothing to show.
    identity: { attribution: options.app.url ? { name: options.app.name, url: options.app.url } : null },
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd }),
  }, context)

  const machine: MachineInfo = {
    id: await machineId(options.dataDir), hostname: hostname(), platform: platform(), pid: process.pid, dataDir: options.dataDir,
    build: options.build ?? 'dev',
  }
  /** Set once a restart is accepted: no new work starts, so nothing is cut off that wasn't agreed to. */
  let restarting = false
  const mounted = new Map<string, Mounted>()
  const listListeners = new Set<() => void>()
  let listQueued = false
  const changed = () => {
    if (listQueued) return
    listQueued = true
    queueMicrotask(() => { listQueued = false; for (const listener of listListeners) listener() })
  }

  async function mount(id: ConversationId) {
    const key = String(id)
    const existing = mounted.get(key)
    if (existing) return existing
    const conversation = await harness.conversation(id, context)
    if (!conversation) throw new RpcError('not_found', `No session ${key}`)
    // A one-entry window is enough to know the newest entry and the live run.
    const watch = await conversation.watch(context, { min: 1, max: 2 })
    const entry: Mounted = {
      conversation,
      meta: (await harness.snapshot(SessionDoc, id, context)) ?? { title: '', cwd: defaultCwd, createdAt: 0 },
      stop: () => watch.stop(),
    }
    const absorb = (view: ConversationView) => {
      entry.live = view.docs['pi.live'] as LiveState | undefined
      entry.lastEntryId = view.entries.at(-1)?.id
      changed()
    }
    absorb(watch.value)
    watch.start(async (call) => { if (call.kind === 'value') absorb(call.value) })
    mounted.set(key, entry)
    return entry
  }

  const info = (id: string, m: Mounted): SessionInfo => ({
    id, title: m.meta.title || 'New session', cwd: m.meta.cwd, createdAt: m.meta.createdAt,
    status: deriveStatus({ live: m.live, lastEntryId: lastAnswer(m), seen: m.meta.seen, ...blockedOf(id) }),
  })
  /** Only an assistant answer makes a session "done"; the user's own message does not. */
  const lastAnswer = (m: Mounted) => m.live?.run ? undefined : m.lastEntryId

  async function list(): Promise<SessionInfo[]> {
    const catalog = await harness.snapshot(Catalog, context)
    const items: SessionInfo[] = []
    for (const id of [...(catalog?.ids ?? [])].reverse()) items.push(info(String(id), await mount(id as ConversationId)))
    return items
  }

  async function get(id: string) {
    const conversationId = Number(id) as ConversationId
    const catalog = await harness.snapshot(Catalog, context)
    if (!catalog?.ids.includes(conversationId)) throw new RpcError('not_found', `No session ${id}`)
    return mount(conversationId)
  }

  async function updateMeta(id: string, edit: (meta: SessionMeta) => void) {
    const m = await get(id)
    m.meta = await m.conversation.commit(async (tx) => {
      const meta = await tx.doc(SessionDoc, m.conversation.id)
      edit(meta)
      return JSON.parse(JSON.stringify(meta)) as SessionMeta
    }, context)
    changed()
  }

  // ── Extensions ──────────────────────────────────────────────────────────────────────────────────────────────────

  const connections = new Set<RpcPeer>()
  const extensionMethods = new Map<string, (params: any) => unknown>()
  const values = new Map<string, { value: Json; listeners: Set<(value: Json) => void> }>()
  const contributors: ((sessionId: string) => StatusContribution | undefined)[] = []
  const cleanups: (() => void)[] = []
  const blockedOf = (id: string) => {
    for (const contribute of contributors) {
      const blocked = contribute(id)
      if (blocked) return { blocked }
    }
    return {}
  }
  const named = (extension: string, name: string) => {
    if (!name.startsWith(`${extension}.`)) throw new Error(`Extension ${extension} must name things "${extension}.<name>", not "${name}"`)
    return name
  }

  for (const extension of options.extensions ?? []) {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw new Error(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    const api: DaemonApi = {
      app: options.app,
      harness,
      agent: (agentExtension) => registry.install(agentExtension),
      settings,
      method: (method, handler) => { extensionMethods.set(named(extension.name, method), handler) },
      value<T extends Json>(key: string, initial: T): LiveValue<T> {
        const name = named(extension.name, key)
        const entry = { value: initial as Json, listeners: new Set<(value: Json) => void>() }
        values.set(name, entry)
        const set = (next: T) => {
          entry.value = next
          for (const listener of entry.listeners) listener(next)
        }
        return { get: () => entry.value as T, set, update: (edit) => set(edit(entry.value as T)) }
      },
      status: (contribute) => { contributors.push(contribute) },
      invalidate: changed,
      sessions: {
        list: () => list(),
        conversation: async (id) => (await get(id)).conversation,
        of: (conversationId) => mounted.has(String(conversationId)) ? String(conversationId) : undefined,
      },
    }
    try {
      const cleanup = await extension.setup(api)
      if (cleanup) cleanups.push(cleanup)
    } catch (error) {
      throw new Error(`Extension ${extension.name} failed to start: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  const features = [...FEATURES, ...(options.extensions ?? []).map((extension) => `ext:${extension.name}`)]

  // Mount everything once so statuses (and anything a previous process left running) are live from the start.
  await list()
  harness.resume()

  type H = { [M in keyof Methods]: (params: Methods[M]['params']) => Promise<Methods[M]['result']> }

  return {
    machine,
    settings,
    serve(peer) {
      const subs = new Map<string, () => unknown>()
      const notify = <N extends keyof Notifications>(event: N, params: Notifications[N]) => peer.notify(event, params)
      const handlers: H = {
        async hello({ version }) {
          if (version !== PROTOCOL_VERSION) {
            throw new RpcError('version_mismatch', `This machine's mu speaks protocol ${PROTOCOL_VERSION}, the client ${version}`, { hint: 'Update mu on the older side.' })
          }
          return { version: PROTOCOL_VERSION, features, machine, methods: [...Object.keys(handlers), ...extensionMethods.keys()] }
        },
        'session.list': () => list(),
        async 'session.create'({ cwd, title }) {
          const meta: SessionMeta = { title: title ?? '', cwd: cwd || defaultCwd, createdAt: Date.now() }
          const { model, thinkingLevel } = agent.resolve()
          const conversation = await harness.createConversation({
            ownership: { kind: 'ownerless' },
            agent: { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), cwd: meta.cwd },
            init: async (tx, created) => {
              Object.assign(await tx.doc(SessionDoc, created), meta)
              ;(await tx.doc(Catalog)).ids.push(created)
            },
          }, context)
          const m = await mount(conversation.id)
          changed()
          return info(String(conversation.id), m)
        },
        async 'session.rename'({ id, title }) {
          await updateMeta(id, (meta) => { meta.title = title })
          return null
        },
        async 'session.submit'({ id, text, requestId, whenBusy }) {
          const m = await get(id)
          // Every turn runs with the model and thinking level the settings say now.
          const { model, thinkingLevel } = agent.resolve()
          if (!model) throw new RpcError('no_model', 'No model is available', { hint: 'Sign in to a provider in Settings.' })
          await m.conversation.configure({ model, thinkingLevel: thinkingLevel ?? null }, context)
          if (!m.meta.title) await updateMeta(id, (meta) => { meta.title = titleOf(text) })
          const submission = await m.conversation.submit({ type: 'input', content: text, requestId: requestId ?? randomUUID(), ...(whenBusy ? { whenBusy } : {}) }, context)
          return { submission: String(submission.id) }
        },
        async 'session.abort'({ id }) {
          await (await get(id)).conversation.abort(context)
          return null
        },
        async 'session.seen'({ id }) {
          const m = await get(id)
          const seen: NonNullable<SessionMeta['seen']> = {}
          if (m.lastEntryId !== undefined) seen.entryId = m.lastEntryId
          if (m.live?.runFailure) seen.failureTaskId = m.live.runFailure.taskId
          await updateMeta(id, (meta) => { meta.seen = seen })
          return null
        },
        async 'session.watch'({ id }) {
          const m = await get(id)
          const watch = await m.conversation.watch(context)
          const sub = randomUUID()
          subs.set(sub, () => watch.stop())
          watch.start(async (call) => { if (call.kind === 'value') notify('watch.ops', { sub, ops: call.ops as unknown[] }) })
          void watch.closed.then((end) => { if (subs.delete(sub)) notify('watch.end', { sub, reason: end.kind }) })
          return { sub, value: watch.value }
        },
        async 'sessions.watch'() {
          const sub = randomUUID()
          let last = ''
          const push = async () => {
            const value = await list()
            const json = JSON.stringify(value)
            if (json !== last) { last = json; notify('sessions.changed', { sub, value }) }
          }
          listListeners.add(push)
          subs.set(sub, () => { listListeners.delete(push) })
          const value = await list()
          last = JSON.stringify(value)
          return { sub, value }
        },
        ...serveSettings(settings, (params) => notify('settings.changed', params), subs),
        async 'auth.login'({ provider, type, key }) {
          const flow: string = agent.login(provider, type, key, (event) => notify('auth.event', { flow, event }))
          return { flow }
        },
        async 'auth.respond'({ flow, prompt, value }) {
          agent.respond(flow, prompt, value)
          return null
        },
        async 'auth.cancel'({ flow }) {
          agent.cancel(flow)
          return null
        },
        async 'auth.logout'({ provider }) {
          await agent.logout(provider)
          return null
        },
        async 'daemon.restart'({ build, interrupt }) {
          if (build !== machine.build) throw new RpcError('changed', 'The running daemon changed. Check again.')
          if (restarting) throw new RpcError('restarting', 'Already restarting')
          // Decided synchronously from the mounted sessions, so no run can start between the check and the flag.
          const busy = [...mounted.values()].some((m) => m.live?.run)
          if (busy && !interrupt) return { restarted: false, busy }
          restarting = true
          setImmediate(() => options.onRestart?.())
          return { restarted: true, busy }
        },
        async 'value.watch'({ key }) {
          const entry = values.get(key)
          if (!entry) throw new RpcError('not_found', `No value ${key}`)
          const sub = randomUUID()
          const listener = (value: Json) => notify('value.changed', { sub, key, value })
          entry.listeners.add(listener)
          subs.set(sub, () => { entry.listeners.delete(listener) })
          return { sub, value: entry.value }
        },
        async unwatch({ sub }) {
          const stop = subs.get(sub)
          subs.delete(sub)
          await stop?.()
          return null
        },
      }
      connections.add(peer)
      for (const [method, handler] of [...Object.entries(handlers), ...extensionMethods]) {
        peer.handle(method, (params: unknown) => {
          if (restarting && method !== 'hello') throw new RpcError('restarting', 'The daemon is restarting. Try again in a moment.')
          return (handler as (params: unknown) => unknown)(params)
        })
      }
      return () => {
        connections.delete(peer)
        for (const stop of subs.values()) void stop()
        subs.clear()
      }
    },
    async close() {
      for (const cleanup of cleanups.reverse()) cleanup()
      agent.close()
      for (const m of mounted.values()) await m.stop()
      await harness.close(context)
    },
  }
}
