// The Superego daemon: one per user per machine. It owns a pi-durable Harness on SQLite, the thread catalog, and every
// live subscription. Clients (the Electron app, the CLI, a remote app over ssh) speak the protocol in @superego/protocol.
import { execFile } from 'node:child_process'
import { watch as watchFs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, platform } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  type Conversation, type ConversationId, type ConversationView, createRegistry, defineDoc, defineExtension, defineTool, type EntryId, type Extension, Harness, hook,
  type LiveState, section, type Storage, wrapSection, wrapTool,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createCodingTools } from '@earendil-works/pi-durable/tools'
import {
  agentName, arr, type Attachment, paramsParser, bool, defineAction, deriveStatus, FEATURES, int, lit, nullable, num, obj, opt, type Pane, PROTOCOL_VERSION, Router, RpcError, str, union, unknown, type AppConfig, type Exposure, type ExtensionAbout, type Json, type MachineInfo, type Methods, type NewThread, type Notifications, type RpcPeer, type ThreadInfo,
} from '@superego/protocol'
import { serveSettings, SettingsRegistry, withMovedKeys, type SettingsStore } from '@superego/settings'
import { FileSettingsStore } from '@superego/settings/file'
import { createAgentSettings } from './agent-settings.ts'
import { threadTools } from './thread-tools.ts'
import { describeProfile, registerExtensionSettings } from './extension-settings.ts'
import { defineDaemonExtension, type DaemonApi, type DaemonExtension, type LiveValue, type StatusContribution } from './extension.ts'
import { serveWeb, webToken, type WebServer } from './web.ts'
import { agentsInstructions, listSkills, mentionedSkills, skillBlock, skillsPrompt } from './skills.ts'
import { metaExtension, metaPrompt, type MachineDirectory } from './meta.ts'
import { defineProfile, findProfile, hashProfile, isProfileDir, listProfiles, loadProfile, profileModule, provideSdk, Trust, type LoadedProfile, type ProfileRef } from './profiles.ts'

const context = BACKGROUND_CONTEXT

/**
 * Which conversations are threads, newest last, and which one is Ego (see meta.ts): kept apart from the listed ones, so
 * no list shows it. Child conversations (subagents) are neither.
 */
const Catalog = defineDoc<{ ids: number[]; ego?: number }>({
  kind: 'superego.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true,
})

/** What Ego goes without, of what every thread has: it changes nothing itself, and starts threads its own way (see meta.ts). */
const EGO_WITHOUT = new Set(['coding-tools', 'thread-tools'])

/** Settings kept under another key now: a value stored under the old one is read as the new one's. */
const MOVED = {
  // The thread tools were "threads", the sidebar's name.
  'extensions.threads': 'extensions.thread-tools',
}

/** What a worktree being deleted is renamed with, between its name and a random suffix (see removeWorktree). */
const REMOVING = '.removing-'

/** A thread's own metadata, next to its transcript. */
type ThreadMeta = {
  title: string; cwd: string; createdAt: number; seen?: { entryId?: number; failureTaskId?: number }
  /** The thread's own model and thinking; unset follows its profile, else this machine's settings. */
  model?: string; thinking?: string
  /** The profile it started with (see profiles.ts); unset runs plain Superego. */
  profile?: ProfileRef
  /** Put away: left out of the thread list (and the sidebar) until unarchived. */
  archived?: boolean
  /** To be archived once its run ends: asked by the thread itself (thread_archive), mid-turn. */
  archiveWhenDone?: boolean
  /** The panes open beside it, and the one in front. */
  panes?: Pane[]
  pane?: string
  /** Its session: the project folder it belongs to (a repository's main checkout, or where it started). */
  root?: string
  /** Its own git worktree: where, on which branch, and whether archiving removed it. */
  worktree?: { path: string; branch: string; removed?: boolean }
  /** The machine's own agent, about Superego itself (see meta.ts). */
  meta?: boolean
  /** Where its transcript starts now: the entry after the reset that last cleared it (Ego's only). */
  cleared?: number
  /** The thread that started it (by thread_start, or thread.create's `parent`). */
  parent?: string
}
const ThreadDoc = defineDoc<ThreadMeta>({
  kind: 'superego.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current',
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
  /** Called once a restart was accepted and answered, with what to add to the successor's environment; the host closes the daemon and exits. */
  onRestart?: (env: Record<string, string>) => void
  /** The app's window build (index.html and assets), served to browsers when Web access is on. */
  webRoot?: string
  /** The folder agents share: skills in `skills/`, standing instructions in `AGENTS.md`. Defaults to `~/.agents`. */
  agentsDir?: string
  /** The machines this computer reaches, as the app keeps them: for the meta agent to set them up. */
  machines?: () => MachineDirectory
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

/** Attachments: what one may weigh, and how small a text file is to be shown to the model whole. */
const ATTACHMENT_LIMIT = 20 * 1024 * 1024
const INLINE_LIMIT = 100 * 1024
const ATTACHMENT = obj({ name: str({ minLength: 1 }), mimeType: str(), data: str() })
/** Images the models take as images. */
const IMAGE = /^image\/(png|jpeg|gif|webp)$/
const isText = (mimeType: string, name: string) =>
  /^text\/|json|xml|javascript|typescript|yaml|toml|csv|markdown|x-sh/.test(mimeType)
    || /\.(md|markdown|txt|ts|tsx|js|jsx|mjs|json|css|html|py|rs|go|rb|swift|kt|java|c|h|cpp|yml|yaml|toml|csv|log|sh|sql|ini|env)$/i.test(name)

/** Folders a file search never enters: tools' and dependencies' own. */
const UNSEARCHED = new Set(['node_modules', '.git', '.obsidian', '.trash', '.superego', 'dist', 'out', 'build'])

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
/**
 * What a path in a message points at, in a thread's folder `root`: a file (by `findFile`), a folder, and a line when it
 * names one (`src/a.ts:12`, `src/a.ts#L12`). Absolute and `~` paths count when they're in the folder; `outside` when not.
 */
export async function locate(root: string, name: string): Promise<{ path: string | null; folder?: boolean; line?: number; outside?: boolean }> {
  let given = name.trim()
  let line: number | undefined
  const at = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(given)
  if (at) { given = at[1]!; line = Number(at[2] ?? at[3]) }
  if (given === '~' || given.startsWith('~/')) given = join(homedir(), given.slice(1))
  if (isAbsolute(given)) {
    const inside = relative(root, given)
    if (inside.startsWith('..') || isAbsolute(inside)) return { path: null, outside: true }
    given = inside
  }
  const folder = await (async () => { try { return (await stat(inFolder(root, given || '.'))).isDirectory() } catch { return false } })()
  if (folder) return { path: given.replace(/\/+$/, ''), folder: true }
  const path = await findFile(root, given)
  return path ? { path, ...(line ? { line } : {}) } : { path: null }
}

export async function openDaemon(options: DaemonOptions): Promise<Daemon> {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const settings = new SettingsRegistry(withMovedKeys(options.settingsStore ?? new FileSettingsStore(join(options.dataDir, 'settings.json')), MOVED))
  const agent = await createAgentSettings(settings, options.dataDir, options.app)
  const registry = createRegistry()
  /**
   * The agent parts every thread has unless it goes without the extension that gave them (see `withoutOf`): the core's
   * own and the bundled extensions', each with its extension (one may give several).
   */
  const builtins: { part: Extension; owner: string }[] = []
  const installBuiltin = (part: Extension, owner: string) => {
    const entry = { part, owner }
    registry.install(part)
    builtins.push(entry)
    return () => { registry.uninstall(part); builtins.splice(builtins.indexOf(entry), 1) }
  }
  /** Every extension set up for the daemon's life, the core's own and the bundled ones, by name: what can be gone without. */
  const extensions = new Map<string, ExtensionAbout>()
  /**
   * The optional extensions a thread goes without: turned off on this machine, left out by its profile, or (Ego) not
   * for its kind. One answer for its agent's parts, the pane kinds it's told of, and the UI the window draws for it.
   */
  function withoutOf(meta?: ThreadMeta, profile?: LoadedProfile): Set<string> {
    const without = new Set<string>()
    for (const { name, required } of extensions.values()) {
      if (required) continue
      if (settings.get(`extensions.${name}`) === false || profile?.spec.without?.includes(name) || (meta?.meta && EGO_WITHOUT.has(name))) without.add(name)
    }
    return without
  }
  /** The agent parts a thread has: every built-in but those of the extensions it goes without. */
  const partsFor = (without: Set<string>) => builtins.filter((b) => !without.has(b.owner)).map((b) => b.part)
  /**
   * The kinds of pane the agent can open, and what each shows: the core's, and those extensions describe (the window
   * draws them; the extension's UI half registers the same kind). A profile's extension's are for that profile's threads
   * only (`profile`: its folder).
   */
  const paneKinds: { kind: string; about: string; owner: string; profile?: string }[] = [
    { kind: 'diff', about: 'the changes in the working folder; no params', owner: 'panes' },
    { kind: 'preview', about: '{ url }: a web page, such as a local dev server', owner: 'panes' },
    { kind: 'artifact', about: '{ path }: an HTML file in the working folder, shown as a page; write it first', owner: 'panes' },
    { kind: 'editor', about: '{ path }: a file, for the user to read and edit', owner: 'panes' },
    { kind: 'thread', about: '{ thread }: another conversation', owner: 'panes' },
  ]
  // Panes: the agent opens them beside its thread (a diff, a preview, an artifact it wrote, a profile's own), from the
  // kinds its instructions list.
  const panesPart = defineExtension({
    name: 'panes',
    tools: [defineTool({
      name: 'open_pane',
      description: 'Open a pane beside this conversation for the user to look at. The kinds there are, and the params each takes, are listed in your instructions under panes.',
      parameters: obj({ kind: str({ minLength: 1 }), title: opt(str()), params: opt(obj({}, { open: true, description: 'What the pane shows, as an object: { "path": "notes/a.md" }, not a string of JSON.' })) }),
      async execute({ kind, title, params }, api) {
        const pane = await openPane(String(api.conversationId), { kind, ...(title ? { title } : {}), ...(params !== undefined ? { params: params as Json } : {}) })
        return { output: [{ type: 'text', text: `Opened the ${kind} pane (${pane.id}).` }] }
      },
    })],
    sections: [section('panes', ({ conversationId }) => {
      const kinds = panesOf(String(conversationId))
      return `Panes you can open beside this conversation with open_pane, by kind:\n${kinds.map(({ kind, about }) => `- "${kind}": ${about}`).join('\n')}`
    })],
  })
  /** The pane kinds a thread's agent is told of: the core's and those of extensions it has, and its profile's. */
  function panesOf(id: string) {
    const meta = mounted.get(id)?.meta
    const profile = meta?.profile && profiles.get(meta.profile.dir)
    const without = withoutOf(meta, profile)
    const declared = Object.entries(profile?.spec.panes ?? {}).map(([kind, about]) => ({ kind, about }))
    return [...paneKinds.filter((p) => !without.has(p.owner) && (!p.profile || p.profile === meta?.profile?.dir)), ...declared]
  }
  // Skills and standing instructions from the folder agents share (see skills.ts). Each is its own extension, so a
  // profile can do without either.
  const agentsDir = options.agentsDir ?? join(homedir(), '.agents')
  const skillsDir = join(agentsDir, 'skills')
  // Threads starting, reading, messaging and archiving threads (see thread-tools.ts).
  const threadInfo = async (id: string) => { const m = await get(id).catch(() => undefined); return m && info(id, m) }
  /**
   * The core's own agent parts, as extensions like any other: each optional, so a machine can turn it off and a profile
   * can do without it. Set up first, through the same API as the bundled ones.
   */
  const core: DaemonExtension[] = [
    { name: 'coding-tools', title: 'Coding tools', description: 'Read, write and edit files, and run commands.', setup: (s) => s.agent(createCodingTools()) },
    { name: 'panes', title: 'Panes', description: 'Open panes beside a thread: diffs, previews, files.', setup: (s) => s.agent(panesPart) },
    {
      name: 'skills', title: 'Skills', description: 'Know the shared skills, and use them when they fit.',
      setup: (s) => s.agent(defineExtension({ name: 'skills', sections: [section('skills', async () => skillsPrompt(await listSkills(skillsDir)))] })),
    },
    {
      name: 'agents-md', title: 'AGENTS.md', description: 'Follow the standing instructions in AGENTS.md files.',
      setup: (s) => s.agent(defineExtension({ name: 'agents-md', sections: [section('agents_md', async ({ env }) => agentsInstructions(agentsDir, env?.cwd))] })),
    },
    {
      name: 'thread-tools', title: 'Thread tools', description: 'Start threads of their own, read, message and archive others.',
      setup: (s) => s.agent(threadTools({
        info: threadInfo,
        list: () => list(),
        start: (parent, params) => startThread({ ...params, parent }),
        send: async (id, text) => { await submit(id, text, randomUUID(), 'followUp') },
        answer: (id) => answerOf(id),
        archive,
        archiveWhenDone,
      })),
    },
  ]
  /** A thread's last answer, as text. */
  async function answerOf(id: string) {
    const page = await (await get(id)).conversation.entries({ order: 'descending' }, 50, undefined, context)
    for (const entry of page.items) {
      const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
      const said = (message.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim()
      if (said) return said
    }
    return undefined
  }
  // Profiles and their extensions import from 'superego'; this is what they get.
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
    settings: () => ({ extensions: partsFor(withoutOf()) }),
  }, context)

  const machine: MachineInfo = {
    id: await machineId(options.dataDir), hostname: hostname(), platform: platform(), pid: process.pid, dataDir: options.dataDir,
    build: options.build ?? 'dev',
  }
  /** Set once a restart is accepted: no new work starts, so nothing is cut off that wasn't agreed to. */
  let restarting = false
  const mounted = new Map<string, Mounted>()
  /** The threads being archived now that their run ended (see archiveWhenDone). */
  const archiving = new Set<string>()
  /** Ego's thread, once there is one (the catalog's `ego`). */
  let egoId: string | undefined
  /** The transcript watches open on each thread, to end when Ego is cleared (clients then watch again). */
  const transcriptWatches = new Map<string, Set<() => unknown>>()
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
    watch.start(async (call) => { if (call.kind === 'value') { absorb(call.value); archiveIfDone(key, entry) } })
    mounted.set(key, entry)
    archiveIfDone(key, entry)
    return entry
  }

  const info = (id: string, m: Mounted): ThreadInfo => ({
    id, title: m.meta.title || 'New thread', cwd: m.meta.cwd, createdAt: m.meta.createdAt,
    activeAt: Math.max(m.activeAt ?? 0, m.meta.createdAt),
    ...(m.model ? { model: m.model } : {}), ...(m.cost ? { cost: m.cost } : {}), ...(m.meta.model ? { ownModel: true } : {}),
    ...(m.meta.model || m.meta.thinking ? { chosen: { ...(m.meta.model ? { model: m.meta.model } : {}), ...(m.meta.thinking ? { thinking: m.meta.thinking } : {}) } } : {}),
    ...(m.meta.profile ? { profile: m.meta.profile } : {}),
    ...(m.meta.panes?.length ? { panes: m.meta.panes, ...(m.meta.pane ? { pane: m.meta.pane } : {}) } : {}),
    session: { root: rootOf(m), name: id === egoId ? options.app.name : basename(rootOf(m)) },
    ...(m.meta.worktree ? { worktree: m.meta.worktree } : {}),
    ...(m.meta.archived ? { archived: true } : {}),
    ...(id === egoId ? { meta: true } : {}),
    ...(m.meta.parent ? { parent: m.meta.parent } : {}),
    ...withoutInfo(m.meta),
    status: deriveStatus({ live: m.live, lastEntryId: lastAnswer(m), seen: m.meta.seen, ...blockedOf(id) }),
  })
  /** What a thread goes without, for clients: by its profile once loaded (until then, by this machine's settings). */
  const withoutInfo = (meta: ThreadMeta) => {
    const without = [...withoutOf(meta, meta.profile && profiles.get(meta.profile.dir))].sort()
    return without.length ? { without } : {}
  }
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

  /** A thread by id: a listed one, or Ego. */
  async function get(id: string) {
    const conversationId = Number(id) as ConversationId
    const catalog = await harness.snapshot(Catalog, context)
    if (id !== egoId && !catalog?.ids.includes(conversationId)) throw new RpcError('not_found', `No thread ${id}`)
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
  // Ego's tools: selected for its thread only (see agentOf), so installed but not a built-in. The threads it starts are
  // top-level, not its children (startThread).
  const metaAgent = metaExtension({
    dir: options.dataDir, router, snapshot: () => settings.snapshot(), ...(options.machines ? { machines: options.machines } : {}),
    threads: { info: threadInfo, list: () => list(), answer: (id) => answerOf(id), start: (params) => startThread(params) },
  })
  registry.install(metaAgent)
  /**
   * Live values by name. A name is watched, not a value: a watch on one no extension has set up yet (a profile's, before
   * the profile loads) waits on null, and takes the value when it comes. `owned` while an extension publishes it.
   */
  const values = new Map<string, { value: Json; owned: boolean; listeners: Set<(value: Json) => void> }>()
  const valueOf = (name: string) => {
    let entry = values.get(name)
    if (!entry) values.set(name, entry = { value: null, owned: false, listeners: new Set() })
    return entry
  }
  /** Forget a value nobody publishes or watches. */
  const prune = (name: string) => {
    const entry = values.get(name)
    if (entry && !entry.owned && !entry.listeners.size) values.delete(name)
  }
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
  /** Extensions' read methods, `<name>.<method>`: plain requests, looked up when called (a profile's come and go). */
  const methods = new Map<string, (params: unknown) => Promise<Json>>()
  /**
   * The names in use: an extension's name is the prefix of everything it registers, so it's claimed while the extension
   * is set up, and a second extension of that name (bundled or a profile's) is refused rather than mixed in.
   */
  const claimed = new Set<string>()
  /** Names announced as `ext:<name>`: the extensions set up now, bundled and profiles' alike. */
  const announced = new Set<string>()

  /**
   * Set up a daemon extension: a bundled one (for the daemon's life), or a profile's (`agent` then adds to that
   * profile's selection). Everything it registers is its own, and the returned teardown undoes all of it: its agent
   * parts, actions, values, status, settings and its name.
   */
  async function setUp(extension: DaemonExtension, agentExtension: (extension: Extension) => () => void, profile?: ProfileRef): Promise<() => void> {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw new Error(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    if (claimed.has(extension.name)) throw new Error(`An extension named ${extension.name} is already set up`)
    claimed.add(extension.name)
    announced.add(extension.name)
    const undo: (() => void)[] = [() => { claimed.delete(extension.name); announced.delete(extension.name) }]
    const ownKey = (key: string) => {
      if (key !== extension.name && !key.startsWith(`${extension.name}.`)) throw new Error(`Extension ${extension.name} must name its settings "${extension.name}.<key>", not "${key}"`)
    }
    const api: DaemonApi = {
      app: options.app,
      harness,
      agent: (agentPart) => { undo.push(agentExtension(agentPart)) },
      settings: {
        register(section) {
          ownKey(section.id)
          for (const setting of section.settings) ownKey(setting.key)
          undo.push(settings.register(section))
        },
        get: (key) => settings.get(key),
        onChange: (listener) => { undo.push(settings.onChange(listener)) },
      },
      action: (action) => { undo.push(router.register({ ...action, id: named(extension.name, action.id), runs: 'machine' })) },
      method(name, run, options = {}) {
        const id = named(extension.name, name)
        if (methods.has(id) || router.has(id)) throw new Error(`Method ${id} is already defined`)
        const parse = paramsParser(id, options.params)
        methods.set(id, async (params: unknown) => run(parse(params) as never))
        undo.push(() => { methods.delete(id) })
      },
      pane(kind, about) {
        if (paneKinds.some((p) => p.kind === kind && p.profile === profile?.dir)) throw new Error(`Pane kind ${kind} is already described`)
        const entry = { kind, about, owner: extension.name, ...(profile ? { profile: profile.dir } : {}) }
        paneKinds.push(entry)
        undo.push(() => { paneKinds.splice(paneKinds.indexOf(entry), 1) })
      },
      value<T extends Json>(key: string, initial: T): LiveValue<T> {
        const name = named(extension.name, key)
        const entry = valueOf(name)
        if (entry.owned) throw new Error(`Value ${name} is already published`)
        entry.owned = true
        undo.push(() => { entry.owned = false; prune(name) })
        const set = (next: T) => {
          entry.value = next
          for (const listener of entry.listeners) listener(next)
        }
        set(initial)
        return { get: () => entry.value as T, set, update: (edit) => set(edit(entry.value as T)) }
      },
      status: (contribute) => { contributors.push(contribute); undo.push(() => { contributors.splice(contributors.indexOf(contribute), 1) }) },
      invalidate: changed,
      threads: {
        list: () => list(),
        get: async (id) => info(id, await get(id)),
        conversation: async (id) => (await get(id)).conversation,
        of: (conversationId) => mounted.has(String(conversationId)) ? String(conversationId) : undefined,
        attachments: attachmentsOf,
      },
    }
    const teardown = () => { for (const step of undo.splice(0).reverse()) step() }
    try {
      const cleanup = await extension.setup?.(api)
      if (cleanup) undo.push(cleanup)
    } catch (error) {
      teardown()
      throw new Error(`Extension ${extension.name} failed to start: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return teardown
  }
  // The core's own, then the bundled ones: for the daemon's life, each giving every thread its agent parts unless the
  // thread goes without it.
  for (const extension of [...core, ...options.extensions ?? []]) {
    cleanups.push(await setUp(extension, (part) => installBuiltin(part, extension.name)))
    const { name, title, description, required } = extension
    extensions.set(name, { name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(required ? { required } : {}) })
  }
  registerExtensionSettings(settings, [...extensions.values()])
  // Turning one off changes what threads go without, which clients are told.
  settings.onChange(changed)
  /** What this daemon offers, as `hello` says: the protocol's features, and every extension set up now. */
  const features = () => [...FEATURES, ...[...announced].map((name) => `ext:${name}`)]

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
            return () => { loaded.extensions.splice(loaded.extensions.indexOf(scoped), 1) }
          }, ref))
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
      // What its threads go without may have changed with it.
      changed()
      for (const name of loaded.spec.without ?? []) {
        const known = extensions.get(name)
        if (!known) console.warn(`Profile ${ref.name}: without ${name}, which isn't an extension here`)
        else if (known.required) console.warn(`Profile ${ref.name}: ${name} is required, and can't be done without`)
      }
      return loaded
    })().finally(() => loading.delete(key))
    loading.set(key, pending)
    return pending
  }

  /** What a turn runs with: the thread's own choices, else its profile's, else this machine's settings. */
  async function agentOf(meta: ThreadMeta) {
    const profile = meta.profile ? await profileOf(meta.profile) : undefined
    const { model, thinkingLevel } = agent.resolve({ model: meta.model ?? profile?.spec.model, thinking: meta.thinking ?? profile?.spec.thinking })
    const parts = partsFor(withoutOf(meta, profile))
    // Ego: what Superego is, and its own tools, which only read and start threads, instead of the coding tools and
    // the threads' own (it goes without those, see EGO_WITHOUT).
    if (meta.meta) {
      return {
        model, thinkingLevel, extensions: [...parts, metaAgent],
        instructions: metaPrompt({ name: options.app.name, agent: options.app.agent, id: options.app.id, dataDir: options.dataDir, agentsDir, hostname: machine.hostname }),
      }
    }
    if (!profile) return { model, thinkingLevel, extensions: parts }
    return { model, thinkingLevel, extensions: [...parts, ...profile.extensions], instructions: profile.spec.prompt || null }
  }

  /** Send `text` to a thread, with the model and thinking it chose, else what this machine's settings say now. */
  async function submit(id: string, text: string, requestId: string, whenBusy?: 'steer' | 'followUp', attachments: Attachment[] = []) {
    if (!text.trim() && !attachments.length) throw new RpcError('invalid', 'Nothing to send')
    const m = await get(id)
    // Put away: it can be read, not written to, until it's brought back.
    if (m.meta.archived) throw new RpcError('archived', 'This thread is archived', { hint: 'Unarchive it to send to it.' })
    const { model, thinkingLevel, ...rest } = await agentOf(m.meta)
    if (!model) throw new RpcError('no_model', 'No model is available', { hint: 'Sign in to a provider in Settings.' })
    await m.conversation.configure({ model, thinkingLevel: thinkingLevel ?? null, ...rest }, context)
    if (!m.meta.title) await updateMeta(id, (meta) => { meta.title = titleOf(text.trim() || attachments.map((a) => a.name).join(', ')) })
    const content = await withSkills(m.meta, text, await contentOf(id, text, attachments))
    const submission = await m.conversation.submit({ type: 'input', content, requestId, ...(whenBusy ? { whenBusy } : {}) }, context)
    return String(submission.id)
  }

  /**
   * A message that names skills (`$commit`, `/skill:commit`) carries their instructions after its own content, when the
   * thread's profile hasn't done without skills.
   */
  async function withSkills(meta: ThreadMeta, text: string, content: Awaited<ReturnType<typeof contentOf>>) {
    if (!/[$/]/.test(text)) return content
    const profile = meta.profile ? await profileOf(meta.profile) : undefined
    if (withoutOf(meta, profile).has('skills')) return content
    const named = mentionedSkills(text, await listSkills(skillsDir))
    if (!named.length) return content
    const blocks = typeof content === 'string' ? (content ? [{ type: 'text' as const, text: content }] : []) : content
    for (const skill of named) blocks.push({ type: 'text', text: await skillBlock(skill) })
    return blocks
  }

  /**
   * A message's content with its attachments: each file saved under attachments/<thread>/ on this machine and named to
   * the agent by its path (a small text file inline too), images also given to the model as images.
   */
  /** Where a thread's files are kept on this machine: its attachments, and the images it showed. */
  function attachmentsOf(id: string) { return join(options.dataDir, 'attachments', id) }

  async function contentOf(id: string, text: string, attachments: Attachment[]) {
    if (!attachments.length) return text
    const dir = attachmentsOf(id)
    await mkdir(dir, { recursive: true })
    const blocks: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = []
    if (text.trim()) blocks.push({ type: 'text', text })
    for (const attachment of attachments) {
      const bytes = Buffer.from(attachment.data, 'base64')
      if (bytes.length > ATTACHMENT_LIMIT) throw new RpcError('too_large', `${attachment.name} is larger than ${ATTACHMENT_LIMIT / 1024 / 1024} MB`)
      const name = basename(attachment.name.replace(/\\/g, '/')).replace(/^\.+/, '') || 'attachment'
      const dot = name.lastIndexOf('.')
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
      let path = join(dir, name)
      for (let n = 2; await stat(path).then(() => true, () => false); n++) path = join(dir, `${stem}-${n}${ext}`)
      await writeFile(path, bytes)
      const quote = (value: string) => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)
      const tag = `<attachment name="${quote(name)}" type="${quote(attachment.mimeType)}" path="${quote(path)}"`
      if (IMAGE.test(attachment.mimeType)) {
        blocks.push({ type: 'text', text: `${tag} />` }, { type: 'image', data: attachment.data, mimeType: attachment.mimeType })
      } else if (bytes.length <= INLINE_LIMIT && isText(attachment.mimeType, name)) {
        blocks.push({ type: 'text', text: `${tag}>\n${bytes.toString('utf8')}\n</attachment>` })
      } else blocks.push({ type: 'text', text: `${tag} />` })
    }
    return blocks
  }

  // ── Panes and files ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Open a pane beside thread `id` (or find the same one already open). Opening isn't focusing: the agent's pane opens
   * beside, and the focus stays where it is. A window that asked for one moves its focus into it, which brings it
   * forward (pane.focus): the focus is in one place, the prompt or the pane.
   */
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
    params: obj({ cwd: opt(str()), title: opt(str()), model: opt(str()), thinking: opt(str()), prompt: opt(str()), attachments: opt(arr(ATTACHMENT)), profile: opt(str()), worktree: opt(bool()), parent: opt(str()) }),
    run: (params) => startThread(params),
  }))
  /** A new thread as asked for: where, with what, in a worktree or not; a child of `parent` when a thread starts it. */
  async function startThread({ cwd, title, model: ownModel, thinking, prompt, attachments, profile: profileName, worktree: wantsWorktree, parent }: NewThread) {
    const dir = cwd?.trim() ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : defaultCwd
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new RpcError('invalid', `No folder ${dir} on ${machine.hostname}`)
    if (ownModel && !agent.catalog().models.some((m) => m.value === ownModel)) throw new RpcError('invalid', `No model ${ownModel} here; sign in to its provider first`)
    // Ego hands work to threads of their own: top-level in their project, not hidden under it.
    if (parent === egoId) parent = undefined
    if (parent) await get(parent)
    // The project's profile (or the user's) of that name, else the default one there is; checked (and allowed) now.
    const ref = findProfile(dir, userProfiles, profileName?.trim() || undefined)
    const loaded = ref ? await profileOf(ref) : undefined
    // Its session is the project. It works in the folder given, or, asked to (or its profile says so), in a worktree
    // of its own: in a repository that has a commit to start from.
    const checkout = await checkoutOf(dir)
    let workdir = dir
    let worktree: ThreadMeta['worktree']
    if (checkout && (wantsWorktree ?? loaded?.spec.worktree ?? false)) {
      const name = `${slugOf(title?.trim() || (prompt ? titleOf(prompt) : ''))}-${randomUUID().slice(0, 6)}`
      const path = join(options.dataDir, 'worktrees', basename(checkout.root), name)
      const branch = `${options.app.id}/${name}`
      await mkdir(dirname(path), { recursive: true })
      const made = await git(checkout.top, ['worktree', 'add', '-q', '-b', branch, path, 'HEAD']).then(() => true, () => false)
      if (made) {
        // git gives real paths; so must the folder be, to find where in the checkout it is.
        const below = relative(checkout.top, await realpath(dir))
        workdir = below ? join(path, below) : path
        worktree = { path, branch }
      }
    }
    return createThread({
      title: title?.trim() ?? '', cwd: workdir, createdAt: Date.now(), root: checkout?.root ?? dir, ...(worktree ? { worktree } : {}),
      ...(ownModel ? { model: ownModel } : {}), ...(thinking ? { thinking } : {}), ...(ref ? { profile: ref } : {}), ...(parent ? { parent } : {}),
    }, prompt, attachments)
  }
  /** A new thread with `meta`, and its first message when there is one. */
  async function createThread(meta: ThreadMeta, prompt?: string, attachments?: Attachment[]) {
    const { model, thinkingLevel } = await agentOf(meta)
    const conversation = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), cwd: meta.cwd },
      init: async (tx, created) => {
        Object.assign(await tx.doc(ThreadDoc, created), meta)
        const catalog = await tx.doc(Catalog)
        if (meta.meta) catalog.ego = created
        else catalog.ids.push(created)
      },
    }, context)
    if (meta.meta) egoId = String(conversation.id)
    const m = await mount(conversation.id)
    changed()
    if (prompt?.trim() || attachments?.length) await submit(String(conversation.id), prompt ?? '', randomUUID(), undefined, attachments)
    return info(String(conversation.id), m)
  }
  /** Ego's thread: the one the catalog names, else a new one in the app's data folder (made once, however many ask). */
  let egoStarting: Promise<string> | undefined
  function ego(): Promise<string> {
    if (egoId) return Promise.resolve(egoId)
    egoStarting ??= createThread({ title: agentName(options.app), cwd: options.dataDir, root: options.dataDir, createdAt: Date.now(), meta: true })
      .then((thread) => thread.id).finally(() => { egoStarting = undefined })
    return egoStarting
  }
  /**
   * Ego from before it was kept apart: the meta threads among the listed ones. One becomes Ego (the newest in use,
   * else the newest) unless there is one already; all leave the list, so there is only ever the one.
   */
  async function adoptEgo() {
    const catalog = await harness.snapshot(Catalog, context)
    if (catalog?.ego !== undefined) egoId = String(catalog.ego)
    const old: { id: number; m: Mounted }[] = []
    for (const id of catalog?.ids ?? []) {
      const m = await mount(id as ConversationId)
      if (m.meta.meta) old.push({ id, m })
    }
    if (!old.length) return
    const adopted = egoId ? undefined : (old.filter(({ m }) => !m.meta.archived).at(-1) ?? old.at(-1))
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Catalog)
      doc.ids = doc.ids.filter((id) => !old.some((o) => o.id === id))
      if (adopted) doc.ego = adopted.id
    }, context)
    for (const { id, m } of old) {
      if (id === adopted?.id) continue
      await m.stop()
      mounted.delete(String(id))
    }
    if (!adopted) return
    egoId = String(adopted.id)
    await updateMeta(egoId, (meta) => { delete meta.archived; meta.title = agentName(options.app) })
  }
  router.register(defineAction({
    // One per machine, for good: never listed, never archived, cleared rather than replaced.
    id: 'thread.meta', title: `Ask ${agentName(options.app)} about ${options.app.name} and how it's set up`, runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ prompt: opt(str()) }),
    async run({ prompt }) {
      const id = await ego()
      if (prompt?.trim()) await submit(id, prompt, randomUUID(), 'followUp')
      return info(id, await get(id))
    },
  }))
  router.register(defineAction({
    id: 'thread.meta.clear', title: `Clear ${agentName(options.app)}'s conversation`, runs: 'machine', expose: ['ui', 'cli'],
    params: obj({}),
    async run() {
      const id = await ego()
      const m = await get(id)
      // Stopped, then a new context: the model sees nothing before it, and the transcript starts after it.
      await m.conversation.abort(context)
      await m.conversation.reset(undefined, context)
      await m.conversation.waitForIdle(context)
      const last = (await m.conversation.entries({ order: 'descending' }, 1, undefined, context)).items[0]?.id
      await updateMeta(id, (meta) => {
        meta.cleared = Number(last ?? 0) + 1
        meta.seen = last === undefined ? {} : { entryId: Number(last) }
        meta.title = agentName(options.app)
        delete meta.panes
        delete meta.pane
      })
      // Windows showing it watch again, from the start it has now: a watch that ends `stopped` is watched again.
      for (const stop of transcriptWatches.get(id) ?? []) void stop()
      return info(id, m)
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
    params: obj({ id: str(), text: str(), attachments: opt(arr(ATTACHMENT)), requestId: opt(str()), whenBusy: opt(union([lit('steer'), lit('followUp')])) }),
    run: async ({ id, text, attachments, requestId, whenBusy }) => ({ submission: await submit(id, text, requestId ?? randomUUID(), whenBusy, attachments) }),
  }))
  router.register(defineAction({
    id: 'thread.abort', title: 'Stop the agent', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str() }),
    async run({ id }) { await (await get(id)).conversation.abort(context); return null },
  }))
  router.register(defineAction({
    id: 'thread.archive', title: 'Archive the thread', runs: 'machine', expose: ['ui', 'cli'], keys: 'mod+shift+e', ...thread,
    params: obj({ id: str() }),
    run: ({ id }) => archive(id),
  }))
  const notEgo = (id: string) => {
    if (id === egoId) throw new RpcError('invalid', `${agentName(options.app)} isn't archived`, { hint: 'Clear it instead.' })
  }
  /** Put a thread away. Its worktree goes with it when nothing in it is uncommitted; its branch stays, to come back to. */
  async function archive(id: string) {
    notEgo(id)
    const { meta } = await get(id)
    const tree = meta.worktree
    let removed = tree?.removed
    if (tree && !tree.removed) {
      const exists = await stat(tree.path).then(() => true, () => false)
      const clean = exists && (await git(tree.path, ['status', '--porcelain']).catch(() => 'unknown')) === ''
      if (!exists) removed = true
      else if (clean) removed = await removeWorktree(tree.path, meta.root)
    }
    await updateMeta(id, (m) => { m.archived = true; delete m.archiveWhenDone; if (m.worktree && removed) m.worktree.removed = true })
    return { worktree: tree ? (removed ? 'removed' as const : 'kept' as const) : null }
  }
  /**
   * A clean worktree, gone at once: moved aside and let go of by git, then deleted in the background. Deleting it in
   * place (`git worktree remove`) takes as long as its files do, many seconds with a node_modules in it.
   */
  async function removeWorktree(path: string, root: string | undefined) {
    const aside = join(dirname(path), `.${basename(path)}${REMOVING}${randomUUID().slice(0, 8)}`)
    if (!await rename(path, aside).then(() => true, () => false)) return false
    await git(root ?? aside, ['worktree', 'prune']).catch(() => {})
    void rm(aside, { recursive: true, force: true }).catch(() => {})
    return true
  }
  /** The worktrees a previous process moved aside and didn't get to delete (see removeWorktree), deleted now. */
  async function sweepRemoved() {
    const root = join(options.dataDir, 'worktrees')
    for (const repo of await readdir(root).catch(() => [])) {
      for (const name of await readdir(join(root, repo)).catch(() => [])) {
        if (name.startsWith('.') && name.includes(REMOVING)) await rm(join(root, repo, name), { recursive: true, force: true }).catch(() => {})
      }
    }
  }
  /**
   * Archive a thread once its run ends: how a thread archives itself, mid-turn, without its worktree going from under
   * the turn or the turn being cut short. Kept in its metadata, so a restart in between still archives it.
   */
  async function archiveWhenDone(id: string) {
    notEgo(id)
    await updateMeta(id, (m) => { m.archiveWhenDone = true })
    archiveIfDone(id, await get(id))
  }
  function archiveIfDone(id: string, m: Mounted) {
    if (!m.meta.archiveWhenDone || m.meta.archived || m.live?.run || archiving.has(id)) return
    archiving.add(id)
    void archive(id).catch((error) => console.error(`Couldn't archive thread ${id}:`, error)).finally(() => archiving.delete(id))
  }
  router.register(defineAction({
    id: 'thread.unarchive', title: 'Unarchive the thread', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str() }),
    async run({ id }) {
      const { meta } = await get(id)
      // Its worktree back, on the branch it left.
      const tree = meta.worktree
      if (tree?.removed && meta.root) {
        await mkdir(dirname(tree.path), { recursive: true })
        // Pruned first, in case a process ended before letting go of it (see removeWorktree).
        await git(meta.root, ['worktree', 'prune']).catch(() => {})
        await git(meta.root, ['worktree', 'add', '-q', tree.path, tree.branch])
          .catch((error: Error) => { throw new RpcError('invalid', `Couldn't restore its worktree: ${error.message}`) })
      }
      await updateMeta(id, (m) => { delete m.archived; delete m.archiveWhenDone; if (m.worktree) delete m.worktree.removed })
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
        // The focus moves left: to the pane before it, or (it was the first) the thread.
        if (meta.pane === pane) meta.pane = meta.panes![index - 1]?.id
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
    params: obj({ build: str(), interrupt: opt(bool()), env: opt(unknown()) }),
    run({ build, interrupt, env }) {
      if (build !== machine.build) throw new RpcError('changed', 'The running daemon changed. Check again.')
      if (restarting) throw new RpcError('restarting', 'Already restarting')
      // Decided synchronously from the mounted threads, so no run can start between the check and the flag.
      const busy = [...mounted.values()].some((m) => m.live?.run)
      if (busy && !interrupt) return { restarted: false, busy }
      restarting = true
      const vars = Object.fromEntries(Object.entries(env && typeof env === 'object' ? env : {}).filter((e): e is [string, string] => typeof e[1] === 'string'))
      setImmediate(() => options.onRestart?.(vars))
      return { restarted: true, busy }
    },
  }))

  await adoptEgo()
  // Mount everything once so statuses (and anything a previous process left running) are live from the start.
  await list()
  if (egoId) await get(egoId)
  // A run cut off by the last stop resumes where it was, maybe inside a profile's tool: its profile is loaded first, so
  // the tool is there to carry on with (a profile that no longer loads leaves the run to end as interrupted).
  for (const m of mounted.values()) {
    if (m.live?.run && m.meta.profile) await profileOf(m.meta.profile).catch((error: Error) => console.error(`Profile ${m.meta.profile!.name}: ${error.message}`))
  }
  harness.resume()
  void sweepRemoved()


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
            throw new RpcError('version_mismatch', `This machine's superego speaks protocol ${PROTOCOL_VERSION}, the client ${version}`, { hint: 'Update superego on the older side.' })
          }
          if (typeof name === 'string') client = name
          return { version: PROTOCOL_VERSION, features: features(), machine, methods: [...Object.keys(handlers), ...router.list().map((a) => a.id), ...methods.keys()] }
        },
        'thread.list': ({ archived }: { archived?: boolean } = {}) => list({ archived: Boolean(archived) }),
        'agent.models': async () => agent.catalog(),
        'file.read': async ({ id, path, base64 }: { id: string; path: string; base64?: boolean }) => {
          // In the thread's folder, or among the files it keeps (attachments, images it showed).
          const { cwd } = (await get(id)).meta
          const kept = isAbsolute(path) && resolvePath(path).startsWith(`${attachmentsOf(id)}/`)
          const file = kept ? resolvePath(path) : inFolder(cwd, path)
          const info = await stat(file).catch(() => undefined)
          if (!info?.isFile()) throw new RpcError('not_found', `No file ${path}`)
          if (info.size > 16 * 1024 * 1024) throw new RpcError('too_large', `${path} is larger than 16 MB`)
          return { path: file, content: await readFile(file, base64 ? 'base64' : 'utf8') }
        },
        /** The skills a message can name, for completing `$name` as it's typed. */
        'skill.list': async () => (await listSkills(skillsDir)).map(({ name, description }) => ({ name, description })),
        'file.find': async ({ id, name }: { id: string; name: string }) => locate((await get(id)).meta.cwd, name),
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
        /** Older entries than a watch's window holds: the page before `before`, oldest first, and whether there are more. */
        async 'thread.history'({ id, before, limit = 50 }: { id: string; before: number; limit?: number }) {
          const m = await get(id)
          const page = await m.conversation.entries({ maxEntryId: (before - 1) as EntryId, order: 'descending' }, Math.min(Math.max(1, limit), 200), undefined, context)
          // A cleared thread's history starts where it was cleared.
          const start = m.meta.cleared ?? 0
          const entries = [...page.items].reverse().filter((e) => Number(e.id) >= start)
          return { entries, more: page.next !== undefined && entries.length === page.items.length }
        },
        async 'thread.watch'({ id }: { id: string }) {
          const m = await get(id)
          const from = m.meta.cleared
          const watch = await m.conversation.watch(context, from !== undefined ? { from: from as EntryId } : undefined)
          const sub = randomUUID()
          const stop = () => watch.stop()
          const watches = transcriptWatches.get(id) ?? new Set()
          transcriptWatches.set(id, watches.add(stop))
          subs.set(sub, stop)
          watch.start(async (call) => { if (call.kind === 'value') notify('watch.ops', { sub, ops: call.ops as unknown[] }) })
          void watch.closed.then((end) => {
            watches.delete(stop)
            if (subs.delete(sub)) notify('watch.end', { sub, reason: end.kind })
          })
          // Nothing before where it was cleared: no earlier entries to page back to.
          const { before, ...rest } = watch.value
          return { sub, value: from !== undefined && Number(before ?? from) < from ? rest : watch.value }
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
        /** Ego's thread (null until it's first opened), then `meta.changed` with it whenever it changes. */
        async 'meta.watch'() {
          const sub = randomUUID()
          const current = async () => egoId ? info(egoId, await get(egoId)) : null
          let last = ''
          const push = async () => {
            const value = await current()
            const json = JSON.stringify(value)
            if (json !== last) { last = json; notify('meta.changed', { sub, value }) }
          }
          listListeners.add(push)
          subs.set(sub, () => { listListeners.delete(push) })
          const value = await current()
          last = JSON.stringify(value)
          return { sub, value }
        },
        'settings.watch': serveSettings(settings, (params) => notify('settings.changed', params), subs)['settings.watch'],
        async 'file.watch'({ id, path }: { id: string; path: string }) {
          const file = inFolder((await get(id)).meta.cwd, path)
          const read = () => stat(file).then((info) => info.isFile() && info.size <= 16 * 1024 * 1024 ? readFile(file, 'utf8') : null, () => null)
          let last = await read()
          const sub = randomUUID()
          // The folder, not the file: an editor that saves by renaming a new file over it would end a watch on the file.
          let timer: ReturnType<typeof setTimeout> | undefined
          const watcher = watchFs(dirname(file), (_event, name) => {
            if (name && String(name) !== basename(file)) return
            clearTimeout(timer)
            timer = setTimeout(async () => {
              const now = await read()
              if (now !== last) { last = now; notify('file.changed', { sub, content: now }) }
            }, 60)
          })
          watcher.on('error', () => {})
          subs.set(sub, () => { clearTimeout(timer); watcher.close() })
          return { sub, content: last }
        },
        async 'value.watch'({ key }: { key: string }) {
          const entry = valueOf(key)
          const sub = randomUUID()
          const listener = (value: Json) => notify('value.changed', { sub, key, value })
          entry.listeners.add(listener)
          subs.set(sub, () => { entry.listeners.delete(listener); prune(key) })
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
      const ctx = (): DaemonContext => ({ notify: (event, params) => notify(event as keyof Notifications, params as never), source: client })
      const open = (method: string, handler: (params: unknown) => unknown) => (params: unknown) => {
        if (restarting && method !== 'hello') throw new RpcError('restarting', 'The daemon is restarting. Try again in a moment.')
        return handler(params)
      }
      connections.add(peer)
      for (const [method, handler] of Object.entries(handlers)) peer.handle(method, open(method, handler))
      // Actions under their ids, and extensions' methods: looked up as they're called, so a profile's registered since
      // this connection opened are there too.
      peer.handleOthers((method) => {
        if (router.has(method)) return open(method, (params) => router.dispatch(method, params, ctx(), { source: client }))
        const read = methods.get(method)
        return read && open(method, read)
      })
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
  // The profiles threads here can start with: the user's, and those of the projects that have threads.
  settings.register({
    id: 'profiles', title: 'Profiles', order: 75, ui: 'profiles', settings: [],
    description: 'Your own, and those of the projects you have threads in.',
    data: async () => {
      const found = new Map<string, ProfileRef>()
      for (const folder of new Set([defaultCwd, ...(await list()).map((t) => t.session.root)])) {
        for (const ref of listProfiles(folder, userProfiles)) found.set(ref.dir, ref)
      }
      return Promise.all([...found.values()].map((ref) => describeProfile(ref, userProfiles, trust)))
    },
  })
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
