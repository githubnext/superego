// The mu daemon: one per user per machine. It owns a pi-durable Harness on SQLite, the thread catalog, and every
// live subscription. Clients (the Electron app, the CLI, a remote app over ssh) speak the protocol in @mu/protocol.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, platform } from 'node:os'
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  type Conversation, type ConversationId, type ConversationView, createRegistry, defineDoc, defineExtension, defineTool, type Extension, Harness, hook,
  type LiveState, section, type Storage, wrapSection, wrapTool,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createCodingTools } from '@earendil-works/pi-durable/tools'
import {
  arr, bool, defineAction, deriveStatus, FEATURES, int, lit, nullable, num, obj, opt, type Pane, PROTOCOL_VERSION, Router, RpcError, str, union, unknown, type AppConfig, type Exposure, type Json, type MachineInfo, type Methods, type Notifications, type RpcPeer, type ThreadInfo,
} from '@mu/protocol'
import { serveSettings, SettingsRegistry, type SettingsStore } from '@mu/settings'
import { FileSettingsStore } from '@mu/settings/file'
import { createAgentSettings } from './agent-settings.ts'
import { defineDaemonExtension, type DaemonApi, type DaemonExtension, type LiveValue, type StatusContribution } from './extension.ts'
import { serveWeb, webToken, type WebServer } from './web.ts'
import { defineProfile, findProfile, hashProfile, isProfileDir, listProfiles, loadProfile, profileModule, provideSdk, Trust, type LoadedProfile, type ProfileRef } from './profiles.ts'

const context = BACKGROUND_CONTEXT

/** Which conversations are threads, newest last. Child conversations (subagents) are not listed here. */
const Catalog = defineDoc<{ ids: number[] }>({
  kind: 'mu.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true,
})

/** A thread's own metadata, next to its transcript. */
type ThreadMeta = {
  title: string; cwd: string; createdAt: number; seen?: { entryId?: number; failureTaskId?: number }
  /** The thread's own model and thinking; unset follows its profile, else this machine's settings. */
  model?: string; thinking?: string
  /** The profile it started with (see profiles.ts); unset runs plain mu. */
  profile?: ProfileRef
  /** Put away: left out of the thread list (and the sidebar) until unarchived. */
  archived?: boolean
  /** The panes open beside it, and the one in front. */
  panes?: Pane[]
  pane?: string
  /** Its session: the project folder it belongs to (a repository's main checkout, or where it started). */
  root?: string
  /** Its own git worktree: where, on which branch, and whether archiving removed it. */
  worktree?: { path: string; branch: string; removed?: boolean }
}
const ThreadDoc = defineDoc<ThreadMeta>({
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
  /** Where threads work when created without a cwd. */
  defaultCwd?: string
  /** The build of the code running, reported in `hello`. */
  build?: string
  /** Called once a restart was accepted and answered; the host closes the daemon and exits. */
  onRestart?: () => void
  /** The app's window build (index.html and assets), served to browsers when Web access is on. */
  webRoot?: string
}

/** One mounted thread: its conversation and a small watch that keeps its status current. */
type Mounted = {
  conversation: Conversation; meta: ThreadMeta; live?: LiveState; lastEntryId?: number
  /** What the thread runs with and has spent, and when anything last happened in it. */
  model?: string; cost?: number; activeAt?: number
  /** Its session, found from its folder, for a thread from before threads kept it. */
  root?: string
  stop(): Promise<unknown>
}

type Usage = { cost?: { total?: number } }
/** Everything a thread spent: every model's answers and every tool's own usage. */
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
 * A thread's title from its first message: the first sentence, up to 72 characters, cut at a word with an ellipsis
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

/** git in `cwd`: its output, trimmed; its own message when it fails. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, out, err) =>
    error ? fail(new Error(String(err).trim() || error.message)) : done(String(out).trim())))
}

/** The repository `dir` is in: its checkout's top, and the project it belongs to (the main checkout, for a worktree). */
async function checkoutOf(dir: string): Promise<{ top: string; root: string } | undefined> {
  const top = await git(dir, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  if (!top) return undefined
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')
  return { top, root: basename(common) === '.git' ? dirname(common) : top }
}

/** A branch- and folder-friendly name for a thread: "Fix the login flow" → "fix-the-login-flow". */
export function slugOf(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'thread'
}

/** `path` in `folder`, refusing anything that resolves outside it. */
function inFolder(folder: string, path: string) {
  const file = resolvePath(folder, path)
  if (file !== folder && !file.startsWith(folder.endsWith('/') ? folder : `${folder}/`)) throw new RpcError('invalid', `${path} is outside ${folder}`)
  return file
}

/** Folders a file search never enters: tools' and dependencies' own. */
const UNSEARCHED = new Set(['node_modules', '.git', '.obsidian', '.trash', '.mu', 'dist', 'out', 'build'])

/**
 * A file in `root` by the name a link gives it, as Obsidian resolves [[links]]: a path if it is one (with or without
 * `.md`), else the file of that name, a note's without its `.md`, the shortest path first. Relative to `root`.
 */
async function findFile(root: string, name: string): Promise<string | undefined> {
  const wanted = name.trim().replace(/^\/+/, '').toLowerCase()
  if (!wanted) return undefined
  const given = name.trim().replace(/^\/+/, '')
  for (const candidate of [given, `${given}.md`]) {
    const file = (() => { try { return inFolder(root, candidate) } catch { return undefined } })()
    if (file && await stat(file).then((s) => s.isFile(), () => false)) return candidate
  }
  const base = wanted.split('/').at(-1)!
  let best: string | undefined
  let seen = 0
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (++seen > 50_000) return
      if (entry.name.startsWith('.') || UNSEARCHED.has(entry.name)) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(dir, entry.name), path)
      else {
        const lower = entry.name.toLowerCase()
        if ((lower === base || lower === `${base}.md`) && (!best || path.length < best.length)) best = path
      }
    }
  }
  await walk(root, '')
  return best
}
export async function openDaemon(options: DaemonOptions): Promise<Daemon> {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const settings = new SettingsRegistry(options.settingsStore ?? new FileSettingsStore(join(options.dataDir, 'settings.json')))
  const agent = await createAgentSettings(settings, options.dataDir, options.app)
  const registry = createRegistry()
  /** What every thread has unless its profile does without: coding tools and the bundled extensions' agent parts. */
  const builtins: Extension[] = []
  const installBuiltin = (extension: Extension) => { registry.install(extension); builtins.push(extension) }
  installBuiltin(createCodingTools())
  // Panes: the agent opens them beside its thread (a diff, a preview, an artifact it wrote, a profile's own).
  installBuiltin(defineExtension({
    name: 'panes',
    tools: [defineTool({
      name: 'open_pane',
      description: 'Open a pane beside this conversation for the user to look at. Built-in kinds: "diff" (the changes in the working folder; no params), ' +
        '"preview" ({ url }: a web page, such as a local dev server), "artifact" ({ path }: an HTML file in the working folder, shown as a page; write it first), ' +
        '"editor" ({ path }: a file, for the user to read and edit), "thread" ({ thread }: another conversation). A profile may add kinds; its instructions name them.',
      parameters: obj({ kind: str({ minLength: 1 }), title: opt(str()), params: opt(obj({}, { open: true, description: 'What the pane shows, as an object: { "path": "notes/a.md" }, not a string of JSON.' })) }),
      async execute({ kind, title, params }, api) {
        const pane = await openPane(String(api.conversationId), { kind, ...(title ? { title } : {}), ...(params !== undefined ? { params: params as Json } : {}) })
        return { output: [{ type: 'text', text: `Opened the ${kind} pane (${pane.id}).` }] }
      },
    })],
  }))
  // Profiles and their extensions import from 'mu'; this is what they get.
  provideSdk({
    defineProfile, defineExtension, defineTool, section, hook, wrapTool, wrapSection, defineDaemonExtension, defineAction, RpcError,
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
    // A thread without a profile selects the built-ins only: profiles' extensions are installed too, but are theirs.
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
    if (!conversation) throw new RpcError('not_found', `No thread ${key}`)
    // A one-entry window is enough to know the newest entry and the live run.
    const watch = await conversation.watch(context, { min: 1, max: 2 })
    const entry: Mounted = {
      conversation,
      meta: (await harness.snapshot(ThreadDoc, id, context)) ?? { title: '', cwd: defaultCwd, createdAt: 0 },
      stop: () => watch.stop(),
    }
    if (!entry.meta.root) entry.root = (await checkoutOf(entry.meta.cwd).catch(() => undefined))?.root
    const absorb = (view: ConversationView) => {
      const wasRunning = Boolean(entry.live?.run)
      entry.live = view.docs['pi.live'] as LiveState | undefined
      const last = view.entries.at(-1)
      // Activity is a new entry or a run starting, not every streamed chunk (which would churn the thread list).
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

  const info = (id: string, m: Mounted): ThreadInfo => ({
    id, title: m.meta.title || 'New thread', cwd: m.meta.cwd, createdAt: m.meta.createdAt,
    activeAt: Math.max(m.activeAt ?? 0, m.meta.createdAt),
    ...(m.model ? { model: m.model } : {}), ...(m.cost ? { cost: m.cost } : {}), ...(m.meta.model ? { ownModel: true } : {}),
    ...(m.meta.profile ? { profile: m.meta.profile } : {}),
    ...(m.meta.panes?.length ? { panes: m.meta.panes, ...(m.meta.pane ? { pane: m.meta.pane } : {}) } : {}),
    session: { root: rootOf(m), name: basename(rootOf(m)) },
    ...(m.meta.worktree ? { worktree: m.meta.worktree } : {}),
    status: deriveStatus({ live: m.live, lastEntryId: lastAnswer(m), seen: m.meta.seen, ...blockedOf(id) }),
  })
  /** A thread's session: kept since it started; for older threads, found from its folder once (else the folder). */
  const rootOf = (m: Mounted) => m.meta.root ?? m.root ?? m.meta.cwd
  /** Only an assistant answer makes a thread "done"; the user's own message does not. */
  const lastAnswer = (m: Mounted) => m.live?.run ? undefined : m.lastEntryId

  /** The threads, newest first: the ones in use, or (`archived`) the ones put away. */
  async function list({ archived = false } = {}): Promise<ThreadInfo[]> {
    const catalog = await harness.snapshot(Catalog, context)
    const items: ThreadInfo[] = []
    for (const id of [...(catalog?.ids ?? [])].reverse()) {
      const m = await mount(id as ConversationId)
      if (Boolean(m.meta.archived) === archived) items.push(info(String(id), m))
    }
    return items
  }

  async function get(id: string) {
    const conversationId = Number(id) as ConversationId
    const catalog = await harness.snapshot(Catalog, context)
    if (!catalog?.ids.includes(conversationId)) throw new RpcError('not_found', `No thread ${id}`)
    return mount(conversationId)
  }

  async function updateMeta(id: string, edit: (meta: ThreadMeta) => void) {
    const m = await get(id)
    m.meta = await m.conversation.commit(async (tx) => {
      const meta = await tx.doc(ThreadDoc, m.conversation.id)
      edit(meta)
      return JSON.parse(JSON.stringify(meta)) as ThreadMeta
    }, context)
    changed()
  }

  // ── Extensions ──────────────────────────────────────────────────────────────────────────────────────────────────

  const connections = new Set<RpcPeer>()
  /** Every intent this daemon answers, its own and its extensions'. Reads and watches are plain methods. */
  const router = new Router<DaemonContext>()
  const values = new Map<string, { value: Json; listeners: Set<(value: Json) => void> }>()
  const contributors: ((threadId: string) => StatusContribution | undefined)[] = []
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

  /**
   * Set up a daemon extension: a bundled one (for the daemon's life), or a profile's (`agent` then adds to that
   * profile's selection, and the returned teardown removes its actions, values and status when the profile reloads).
   */
  async function setUp(extension: DaemonExtension, agentExtension: (extension: Extension) => void): Promise<() => void> {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw new Error(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    const undo: (() => void)[] = []
    const api: DaemonApi = {
      app: options.app,
      harness,
      agent: agentExtension,
      settings,
      action: (action) => { undo.push(router.register({ ...action, id: named(extension.name, action.id), runs: 'machine' })) },
      value<T extends Json>(key: string, initial: T): LiveValue<T> {
        const name = named(extension.name, key)
        const entry = { value: initial as Json, listeners: new Set<(value: Json) => void>() }
        values.set(name, entry)
        undo.push(() => { if (values.get(name) === entry) values.delete(name) })
        const set = (next: T) => {
          entry.value = next
          for (const listener of entry.listeners) listener(next)
        }
        return { get: () => entry.value as T, set, update: (edit) => set(edit(entry.value as T)) }
      },
      status: (contribute) => { contributors.push(contribute); undo.push(() => { contributors.splice(contributors.indexOf(contribute), 1) }) },
      invalidate: changed,
      threads: {
        list: () => list(),
        conversation: async (id) => (await get(id)).conversation,
        of: (conversationId) => mounted.has(String(conversationId)) ? String(conversationId) : undefined,
      },
    }
    try {
      const cleanup = await extension.setup(api)
      if (cleanup) undo.push(cleanup)
    } catch (error) {
      for (const step of undo.reverse()) step()
      throw new Error(`Extension ${extension.name} failed to start: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return () => { for (const step of undo.reverse()) step() }
  }
  for (const extension of options.extensions ?? []) cleanups.push(await setUp(extension, installBuiltin))
  const features = [...FEATURES, ...(options.extensions ?? []).map((extension) => `ext:${extension.name}`)]

  // ── Profiles ────────────────────────────────────────────────────────────────────────────────────────────────────

  const profiles = new Map<string, LoadedProfile>()
  const teardowns = new Map<string, () => void>()
  const loading = new Map<string, Promise<LoadedProfile>>()
  /** A profile as its files are now: loaded again (its extensions torn down and set up again) when they changed. */
  function profileOf(ref: ProfileRef): Promise<LoadedProfile> {
    const cached = profiles.get(ref.dir)
    const hash = hashProfile(ref.dir)
    if (cached && cached.hash === hash) return Promise.resolve(cached)
    const key = `${ref.dir}:${hash}`
    const pending = loading.get(key) ?? (async () => {
      const loaded = await loadProfile(ref, userProfiles, trust)
      teardowns.get(ref.dir)?.()
      teardowns.delete(ref.dir)
      profiles.delete(ref.dir)
      // Everything it sets up is undone together: when a later step fails too, so a fixed profile can load again.
      const undo: (() => void)[] = []
      try {
        for (const extension of loaded.daemon) {
          undo.push(await setUp(extension, (agentExtension) => {
            const scoped = { ...agentExtension, name: `${ref.scope}:${ref.name}/${agentExtension.name}` }
            loaded.extensions.push(scoped)
          }))
        }
        for (const extension of loaded.extensions) {
          registry.install(extension)
          undo.push(() => registry.uninstall(extension))
        }
      } catch (error) {
        for (const step of undo.reverse()) step()
        throw new RpcError('invalid', `Profile ${ref.name}: ${(error as Error).message}`)
      }
      teardowns.set(ref.dir, () => { for (const step of undo.reverse()) step() })
      profiles.set(ref.dir, loaded)
      return loaded
    })().finally(() => loading.delete(key))
    loading.set(key, pending)
    return pending
  }

  /** What a turn runs with: the thread's own choices, else its profile's, else this machine's settings. */
  async function agentOf(meta: ThreadMeta) {
    const profile = meta.profile ? await profileOf(meta.profile) : undefined
    const { model, thinkingLevel } = agent.resolve({ model: meta.model ?? profile?.spec.model, thinking: meta.thinking ?? profile?.spec.thinking })
    if (!profile) return { model, thinkingLevel }
    const without = new Set(profile.spec.without ?? [])
    return {
      model, thinkingLevel,
      extensions: [...builtins.filter((e) => !without.has(e.name)), ...profile.extensions],
      instructions: [profile.spec.prompt, profile.spec.panes && Object.keys(profile.spec.panes).length
        ? `Panes this profile adds, for open_pane:\n${Object.entries(profile.spec.panes).map(([kind, about]) => `- "${kind}": ${about}`).join('\n')}`
        : undefined].filter(Boolean).join('\n\n') || null,
    }
  }

  /** Send `text` to a thread, with the model and thinking it chose, else what this machine's settings say now. */
  async function submit(id: string, text: string, requestId: string, whenBusy?: 'steer' | 'followUp') {
    const m = await get(id)
    const { model, thinkingLevel, ...rest } = await agentOf(m.meta)
    if (!model) throw new RpcError('no_model', 'No model is available', { hint: 'Sign in to a provider in Settings.' })
    await m.conversation.configure({ model, thinkingLevel: thinkingLevel ?? null, ...rest }, context)
    if (!m.meta.title) await updateMeta(id, (meta) => { meta.title = titleOf(text) })
    const submission = await m.conversation.submit({ type: 'input', content: text, requestId, ...(whenBusy ? { whenBusy } : {}) }, context)
    return String(submission.id)
  }

  // ── Panes and files ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Open a pane beside thread `id`, or bring forward the same one already open. */
  async function openPane(id: string, pane: Omit<Pane, 'id'>): Promise<Pane> {
    await get(id)
    // Models sometimes send params as a string of JSON: take what it says.
    if (typeof pane.params === 'string') {
      try { pane = { ...pane, params: JSON.parse(pane.params) as Json } } catch { throw new RpcError('invalid', 'params must be an object') }
    }
    let opened: Pane | undefined
    await updateMeta(id, (meta) => {
      const same = (meta.panes ?? []).find((p) => p.kind === pane.kind && JSON.stringify(p.params ?? null) === JSON.stringify(pane.params ?? null))
      opened = same ?? { id: randomUUID().slice(0, 8), ...pane }
      if (!same) meta.panes = [...(meta.panes ?? []), opened]
      else if (pane.title) same.title = pane.title
      meta.pane = opened.id
      // A plain copy: what the transaction hands over is only valid inside it.
      opened = JSON.parse(JSON.stringify(opened)) as Pane
    })
    changed()
    return opened!
  }

  /** `path` inside `folder` (relative to it, or absolute within it); a path that leaves it is refused. */
  // ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const thread = { thread: true as const }
  router.register(defineAction({
    id: 'thread.create', title: 'Start a thread (no dialog)', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ cwd: opt(str()), title: opt(str()), model: opt(str()), thinking: opt(str()), prompt: opt(str()), profile: opt(str()), worktree: opt(bool()) }),
    async run({ cwd, title, model: ownModel, thinking, prompt, profile: profileName, worktree: wantsWorktree }) {
      const dir = cwd?.trim() ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : defaultCwd
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new RpcError('invalid', `No folder ${dir} on ${machine.hostname}`)
      if (ownModel && !agent.catalog().models.some((m) => m.value === ownModel)) throw new RpcError('invalid', `No model ${ownModel} here; sign in to its provider first`)
      // The project's profile (or the user's) of that name, else the default one there is; checked (and allowed) now.
      const ref = findProfile(dir, userProfiles, profileName?.trim() || undefined)
      const loaded = ref ? await profileOf(ref) : undefined
      // Its session is the project; in a repository it works in a worktree of its own, unless asked (or its profile
      // says) to work in place, or the repository can't make one yet (no commits).
      const checkout = await checkoutOf(dir)
      let workdir = dir
      let worktree: ThreadMeta['worktree']
      if (checkout && (wantsWorktree ?? loaded?.spec.worktree ?? true)) {
        const name = `${slugOf(title?.trim() || (prompt ? titleOf(prompt) : ''))}-${randomUUID().slice(0, 6)}`
        const path = join(options.dataDir, 'worktrees', basename(checkout.root), name)
        const branch = `mu/${name}`
        await mkdir(dirname(path), { recursive: true })
        const made = await git(checkout.top, ['worktree', 'add', '-q', '-b', branch, path, 'HEAD']).then(() => true, () => false)
        if (made) {
          // git gives real paths; so must the folder be, to find where in the checkout it is.
          const below = relative(checkout.top, await realpath(dir))
          workdir = below ? join(path, below) : path
          worktree = { path, branch }
        }
      }
      const meta: ThreadMeta = {
        title: title?.trim() ?? '', cwd: workdir, createdAt: Date.now(), root: checkout?.root ?? dir, ...(worktree ? { worktree } : {}),
        ...(ownModel ? { model: ownModel } : {}), ...(thinking ? { thinking } : {}), ...(ref ? { profile: ref } : {}),
      }
      const { model, thinkingLevel } = await agentOf(meta)
      const conversation = await harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), cwd: meta.cwd },
        init: async (tx, created) => {
          Object.assign(await tx.doc(ThreadDoc, created), meta)
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
    id: 'thread.submit', title: 'Send a message', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str(), text: str({ minLength: 1 }), requestId: opt(str()), whenBusy: opt(union([lit('steer'), lit('followUp')])) }),
    run: async ({ id, text, requestId, whenBusy }) => ({ submission: await submit(id, text, requestId ?? randomUUID(), whenBusy) }),
  }))
  router.register(defineAction({
    id: 'thread.abort', title: 'Stop the agent', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str() }),
    async run({ id }) { await (await get(id)).conversation.abort(context); return null },
  }))
  router.register(defineAction({
    id: 'thread.archive', title: 'Archive the thread', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str() }),
    async run({ id }) {
      const { meta } = await get(id)
      // Its worktree goes with it when nothing in it is uncommitted; its branch stays, to come back to.
      const tree = meta.worktree
      let removed = tree?.removed
      if (tree && !tree.removed) {
        const exists = await stat(tree.path).then(() => true, () => false)
        const clean = exists && (await git(tree.path, ['status', '--porcelain']).catch(() => 'unknown')) === ''
        if (!exists) removed = true
        else if (clean) removed = await git(meta.root ?? tree.path, ['worktree', 'remove', tree.path]).then(() => true, () => false)
      }
      await updateMeta(id, (m) => { m.archived = true; if (m.worktree && removed) m.worktree.removed = true })
      return { worktree: tree ? (removed ? 'removed' : 'kept') : null }
    },
  }))
  router.register(defineAction({
    id: 'thread.unarchive', title: 'Unarchive the thread', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str() }),
    async run({ id }) {
      const { meta } = await get(id)
      // Its worktree back, on the branch it left.
      const tree = meta.worktree
      if (tree?.removed && meta.root) {
        await mkdir(dirname(tree.path), { recursive: true })
        await git(meta.root, ['worktree', 'add', '-q', tree.path, tree.branch])
          .catch((error: Error) => { throw new RpcError('invalid', `Couldn't restore its worktree: ${error.message}`) })
      }
      await updateMeta(id, (m) => { delete m.archived; if (m.worktree) delete m.worktree.removed })
      return null
    },
  }))
  router.register(defineAction({
    id: 'pane.open', title: 'Open a pane', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str(), kind: str({ minLength: 1 }), title: opt(str()), params: opt(unknown()) }),
    run: ({ id, kind, title, params }) => openPane(id, { kind, ...(title ? { title } : {}), ...(params !== undefined ? { params: params as Json } : {}) }),
  }))
  router.register(defineAction({
    id: 'pane.update', title: 'Change what a pane shows', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str(), pane: str(), title: opt(str()), params: opt(unknown()) }),
    async run({ id, pane, title, params }) {
      await get(id)
      let found = false
      await updateMeta(id, (meta) => {
        const target = meta.panes?.find((p) => p.id === pane)
        if (!target) return
        found = true
        if (params !== undefined) target.params = (typeof params === 'string' ? JSON.parse(params) : params) as Json
        if (title !== undefined) target.title = title || undefined
        else delete target.title
      })
      if (!found) throw new RpcError('not_found', `No pane ${pane}`)
      return null
    },
  }))
  router.register(defineAction({
    id: 'pane.close', title: 'Close a pane', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str(), pane: str() }),
    async run({ id, pane }) {
      await get(id)
      await updateMeta(id, (meta) => {
        const index = (meta.panes ?? []).findIndex((p) => p.id === pane)
        if (index < 0) return
        meta.panes!.splice(index, 1)
        // The one beside it comes forward; none left, the thread.
        if (meta.pane === pane) meta.pane = meta.panes![Math.min(index, meta.panes!.length - 1)]?.id
        if (!meta.pane) delete meta.pane
        if (!meta.panes!.length) delete meta.panes
      })
      changed()
      return null
    },
  }))
  router.register(defineAction({
    id: 'pane.focus', title: 'Bring a pane to the front', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str(), pane: opt(str()) }),
    async run({ id, pane }) {
      await get(id)
      await updateMeta(id, (meta) => { if (pane && meta.panes?.some((p) => p.id === pane)) meta.pane = pane; else delete meta.pane })
      changed()
      return null
    },
  }))
  router.register(defineAction({
    id: 'file.write', title: 'Save a file', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str(), path: str({ minLength: 1 }), content: str() }),
    async run({ id, path, content }) {
      const file = inFolder((await get(id)).meta.cwd, path)
      await writeFile(file, content)
      return { path: file }
    },
  }))
  router.register(defineAction({
    id: 'thread.rename', title: 'Rename the thread', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str(), title: str({ minLength: 1 }) }),
    async run({ id, title }) { await updateMeta(id, (meta) => { meta.title = title }); return null },
  }))
  router.register(defineAction({
    id: 'thread.seen', title: 'Mark as seen', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str() }),
    async run({ id }) {
      const m = await get(id)
      const seen: NonNullable<ThreadMeta['seen']> = {}
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
      // Decided synchronously from the mounted threads, so no run can start between the check and the flag.
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


  const daemon: Daemon = {
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
        'thread.list': ({ archived }: { archived?: boolean } = {}) => list({ archived: Boolean(archived) }),
        'agent.models': async () => agent.catalog(),
        'file.read': async ({ id, path, base64 }: { id: string; path: string; base64?: boolean }) => {
          const file = inFolder((await get(id)).meta.cwd, path)
          const info = await stat(file).catch(() => undefined)
          if (!info?.isFile()) throw new RpcError('not_found', `No file ${path}`)
          if (info.size > 16 * 1024 * 1024) throw new RpcError('too_large', `${path} is larger than 16 MB`)
          return { path: file, content: await readFile(file, base64 ? 'base64' : 'utf8') }
        },
        'file.find': async ({ id, name }: { id: string; name: string }) => ({ path: await findFile((await get(id)).meta.cwd, name) ?? null }),
        'thread.diff': async ({ id }: { id: string }) => {
          const cwd = (await get(id)).meta.cwd
          const git = (args: string[]) => new Promise<string>((done, fail) => execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, out) => error ? fail(error) : done(out)))
          const repo = await git(['rev-parse', '--is-inside-work-tree']).then(() => true, () => false)
          if (!repo) return { diff: '', untracked: [], repo: false }
          const diff = await git(['diff', 'HEAD', '--no-color', '--no-ext-diff']).catch(() => git(['diff', '--no-color']))
          const untracked = (await git(['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)
          return { diff, untracked, repo: true }
        },
        // A profile's UI is its code too: served only for a real profile folder, and only once it is allowed.
        'profile.ui': async (ref: ProfileRef) => {
          if (!isProfileDir(ref, userProfiles)) throw new RpcError('not_found', `No profile at ${ref.dir}`)
          const loaded = await profileOf({ scope: ref.scope, name: ref.name, dir: ref.dir })
          return { hash: loaded.hash, entries: loaded.spec.ui ?? [] }
        },
        'profile.module': async ({ path, ...ref }: ProfileRef & { path: string }) => {
          if (!isProfileDir(ref, userProfiles)) throw new RpcError('not_found', `No profile at ${ref.dir}`)
          await profileOf({ scope: ref.scope, name: ref.name, dir: ref.dir })
          return profileModule(ref.dir, path)
        },
        async 'thread.watch'({ id }: { id: string }) {
          const m = await get(id)
          const watch = await m.conversation.watch(context)
          const sub = randomUUID()
          subs.set(sub, () => watch.stop())
          watch.start(async (call) => { if (call.kind === 'value') notify('watch.ops', { sub, ops: call.ops as unknown[] }) })
          void watch.closed.then((end) => { if (subs.delete(sub)) notify('watch.end', { sub, reason: end.kind }) })
          return { sub, value: watch.value }
        },
        async 'threads.watch'() {
          const sub = randomUUID()
          let last = ''
          const push = async () => {
            const value = await list()
            const json = JSON.stringify(value)
            if (json !== last) { last = json; notify('threads.changed', { sub, value }) }
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
      await web?.close()
      for (const cleanup of cleanups.reverse()) cleanup()
      agent.close()
      for (const m of mounted.values()) await m.stop()
      await harness.close(context)
    },
  }

  // ── Web access ──────────────────────────────────────────────────────────────────────────────────────────────────

  let web: WebServer | undefined
  let webKey = ''
  let webError: string | undefined
  /** Serve (or stop serving) browsers as the Web access settings say, whenever they change. */
  const applyWeb = async () => {
    const access = settings.get<string>('web.access') ?? 'off'
    const port = settings.get<number>('web.port') ?? 7777
    const key = access === 'off' || !options.webRoot ? '' : `${access}:${port}`
    if (key === webKey) return
    webKey = key
    await web?.close()
    web = undefined
    webError = undefined
    if (key) {
      try {
        web = await serveWeb({ root: options.webRoot!, host: access === 'network' ? '0.0.0.0' : '127.0.0.1', port, token: await webToken(options.dataDir), serve: daemon.serve,
          artifact: async (thread, path) => readFile(inFolder((await get(thread)).meta.cwd, path)) })
      } catch (error) {
        webError = (error as Error).message
      }
    }
    settings.invalidate()
  }
  settings.register({
    id: 'web', title: 'Web access', order: 80, ui: 'web',
    description: 'Use this machine from a browser or a phone: it serves the app and its threads.',
    settings: [
      { key: 'web.access', title: 'Serve the app', default: 'off', type: { type: 'choice', options: [
        { value: 'off', label: 'Off' }, { value: 'local', label: 'To this computer' }, { value: 'network', label: 'To the local network' },
      ] }, disabled: () => options.webRoot ? undefined : 'This daemon has no web app to serve.' },
      { key: 'web.port', title: 'Port', default: 7777, type: { type: 'number', min: 1024, max: 65535, step: 1 } },
    ],
    data: () => ({ url: web?.url ?? null, error: webError ?? null }),
  })
  settings.onChange(() => void applyWeb())
  await applyWeb()
  return daemon
}
