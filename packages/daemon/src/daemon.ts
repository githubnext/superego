// The mu daemon: one per user per machine. It owns a pi-durable Harness on SQLite, the session catalog, and every
// live subscription. Clients (the Electron app, the CLI, a remote app over ssh) speak the protocol in @mu/protocol.
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, platform } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  type Conversation, type ConversationId, type ConversationView, createRegistry, defineDoc, defineExtension, defineTool, type Extension, Harness, hook,
  type LiveState, section, type Storage, wrapSection, wrapTool,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createCodingTools } from '@earendil-works/pi-durable/tools'
import {
  arr, bool, defineAction, deriveStatus, FEATURES, int, lit, nullable, num, obj, opt, PROTOCOL_VERSION, Router, RpcError, str, union, unknown, type AppConfig, type Exposure, type Json, type MachineInfo, type Methods, type Notifications, type RpcPeer, type SessionInfo,
} from '@mu/protocol'
import { serveSettings, SettingsRegistry, type SettingsStore } from '@mu/settings'
import { FileSettingsStore } from '@mu/settings/file'
import { createAgentSettings } from './agent-settings.ts'
import type { DaemonApi, DaemonExtension, LiveValue, StatusContribution } from './extension.ts'
import { defineProfile, findProfile, hashProfile, listProfiles, loadProfile, provideSdk, Trust, type LoadedProfile, type ProfileRef } from './profiles.ts'

const context = BACKGROUND_CONTEXT

/** Which conversations are sessions, newest last. Child conversations (subagents) are not listed here. */
const Catalog = defineDoc<{ ids: number[] }>({
  kind: 'mu.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true,
})

/** A session's own metadata, next to its transcript. */
type SessionMeta = {
  title: string; cwd: string; createdAt: number; seen?: { entryId?: number; failureTaskId?: number }
  /** The session's own model and thinking; unset follows its profile, else this machine's settings. */
  model?: string; thinking?: string
  /** The profile it started with (see profiles.ts); unset runs plain mu. */
  profile?: ProfileRef
}
const SessionDoc = defineDoc<SessionMeta>({
  kind: 'mu.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current',
  initial: () => ({ title: '', cwd: '', createdAt: 0 }), checkpointWhen: () => true,
})

/** What a daemon action gets besides its params: who called, and a way to tell that connection something. */
export type DaemonContext = { source: string; notify(event: string, params: unknown): void }

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
type Mounted = {
  conversation: Conversation; meta: SessionMeta; live?: LiveState; lastEntryId?: number
  /** What the session runs with and has spent, and when anything last happened in it. */
  model?: string; cost?: number; activeAt?: number
  stop(): Promise<unknown>
}

type Usage = { cost?: { total?: number } }
/** Everything a session spent: every model's answers and every tool's own usage. */
const costOf = (usage: { models?: Record<string, Usage>; tools?: Record<string, Usage> } | undefined) =>
  usage && [...Object.values(usage.models ?? {}), ...Object.values(usage.tools ?? {})].reduce((sum, u) => sum + (u.cost?.total ?? 0), 0)

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
  // A long sentence's first clause, when it says enough on its own: "Add a --dry-run flag to the import command".
  const clause = sentence.match(/^(.{24,72}?)[:;—]\s/)?.[1]
  if (clause) return clause
  const cut = sentence.slice(0, 72)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 72).replace(/[,;:]$/, '')}…`
}

export async function openDaemon(options: DaemonOptions): Promise<Daemon> {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const settings = new SettingsRegistry(options.settingsStore ?? new FileSettingsStore(join(options.dataDir, 'settings.json')))
  const agent = await createAgentSettings(settings, options.dataDir, options.app)
  const registry = createRegistry()
  /** What every session has unless its profile does without: coding tools and the bundled extensions' agent parts. */
  const builtins: Extension[] = []
  const installBuiltin = (extension: Extension) => { registry.install(extension); builtins.push(extension) }
  installBuiltin(createCodingTools())
  // Profiles and their extensions import from 'mu'; this is what they get.
  provideSdk({
    defineProfile, defineExtension, defineTool, section, hook, wrapTool, wrapSection,
    arr, bool, int, lit, nullable, num, obj, opt, str, union, unknown,
  })
  const trust = new Trust(options.dataDir)
  const userProfiles = join(options.dataDir, 'profiles')

  const storage = options.storage ?? await openNodeSqliteStorage(join(options.dataDir, `${options.app.id}.sqlite`))
  const defaultCwd = options.defaultCwd ?? process.cwd()
  const harness = await Harness.open(storage, {
    models: agent.models,
    registry,
    // Attribution names the app to providers that show it; without a url there is nothing to show.
    identity: { attribution: options.app.url ? { name: options.app.name, url: options.app.url } : null },
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd }),
    // A session without a profile selects the built-ins only: profiles' extensions are installed too, but are theirs.
    settings: () => ({ extensions: builtins }),
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
      const wasRunning = Boolean(entry.live?.run)
      entry.live = view.docs['pi.live'] as LiveState | undefined
      const last = view.entries.at(-1)
      // Activity is a new entry or a run starting, not every streamed chunk (which would churn the session list).
      // A message's own timestamp survives restarts.
      if (last?.id !== entry.lastEntryId) {
        entry.activeAt = (last?.model?.at(-1) as { timestamp?: number } | undefined)?.timestamp ?? Date.now()
      } else if (entry.live?.run && !wasRunning) entry.activeAt = Date.now()
      entry.lastEntryId = last?.id
      const agent = view.docs['pi.agent'] as { model?: { modelId?: string } } | undefined
      entry.model = agent?.model?.modelId
      entry.cost = costOf(view.docs['pi.usage'] as Parameters<typeof costOf>[0])
      changed()
    }
    absorb(watch.value)
    watch.start(async (call) => { if (call.kind === 'value') absorb(call.value) })
    mounted.set(key, entry)
    return entry
  }

  const info = (id: string, m: Mounted): SessionInfo => ({
    id, title: m.meta.title || 'New session', cwd: m.meta.cwd, createdAt: m.meta.createdAt,
    activeAt: Math.max(m.activeAt ?? 0, m.meta.createdAt),
    ...(m.model ? { model: m.model } : {}), ...(m.cost ? { cost: m.cost } : {}), ...(m.meta.model ? { ownModel: true } : {}),
    ...(m.meta.profile ? { profile: { name: m.meta.profile.name, scope: m.meta.profile.scope } } : {}),
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
  /** Every intent this daemon answers, its own and its extensions'. Reads and watches are plain methods. */
  const router = new Router<DaemonContext>()
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
      agent: (agentExtension) => installBuiltin(agentExtension),
      settings,
      action: (action) => { router.register({ ...action, id: named(extension.name, action.id), runs: 'machine' }) },
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

  // ── Profiles ────────────────────────────────────────────────────────────────────────────────────────────────────

  const profiles = new Map<string, LoadedProfile>()
  /** A profile as its files are now: loaded again (and its extensions reinstalled) when they changed. */
  async function profileOf(ref: ProfileRef): Promise<LoadedProfile> {
    const cached = profiles.get(ref.dir)
    if (cached && cached.hash === hashProfile(ref.dir)) return cached
    const loaded = await loadProfile(ref, userProfiles, trust)
    for (const old of cached?.extensions ?? []) if (!loaded.extensions.some((e) => e.name === old.name)) registry.uninstall(old)
    for (const extension of loaded.extensions) registry.install(extension)
    profiles.set(ref.dir, loaded)
    return loaded
  }

  /** What a turn runs with: the session's own choices, else its profile's, else this machine's settings. */
  async function agentOf(meta: SessionMeta) {
    const profile = meta.profile ? await profileOf(meta.profile) : undefined
    const { model, thinkingLevel } = agent.resolve({ model: meta.model ?? profile?.spec.model, thinking: meta.thinking ?? profile?.spec.thinking })
    if (!profile) return { model, thinkingLevel }
    const without = new Set(profile.spec.without ?? [])
    return {
      model, thinkingLevel,
      extensions: [...builtins.filter((e) => !without.has(e.name)), ...profile.extensions],
      instructions: profile.spec.prompt ?? null,
    }
  }

  /** Send `text` to a session, with the model and thinking it chose, else what this machine's settings say now. */
  async function submit(id: string, text: string, requestId: string, whenBusy?: 'steer' | 'followUp') {
    const m = await get(id)
    const { model, thinkingLevel, ...rest } = await agentOf(m.meta)
    if (!model) throw new RpcError('no_model', 'No model is available', { hint: 'Sign in to a provider in Settings.' })
    await m.conversation.configure({ model, thinkingLevel: thinkingLevel ?? null, ...rest }, context)
    if (!m.meta.title) await updateMeta(id, (meta) => { meta.title = titleOf(text) })
    const submission = await m.conversation.submit({ type: 'input', content: text, requestId, ...(whenBusy ? { whenBusy } : {}) }, context)
    return String(submission.id)
  }

  // ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const session = { session: true as const }
  router.register(defineAction({
    id: 'session.create', title: 'Start a session (no dialog)', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ cwd: opt(str()), title: opt(str()), model: opt(str()), thinking: opt(str()), prompt: opt(str()), profile: opt(str()) }),
    async run({ cwd, title, model: ownModel, thinking, prompt, profile: profileName }) {
      const dir = cwd?.trim() ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : defaultCwd
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new RpcError('invalid', `No folder ${dir} on ${machine.hostname}`)
      if (ownModel && !agent.catalog().models.some((m) => m.value === ownModel)) throw new RpcError('invalid', `No model ${ownModel} here; sign in to its provider first`)
      // The project's profile (or the user's) of that name, else the default one there is; checked (and allowed) now.
      const ref = findProfile(dir, userProfiles, profileName?.trim() || undefined)
      if (ref) await profileOf(ref)
      const meta: SessionMeta = {
        title: title?.trim() ?? '', cwd: dir, createdAt: Date.now(),
        ...(ownModel ? { model: ownModel } : {}), ...(thinking ? { thinking } : {}), ...(ref ? { profile: ref } : {}),
      }
      const { model, thinkingLevel } = await agentOf(meta)
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
      if (prompt?.trim()) await submit(String(conversation.id), prompt, randomUUID())
      return info(String(conversation.id), m)
    },
  }))
  router.register(defineAction({
    id: 'profile.list', title: 'List profiles', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ cwd: opt(str()) }),
    async run({ cwd }) {
      const dir = cwd?.trim() ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : defaultCwd
      return Promise.all(listProfiles(dir, userProfiles).map(async (ref) => {
        const hash = hashProfile(ref.dir)
        const description = profiles.get(ref.dir)?.spec.description
        return { ...ref, ...(description ? { description } : {}), allowed: await trust.allowed(ref, hash) }
      }))
    },
  }))
  router.register(defineAction({
    id: 'profile.allow', title: 'Allow a project profile to run', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ cwd: opt(str()), name: opt(str()) }),
    async run({ cwd, name }) {
      const dir = cwd?.trim() ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : defaultCwd
      const ref = findProfile(dir, userProfiles, name?.trim() || undefined)
      if (!ref) throw new RpcError('not_found', `No profile in ${dir}`)
      return { ...ref, hash: await trust.allow(ref) }
    },
  }))
  router.register(defineAction({
    id: 'session.submit', title: 'Send a message', runs: 'machine', expose: ['ui', 'cli'], ...session,
    params: obj({ id: str(), text: str({ minLength: 1 }), requestId: opt(str()), whenBusy: opt(union([lit('steer'), lit('followUp')])) }),
    run: async ({ id, text, requestId, whenBusy }) => ({ submission: await submit(id, text, requestId ?? randomUUID(), whenBusy) }),
  }))
  router.register(defineAction({
    id: 'session.abort', title: 'Stop the agent', runs: 'machine', expose: ['ui', 'cli'], ...session,
    params: obj({ id: str() }),
    async run({ id }) { await (await get(id)).conversation.abort(context); return null },
  }))
  router.register(defineAction({
    id: 'session.rename', title: 'Rename the session', runs: 'machine', expose: ['ui', 'cli'], ...session,
    params: obj({ id: str(), title: str({ minLength: 1 }) }),
    async run({ id, title }) { await updateMeta(id, (meta) => { meta.title = title }); return null },
  }))
  router.register(defineAction({
    id: 'session.seen', title: 'Mark as seen', runs: 'machine', expose: ['ui', 'cli'], ...session,
    params: obj({ id: str() }),
    async run({ id }) {
      const m = await get(id)
      const seen: NonNullable<SessionMeta['seen']> = {}
      if (m.lastEntryId !== undefined) seen.entryId = m.lastEntryId
      if (m.live?.runFailure) seen.failureTaskId = m.live.runFailure.taskId
      await updateMeta(id, (meta) => { meta.seen = seen })
      return null
    },
  }))
  router.register(defineAction({
    id: 'settings.set', title: 'Change a setting', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ key: str(), value: unknown() }),
    async run({ key, value }) { await settings.set(key, value as Json); return null },
  }))
  router.register(defineAction({
    id: 'auth.login', title: 'Sign in to a provider', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ provider: str(), type: union([lit('api_key'), lit('oauth')]), key: opt(str()) }),
    run({ provider, type, key }, ctx: DaemonContext) {
      const flow: string = agent.login(provider, type, key, (event) => ctx.notify('auth.event', { flow, event }))
      return { flow }
    },
  }))
  router.register(defineAction({
    id: 'auth.respond', title: 'Answer a sign-in step', runs: 'machine',
    params: obj({ flow: str(), prompt: str(), value: str() }),
    run({ flow, prompt, value }) { agent.respond(flow, prompt, value); return null },
  }))
  router.register(defineAction({
    id: 'auth.cancel', title: 'Cancel a sign-in', runs: 'machine',
    params: obj({ flow: str() }),
    run({ flow }) { agent.cancel(flow); return null },
  }))
  router.register(defineAction({
    id: 'auth.logout', title: 'Sign out of a provider', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ provider: str() }),
    async run({ provider }) { await agent.logout(provider); return null },
  }))
  router.register(defineAction({
    id: 'daemon.restart', title: 'Restart the background process', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ build: str(), interrupt: opt(bool()) }),
    run({ build, interrupt }) {
      if (build !== machine.build) throw new RpcError('changed', 'The running daemon changed. Check again.')
      if (restarting) throw new RpcError('restarting', 'Already restarting')
      // Decided synchronously from the mounted sessions, so no run can start between the check and the flag.
      const busy = [...mounted.values()].some((m) => m.live?.run)
      if (busy && !interrupt) return { restarted: false, busy }
      restarting = true
      setImmediate(() => options.onRestart?.())
      return { restarted: true, busy }
    },
  }))

  // Mount everything once so statuses (and anything a previous process left running) are live from the start.
  await list()
  harness.resume()


  return {
    machine,
    settings,
    serve(peer) {
      const subs = new Map<string, () => unknown>()
      const notify = <N extends keyof Notifications>(event: N, params: Notifications[N]) => peer.notify(event, params)
      let client = 'client'
      // Reads and watches; every intent is an action, served below under its id.
      const handlers: Record<string, (params: any) => unknown> = {
        async hello({ version, client: name }: Methods['hello']['params']) {
          if (version !== PROTOCOL_VERSION) {
            throw new RpcError('version_mismatch', `This machine's mu speaks protocol ${PROTOCOL_VERSION}, the client ${version}`, { hint: 'Update mu on the older side.' })
          }
          if (typeof name === 'string') client = name
          return { version: PROTOCOL_VERSION, features, machine, methods: [...Object.keys(handlers), ...router.list().map((a) => a.id)] }
        },
        'session.list': () => list(),
        'agent.models': async () => agent.catalog(),
        async 'session.watch'({ id }: { id: string }) {
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
        'settings.watch': serveSettings(settings, (params) => notify('settings.changed', params), subs)['settings.watch'],
        async 'value.watch'({ key }: { key: string }) {
          const entry = values.get(key)
          if (!entry) throw new RpcError('not_found', `No value ${key}`)
          const sub = randomUUID()
          const listener = (value: Json) => notify('value.changed', { sub, key, value })
          entry.listeners.add(listener)
          subs.set(sub, () => { entry.listeners.delete(listener) })
          return { sub, value: entry.value }
        },
        async unwatch({ sub }: { sub: string }) {
          const stop = subs.get(sub)
          subs.delete(sub)
          await stop?.()
          return null
        },
        /** Every action here, as data: id, title, params schema, who may run it. */
        'action.list': async () => router.list(),
        /** Run an action by id, as `exposure` (the command line passes `cli`); params may be strings to coerce. */
        'action.run': ({ id, params, exposure }: { id: string; params?: unknown; exposure?: Exposure }) =>
          router.dispatch(id, params, { notify, source: client }, { source: exposure ?? client, ...(exposure ? { exposure } : {}) }),
        /** The newest dispatches on this machine, oldest first. */
        'action.log': async () => router.log(),
      }
      const ctx: DaemonContext = { notify: (event, params) => notify(event as keyof Notifications, params as never), source: client }
      for (const action of router.list()) {
        handlers[action.id] = (params: unknown) => router.dispatch(action.id, params, { ...ctx, source: client }, { source: client })
      }
      connections.add(peer)
      for (const [method, handler] of Object.entries(handlers)) {
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
