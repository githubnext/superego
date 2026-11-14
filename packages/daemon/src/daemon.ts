// The Superego daemon: one per user per machine. It owns a pi-durable Harness on SQLite, the thread catalog, and every
// live subscription. Clients (the Electron app, the CLI, a remote app over ssh) speak the protocol in @superego/protocol.
import { existsSync, watch as watchFs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, platform } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  type Conversation, type ConversationId, type ConversationView, createRegistry, defineDoc, defineExtension, defineTool, type EntryId, type Extension, Harness, hook, type SubmissionId,
  type LiveState, section, type Storage, wrapSection, wrapTool,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createCodingTools } from '@earendil-works/pi-durable/tools'
import {
  aliasesOf, arr, type Attachment, AUTH_REJECTED, compareVersion, contractProblem, EXTENSION_API, type ExtensionManifest, manifestOf, parseVersion, UNVERSIONED, DATA_VIEWS, dataViewProblem, type DataViewInfo, paramsParser, bool, defineAction, deriveStatus, FEATURES, NOTE_ENTRY, int, lit, nullable, num, obj, opt, type Pane, PROTOCOL_VERSION, Router, RpcError, str, union, unknown, type AppConfig, type Exposure, type ExtensionAbout, type Json, type MachineInfo, type Methods, type NewThread, type Notifications, type ProviderRejection, type RpcPeer, type ThreadInfo,
} from '@superego/protocol'
import { serveSettings, SettingsRegistry, withMovedKeys, type SettingsStore } from '@superego/settings'
import { FileSettingsStore } from '@superego/settings/file'
import { createAgentSettings } from './agent-settings.ts'
import { describeProfile, registerExtensionSettings } from './extension-settings.ts'
import {
  defineDaemonExtension, type AgentChoice, type ArchiveNote, type ArchiveNotes, type DaemonApi, type DaemonExtension, type LiveValue, type MessageBlock, type OutgoingMessage, type StatusContribution, type SubmitTransform,
  type ThreadCreating, type ThreadDraft, type ThreadHooks,
} from './extension.ts'
import { titleOf } from './names.ts'
import { readCommit } from './build.ts'
import { git } from './git.ts'
import { serveWeb, type ServedByTailscale, type WebServer } from './web.ts'
import { WebDevices } from './web-devices.ts'
import { startServe, stopServe, tailnetNames, type TailscaleState } from './tailscale.ts'
import { agentsInstructions } from './agents-md.ts'
import { defineProfile, findProfile, RENAMED, hashProfile, isProfileDir, listProfiles, loadProfile, profileModule, provideSdk, Trust, type LoadedProfile, type ProfileDaemonExtension, type ProfileRef } from './profiles.ts'

const context = BACKGROUND_CONTEXT

/**
 * Which conversations are threads, oldest first; child conversations (subagents) aren't. `ego` is from before Ego's
 * thread was a hidden one like any other: a thread kept apart from these (see migrateHidden).
 */
const Catalog = defineDoc<{ ids: number[]; ego?: number }>({
  kind: 'superego.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true,
})

// Names kept on the wire for older windows, from the one table of them (ALIASES in @superego/protocol), each until its
// milestone.
/** Methods (and actions) moved into an extension, by their old names: answered by the extension's while it's set up. */
const MOVED_METHODS: Record<string, string> = Object.fromEntries(aliasesOf('method').map((a) => [a.old, a.now]))
/** Watches moved into an extension's live value: the old watch method, the value it follows now, and the notification older windows listen for (`{ sub, value }`). */
const MOVED_WATCHES: Record<string, { value: string; event: string }> = Object.fromEntries(aliasesOf('watch').map((a) => [a.old, { value: a.now, event: a.event }]))
/** Features that became an extension's: announced by their old names too, while it is. */
const MOVED_FEATURES: Record<string, string> = Object.fromEntries(aliasesOf('feature').map((a) => [a.old, a.now]))
/** Thread fields that became an extension's fact: given by their old names too (the branch chip, Ego's Clear). */
const MOVED_FACTS = (ext: Record<string, Json> | undefined) =>
  Object.fromEntries(aliasesOf('fact').filter((a) => ext?.[a.now] !== undefined).map((a) => [a.old, ext![a.now]!]))
/** Settings kept under another key now: a value stored under the old one is read as the new one's. */
const MOVED = Object.fromEntries(Object.entries(RENAMED).map(([old, now]) => [`extensions.${old}`, `extensions.${now}`]))

/**
 * Names no extension can take: the core's own namespaces (its methods, actions and settings are `<namespace>.<…>`), so
 * an extension's method can't be shadowed by the core's, nor its settings mixed in with them. A test keeps it in step.
 */
export const RESERVED = new Set([
  'action', 'agent', 'app', 'auth', 'core', 'daemon', 'extensions', 'file', 'hello', 'meta', 'model', 'pane', 'profile', 'profiles',
  'providers', 'settings', 'skill', 'thread', 'threads', 'unwatch', 'value', 'view', 'watch', 'web',
  // `skill` is no longer the core's, but older windows still call skill.list (see MOVED_METHODS).
])

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
  /** From before extensions kept state: the worktrees extension's (see LEGACY). */
  worktree?: Json
  /** From before extensions kept state: the ego extension's (see LEGACY). */
  meta?: boolean
  /** In no list: an extension's own thread, opened by id. */
  hidden?: boolean
  /** The extension that made it, for a hidden thread: it takes no messages while that one is off. */
  owner?: string
  /** Extensions' state with it, by extension name (see `superego.state`). */
  ext?: Record<string, Json>
  /** Where its transcript starts now: the entry after the reset that last cleared it (`threads.clear`). */
  cleared?: number
  /** The thread that started it (by thread_start, or thread.create's `parent`). */
  parent?: string
}
const ThreadDoc = defineDoc<ThreadMeta>({
  kind: 'superego.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current',
  initial: () => ({ title: '', cwd: '', createdAt: 0 }), checkpointWhen: () => true,
})

/**
 * Extensions' state from before extensions kept their own: read from the field the core kept it in, until the extension
 * first writes its state, which moves it. So a thread from before reads the same, and nothing needs copying. A
 * migration of data, not of clients (MIGRATIONS' `thread-state`): remove only once databases from before extensions kept
 * state (2026-11) are no longer opened, with migrateHidden; never with a protocol bump.
 */
const LEGACY: Record<string, { read(meta: ThreadMeta): Json | undefined; drop(meta: ThreadMeta): void }> = {
  worktrees: { read: (meta) => meta.worktree, drop: (meta) => { delete meta.worktree } },
  ego: { read: (meta) => meta.meta ? true : undefined, drop: (meta) => { delete meta.meta } },
}
/** An extension's state with a thread. */
const stateOf = (meta: ThreadMeta, name: string): Json | undefined =>
  meta.ext && Object.hasOwn(meta.ext, name) ? meta.ext[name] : LEGACY[name]?.read(meta)
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T

/** What an extension says of itself, and only that: the fields `ExtensionAbout` has, each of its type (a window's declaration is anyone's JSON). */
function aboutOf(about: ExtensionAbout): ExtensionAbout {
  const { name, title, description, required, version, api, capabilities } = about
  return {
    name, ...(typeof title === 'string' && title ? { title } : {}), ...(typeof description === 'string' && description ? { description } : {}), ...(required === true ? { required } : {}),
    ...(typeof version === 'string' ? { version } : {}), ...(typeof api === 'string' ? { api } : {}),
    ...(Array.isArray(capabilities) && capabilities.every((c) => typeof c === 'string') && capabilities.length ? { capabilities } : {}),
  }
}

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
  /** The git commit of the code running, reported in `hello`; defaults to this checkout's (none outside git). */
  commit?: { commit: string; committedAt: number } | null
  /** Called once a restart was accepted and answered, with what to add to the successor's environment; the host closes the daemon and exits. */
  onRestart?: (env: Record<string, string>) => void
  /** The app's window build (index.html and assets), served to browsers when Web access is on. */
  webRoot?: string
  /** The folder agents share: skills in `skills/`, standing instructions in `AGENTS.md`. Defaults to `~/.agents`. */
  agentsDir?: string
}

/** One mounted thread: its conversation and a small watch that keeps its status current. */
type Mounted = {
  conversation: Conversation; meta: ThreadMeta; live?: LiveState; lastEntryId?: number
  /** What the thread runs with (and whose model it is) and has spent, and when anything last happened in it. */
  model?: string; provider?: string; cost?: number; activeAt?: number
  /** The task of the last failed run it heard of (null: none), so each failure is looked at once. */
  failure?: number | null
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

/** Threads are titled from their first message (see names.ts). */
export { titleOf }

/** The repository `dir` is in: its checkout's top, and the project it belongs to (the main checkout, for a worktree). */
async function checkoutOf(dir: string): Promise<{ top: string; root: string } | undefined> {
  const top = await git(dir, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  if (!top) return undefined
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')
  return { top, root: basename(common) === '.git' ? dirname(common) : top }
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
   * What extensions registered about threads, in the order they were set up: whose, and (a profile's) for which
   * profiles' threads (their folders).
   */
  type Owned<T> = { value: T; owner: string; profiles?: Set<string> }
  const threadHooks: Owned<ThreadHooks>[] = []
  const factSources: Owned<(thread: { id: string; state: Json | undefined }) => Json | undefined>[] = []
  const choosers: Owned<(thread: { id?: string; state: Json | undefined; profile?: ProfileRef }) => AgentChoice | undefined>[] = []
  /** Agent parts given to no thread but those an `agentFor` of their extension chooses them for: by extension, as given, to as installed. */
  const chosenParts = new Map<string, Map<Extension, Extension>>()
  /** Whether what an extension registered is for a thread: one it doesn't go without, and of its profile if a profile's. */
  const appliesTo = (entry: Owned<unknown>, without: Set<string>, meta?: ThreadMeta) =>
    !without.has(entry.owner) && (!entry.profiles || Boolean(meta?.profile && entry.profiles.has(meta.profile.dir)))
  /** The optional extensions turned off on this machine or left out by a profile. */
  function switchedOff(profile?: LoadedProfile): Set<string> {
    const without = new Set<string>()
    for (const { name, required } of extensions.values()) {
      if (!required && (settings.get(`extensions.${name}`) === false || profile?.spec.without?.includes(name))) without.add(name)
    }
    return without
  }
  /** Choosers that threw once: logged then, not on every thread's info after. */
  const failedChoosers = new WeakSet<object>()
  /** A thread's agent as extensions choose it (`agentFor`): the first answer, if any, and whose it is (`by`). */
  function choiceOf(id: string | undefined, meta: ThreadMeta, off: Set<string>): (AgentChoice & { by: string }) | undefined {
    for (const chooser of choosers) {
      if (!appliesTo(chooser, off, meta)) continue
      try {
        const choice = chooser.value({ ...(id ? { id } : {}), state: stateOf(meta, chooser.owner), ...(meta.profile ? { profile: meta.profile } : {}) })
        if (choice) return { ...choice, by: chooser.owner }
      } catch (error) {
        if (!failedChoosers.has(chooser)) console.error(`Extension ${chooser.owner}: agentFor failed:`, error)
        failedChoosers.add(chooser)
      }
    }
    return undefined
  }
  /**
   * The optional extensions a thread goes without: turned off on this machine, left out by its profile, or left out
   * by the extension that chose its agent (Ego's). One answer for its agent's parts, the pane kinds it's told of, the
   * hooks and facts that are for it, and the UI the window draws for it. With the choice it was worked out from.
   */
  function choiceAndWithout(id?: string, meta?: ThreadMeta, profile?: LoadedProfile) {
    const without = switchedOff(profile)
    const choice = meta && choiceOf(id, meta, without)
    for (const name of choice?.without ?? []) {
      const known = extensions.get(RENAMED[name] ?? name)
      if (known && !known.required) without.add(known.name)
    }
    return { choice, without }
  }
  const withoutOf = (id?: string, meta?: ThreadMeta, profile?: LoadedProfile) => choiceAndWithout(id, meta, profile).without
  /** A thread's profile, if it's loaded yet. */
  const loadedProfile = (meta: ThreadMeta) => meta.profile && profiles.get(meta.profile.dir)
  /** The agent parts a thread has: every built-in but those of the extensions it goes without. */
  const partsFor = (without: Set<string>) => builtins.filter((b) => !without.has(b.owner)).map((b) => b.part)
  /**
   * The kinds of pane the agent can open, and what each shows, as extensions describe them (`superego.pane`; the window
   * draws them, the extension's UI half registering the same kind): the core's own `panes`, and any other's. A
   * profile's extension's are for the threads of the profiles that have it only (`profiles`: their folders).
   */
  const paneKinds: { kind: string; about: string; owner: string; profiles?: Set<string> }[] = []
  /** How the window shows an agent's messages (Markdown.tsx), so it writes for that. */
  const MARKDOWN_PROMPT = [
    'The thread shows your messages as GitHub-flavoured Markdown: tables, task lists and strikethrough render; raw HTML does not.',
    'Fenced code blocks are syntax-highlighted by their language tag (```ts, ```bash, ```diff, …), so always tag the language.',
  ].join('\n')
  // Panes: the agent opens them beside its thread (a file, another thread, an extension's or a profile's own), from the
  // kinds its instructions list.
  const panesPart = defineExtension({
    name: 'panes',
    tools: [defineTool({
      name: 'open_pane',
      description: 'Open a pane beside this conversation for the user to look at. The kinds there are, and the params each takes, are listed in your instructions under panes.',
      parameters: obj({ kind: str({ minLength: 1 }), title: opt(str()), params: opt(obj({}, { open: true, description: 'What the pane shows, as an object: { "path": "notes/a.md" }, not a string of JSON.' })) }),
      async execute({ kind, title, params }, api) {
        // Only the kinds this thread is told of: another (its extension off, or gone without) would be kept but not drawn.
        const kinds = panesOf(String(api.conversationId)).map((k) => k.kind)
        if (!kinds.includes(kind)) throw new Error(`There is no "${kind}" pane here. The kinds there are: ${kinds.map((k) => `"${k}"`).join(', ')}.`)
        const pane = await openPane(String(api.conversationId), { kind, ...(title ? { title } : {}), ...(params !== undefined ? { params: params as Json } : {}) })
        return { output: [{ type: 'text', text: `Opened the ${kind} pane (${pane.id}).` }] }
      },
    })],
    sections: [section('panes', ({ conversationId }) => {
      const kinds = panesOf(String(conversationId))
      return `Panes you can open beside this conversation with open_pane, by kind:\n${kinds.map(({ kind, about }) => `- "${kind}": ${about}`).join('\n')}`
    })],
  })
  /**
   * The pane kinds a thread's agent is told of: the core's and those of extensions it has, and its profile's. A kind
   * both describe is told as its profile's, as the window draws it.
   */
  function panesOf(id: string) {
    const meta = mounted.get(id)?.meta
    const dir = meta?.profile?.dir
    const profile = dir ? profiles.get(dir) : undefined
    const without = withoutOf(id, meta, profile)
    const kinds = new Map<string, string>()
    for (const p of paneKinds) if (!p.profiles && !without.has(p.owner)) kinds.set(p.kind, p.about)
    for (const p of paneKinds) if (dir && p.profiles?.has(dir)) kinds.set(p.kind, p.about)
    for (const [kind, about] of Object.entries(profile?.spec.panes ?? {})) kinds.set(kind, about)
    return [...kinds].map(([kind, about]) => ({ kind, about }))
  }
  // The folder agents share: standing instructions in AGENTS.md (see agents-md.ts), and the skills extension's skills.
  const agentsDir = options.agentsDir ?? join(homedir(), '.agents')
  /**
   * The core's own agent parts, as extensions like any other: each optional, so a machine can turn it off and a profile
   * can do without it. Set up first, through the same API as the bundled ones.
   */
  const core: DaemonExtension[] = [
    { name: 'coding-tools', version: '1.0.0', api: '^1', title: 'Coding tools', description: 'Read, write and edit files, and run commands.', setup: (s) => s.agent(createCodingTools()) },
    {
      // How messages show is the window's, not something to turn off.
      name: 'markdown', version: '1.0.0', api: '^1', title: 'Markdown', description: 'Know how the thread shows messages, and write for it.', required: true,
      setup: (s) => s.agent(defineExtension({ name: 'markdown', sections: [section('markdown', () => MARKDOWN_PROMPT)] })),
    },
    {
      name: 'panes', version: '1.0.0', api: '^1', title: 'Panes', description: 'Open panes beside a thread: files, other threads, and the kinds extensions add.',
      setup(s) {
        s.agent(panesPart)
        // The window's built-in kinds (its panes.tsx); extensions describe their own (git's Changes, web-panes').
        s.pane('editor', '{ path }: a file, for the user to read and edit')
        s.pane('thread', '{ thread }: another conversation')
      },
    },
    {
      name: 'agents-md', version: '1.0.0', api: '^1', title: 'AGENTS.md', description: 'Follow the standing instructions in AGENTS.md files.',
      setup: (s) => s.agent(defineExtension({ name: 'agents-md', sections: [section('agents_md', async ({ env }) => agentsInstructions(agentsDir, env?.cwd))] })),
    },
  ]
  /** A thread's last answer, as text. */
  /** A thread's newest transcript entries, newest first: none from before it was last cleared. */
  async function newest(id: string, limit: number) {
    const m = await get(id)
    const { items } = await m.conversation.entries({ order: 'descending' }, limit, undefined, context)
    return items.filter((entry) => Number(entry.id) >= (m.meta.cleared ?? 0))
  }
  async function answerOf(id: string) {
    for (const entry of await newest(id, 50)) {
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
    ...(options.commit === undefined ? readCommit(import.meta.dirname) : options.commit ?? {}),
  }
  /** Set once a restart is accepted: no new work starts, so nothing is cut off that wasn't agreed to. */
  let restarting = false
  const mounted = new Map<string, Mounted>()
  /** The threads being archived now that their run ended (see archiveWhenDone). */
  const archiving = new Set<string>()
  /** The transcript watches open on each thread, to end when it's cleared (clients then watch again). */
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
      const agent = view.docs['pi.agent'] as { model?: { modelId?: string; provider?: string } } | undefined
      entry.model = agent?.model?.modelId
      entry.provider = agent?.model?.provider
      entry.cost = costOf(view.docs['pi.usage'] as Parameters<typeof costOf>[0])
      heedFailure(key, entry)
      changed()
    }
    absorb(watch.value)
    watch.start(async (call) => {
      if (call.kind !== 'value') return
      const wasRunning = Boolean(entry.live?.run)
      absorb(call.value)
      // A run starting or ending, as the extensions' hooks hear it (one resumed after a restart was running already).
      const running = Boolean(entry.live?.run)
      if (running !== wasRunning) tellLater(running ? 'turnStart' : 'turnEnd', key)
      archiveIfDone(key, entry)
    })
    mounted.set(key, entry)
    archiveIfDone(key, entry)
    return entry
  }

  /** What clients see of a thread; `without` worked out once for its facts and what it goes without. */
  const info = (id: string, m: Mounted, without = withoutOf(id, m.meta, loadedProfile(m.meta))): ThreadInfo => ({
    id, title: m.meta.title || 'New thread', cwd: m.meta.cwd, createdAt: m.meta.createdAt,
    activeAt: Math.max(m.activeAt ?? 0, m.meta.createdAt),
    ...(m.model ? { model: m.model } : {}), ...(m.cost ? { cost: m.cost } : {}), ...(m.meta.model ? { ownModel: true } : {}),
    ...(m.meta.model || m.meta.thinking ? { chosen: { ...(m.meta.model ? { model: m.meta.model } : {}), ...(m.meta.thinking ? { thinking: m.meta.thinking } : {}) } } : {}),
    ...(m.meta.profile ? { profile: m.meta.profile } : {}),
    ...(m.meta.panes?.length ? { panes: m.meta.panes, ...(m.meta.pane ? { pane: m.meta.pane } : {}) } : {}),
    session: { root: rootOf(m), name: basename(rootOf(m)) },
    ...withMovedFacts(factsInfo(id, m.meta, without)),
    ...(m.meta.archived ? { archived: true } : {}),
    ...(m.meta.hidden ? { hidden: true, ...(m.meta.owner ? { owner: m.meta.owner } : {}) } : {}),
    ...(m.meta.parent ? { parent: m.meta.parent } : {}),
    ...(without.size ? { without: [...without].sort() } : {}),
    status: deriveStatus({ live: m.live, lastEntryId: lastAnswer(m), seen: m.meta.seen, ...blockedOf(id), ...signInOf(id, m) }),
  })
  /**
   * A run that failed for its credentials: its thread waits for sign-in to the provider (whose turns then fail at once)
   * until those change or someone retries. Each failure once; those there before the thread was watched were heard of
   * before (or are too old to wait on). A thread that runs again, or answers, no longer waits.
   */
  function heedFailure(id: string, m: Mounted) {
    const failure = m.live?.run ? undefined : m.live?.runFailure
    const fresh = failure && m.failure !== undefined && failure.taskId !== m.failure
    m.failure = failure?.taskId ?? null
    if (fresh && failure.reason === 'model_error' && m.provider && agent.rejected(m.provider, id, failure.taskId, failure.detail)) return
    if (!agent.rejections.waiting(id, failure?.taskId)) agent.rejections.release(id)
  }
  const waitingOn = (id: string, m: Mounted) => m.live?.run ? undefined : agent.rejections.waiting(id, m.live?.runFailure?.taskId)
  const signInOf = (id: string, m: Mounted) => {
    const rejection = waitingOn(id, m)
    return rejection ? { signIn: rejection.summary } : {}
  }
  /** The providers that rejected this machine's credentials, with the threads in use waiting on them. */
  const rejectedNow = (): ProviderRejection[] => agent.rejections.all().map(({ credential: _, threads, ...rejection }) => ({
    ...rejection, threads: Object.keys(threads).filter((id) => mounted.has(id) && !mounted.get(id)!.meta.archived),
  }))
  /**
   * Retry the threads waiting on `provider` (or every rejected one), once each: their runs continue where they failed,
   * as one cut off by a restart does. One whose credentials are rejected again waits again, until the next change.
   */
  async function retrySignIn(provider?: string) {
    let retried = 0
    for (const id of provider ? [provider] : agent.rejections.all().map((r) => r.provider)) {
      const rejection = agent.rejections.retry(id)
      if (!rejection) continue
      for (const thread of Object.keys(rejection.threads)) {
        const m = mounted.get(thread)
        if (!m || m.meta.archived || restarting || !waitingOn(thread, m)) continue
        try {
          await m.conversation.submit({ type: 'continue' }, context)
          retried++
        } catch (error) {
          console.error(`Retrying thread ${thread} after sign-in:`, error)
        }
      }
      agent.rejections.settle(rejection)
    }
    return retried
  }
  /** What extensions say about a thread (`facts`), by extension: those it doesn't go without, as for hooks. */
  const factsInfo = (id: string, meta: ThreadMeta, without: Set<string>): Pick<ThreadInfo, 'ext'> => {
    const ext: Record<string, Json> = {}
    for (const source of factSources) {
      if (!appliesTo(source, without, meta)) continue
      try {
        const fact = source.value({ id, state: stateOf(meta, source.owner) })
        if (fact !== undefined) ext[source.owner] = fact
      } catch (error) {
        console.error(`Extension ${source.owner}: facts of thread ${id} failed:`, error)
      }
    }
    return Object.keys(ext).length ? { ext } : {}
  }
  const withMovedFacts = (facts: Pick<ThreadInfo, 'ext'>) => ({ ...facts, ...MOVED_FACTS(facts.ext) })
  /** A thread's session: kept since it started; for older threads, found from its folder once (else the folder). */
  const rootOf = (m: Mounted) => m.meta.root ?? m.root ?? m.meta.cwd
  /** Only an assistant answer makes a thread "done"; the user's own message does not. */
  const lastAnswer = (m: Mounted) => m.live?.run ? undefined : m.lastEntryId

  /** The threads, newest first: the ones in use, or (`archived`) the ones put away; (`hidden`) those in no list instead. */
  async function list({ archived = false, hidden = false } = {}): Promise<ThreadInfo[]> {
    const catalog = await harness.snapshot(Catalog, context)
    const items: ThreadInfo[] = []
    for (const id of [...(catalog?.ids ?? [])].reverse()) {
      const m = await mount(id as ConversationId)
      if (Boolean(m.meta.archived) === archived && Boolean(m.meta.hidden) === hidden) items.push(info(String(id), m))
    }
    return items
  }

  /** A thread by id, listed or hidden. */
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

  /** Change an extension's state with a thread: `undefined` forgets it (and anything the core kept of it before, LEGACY). */
  function editState(id: string, name: string, edit: (current: Json | undefined) => Json | undefined) {
    return updateMeta(id, (meta) => {
      const next = clone(edit(clone(stateOf(meta, name))))
      LEGACY[name]?.drop(meta)
      if (next !== undefined) meta.ext = { ...meta.ext, [name]: next }
      else if (meta.ext && Object.hasOwn(meta.ext, name)) {
        const { [name]: _gone, ...rest } = meta.ext
        if (Object.keys(rest).length) meta.ext = rest
        else delete meta.ext
      }
    })
  }

  // ── Thread hooks ────────────────────────────────────────────────────────────────────────────────────────────────

  /** The extensions' hooks for a thread, in order: those it doesn't go without, a profile's for its own threads only. */
  const hooksOf = (id: string, m: Mounted) => {
    const without = withoutOf(id, m.meta, loadedProfile(m.meta))
    return threadHooks.filter((h) => appliesTo(h, without, m.meta))
  }
  /** A refusal from an extension's hook, as clients see it: its own `RpcError`, else `refused`, saying whose. */
  const refusal = (owner: string, error: unknown) =>
    error instanceof RpcError ? error : new RpcError('refused', `${owner}: ${error instanceof Error ? error.message : String(error)}`)
  /**
   * A thread's profile loaded, so its extensions' hooks are there for it (after a restart, a profile loads only once
   * one of its threads runs). One that no longer loads is logged, and its hooks are gone with it.
   */
  async function withProfile(id: string) {
    const { profile } = (await get(id)).meta
    if (profile) await profileOf(profile).catch((error: Error) => console.error(`Profile ${profile.name}: ${error.message}`))
  }
  /** Ask the hooks that may refuse (`archiving`, `unarchiving`): the first to throw stops it, with its error. */
  async function ask(hook: 'archiving' | 'unarchiving', id: string, notes: ArchiveNotes = {}) {
    const m = await get(id)
    for (const { value, owner } of hooksOf(id, m)) {
      try {
        noted(notes, owner, await value[hook]?.(info(id, m)))
      } catch (error) {
        throw refusal(owner, error)
      }
    }
  }
  /** Keep the line a hook said of what it did, under its extension's name. */
  const noted = (notes: ArchiveNotes, owner: string, said: unknown) => {
    const note = (said as ArchiveNote | undefined)?.note
    if (typeof note === 'string' && note) notes[owner] = notes[owner] ? `${notes[owner]} ${note}` : note
  }
  /** Tell the hooks what happened, in order: one that throws is logged, and the rest are told all the same. */
  async function tell(hook: 'created' | 'turnStart' | 'turnEnd' | 'blocked' | 'archived' | 'unarchived', id: string, as?: Partial<ThreadInfo>, notes: ArchiveNotes = {}) {
    const m = await get(id)
    for (const { value, owner } of hooksOf(id, m)) {
      try {
        // Each sees what the ones before it did (a worktree removed).
        noted(notes, owner, await value[hook]?.({ ...info(id, m), ...as }))
      } catch (error) {
        console.error(`Extension ${owner}: ${hook} of thread ${id} failed:`, error)
      }
    }
    return notes
  }
  /** Turns as the hooks hear them: in order for each thread, one after another, never holding up the run. */
  const told = new Map<string, Promise<void>>()
  function tellLater(hook: 'turnStart' | 'turnEnd' | 'blocked', id: string) {
    if (!threadHooks.some((h) => h.value[hook])) return
    const next = (told.get(id) ?? Promise.resolve()).then(async () => { await tell(hook, id) }).catch(() => {})
    told.set(id, next)
    void next.then(() => { if (told.get(id) === next) told.delete(id) })
  }
  /**
   * The threads that need the user now (an extension's `status`), so `blocked` is told once each time one comes to.
   * Status changes only when an extension says so (`invalidate`), so that's when it's looked at.
   */
  const needing = new Set<string>()
  function heedStatus() {
    for (const [id, m] of mounted) {
      const blocked = !m.meta.archived && Boolean(blockedOf(id).blocked)
      if (blocked === needing.has(id)) continue
      if (blocked) { needing.add(id); tellLater('blocked', id) } else needing.delete(id)
    }
  }

  // ── Extensions ──────────────────────────────────────────────────────────────────────────────────────────────────

  const connections = new Set<RpcPeer>()
  /** Every intent this daemon answers, its own and its extensions'. Reads and watches are plain methods. */
  const router = new Router<DaemonContext>()
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
  // The core's own: which providers rejected this machine's credentials, and how many threads wait (ProviderRejection).
  const rejectedValue = valueOf(AUTH_REJECTED)
  rejectedValue.owned = true
  let rejectedJson = ''
  const publishRejected = () => {
    const now = rejectedNow()
    const json = JSON.stringify(now)
    if (json === rejectedJson) return
    rejectedJson = json
    rejectedValue.value = now
    for (const listener of rejectedValue.listeners) listener(now)
  }
  // The core's own: extensions' data views (`superego.view`), as the window draws them (DataViewInfo[]).
  const viewsValue = valueOf(DATA_VIEWS)
  viewsValue.owned = true
  viewsValue.value = []
  /** Each with the profiles it's for (a profile's: their folders, which change as profiles share it). */
  const dataViews: { info: DataViewInfo; profiles?: Set<string> }[] = []
  /** Tell watchers the views as they are now: a profile's only once a profile has it. */
  const publishViews = () => {
    viewsValue.value = dataViews.filter((v) => !v.profiles || v.profiles.size).map((v) => v.profiles ? { ...v.info, profiles: [...v.profiles] } : v.info)
    for (const listener of viewsValue.listeners) listener(viewsValue.value)
  }
  const contributors: ((threadId: string) => StatusContribution | undefined)[] = []
  /** Extensions' submit transforms, in the order registered: whose, and (a profile's) for which profiles' threads (their folders). */
  const transforms: { transform: SubmitTransform; owner: string; profiles?: Set<string> }[] = []
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
  /** Extensions announced as `ext:<name>`: the extensions set up now, bundled and profiles' alike, each as it declares itself. */
  const announced = new Map<string, ExtensionManifest>()
  /** The extensions announced and on: those switched off on this machine aren't offered. */
  const offered = () => [...announced.values()].filter(({ name }) => extensions.get(name)?.required || settings.get(`extensions.${name}`) !== false)
  /**
   * What this daemon offers, as `hello` says and `features.changed` keeps current: the protocol's features, every
   * extension set up now but those switched off on this machine, and each of those at its version.
   */
  const offer = () => {
    const on = offered()
    const named = on.map(({ name }) => `ext:${name}`)
    return { features: [...FEATURES, ...named, ...Object.entries(MOVED_FEATURES).filter(([, now]) => named.includes(now)).map(([old]) => old)], extensions: on }
  }
  const features = () => offer().features
  let announcedOffer = ''
  let announcing = false
  /** Tell every client what this daemon offers, once it changed (after whatever changed it settles). */
  function announce() {
    if (announcing) return
    announcing = true
    queueMicrotask(() => {
      announcing = false
      const now = offer()
      if (JSON.stringify(now) === announcedOffer) return
      announcedOffer = JSON.stringify(now)
      for (const peer of connections) peer.notify('features.changed', now)
    })
  }

  /**
   * Set up a daemon extension: a bundled one (for the daemon's life), or a profile's (`agent` then adds to the
   * selection of the profiles that have it, `profiles`: their folders). Everything it registers is its own, and the
   * returned teardown undoes all of it: its agent parts, actions, values, status, settings, hooks and its name.
   * `agentExtension` installs an agent part, and gives it to every thread it's for when `always`: the installed part
   * (a profile's are renamed), and how to undo it.
   */
  async function setUp(extension: DaemonExtension, agentExtension: (extension: Extension, always: boolean) => { installed: Extension; undo: () => void }, profiles?: Set<string>): Promise<() => void> {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw new Error(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    if (RESERVED.has(extension.name)) throw new Error(`The name ${extension.name} is the core's own`)
    if (claimed.has(extension.name)) throw new Error(`An extension named ${extension.name} is already set up`)
    // One whose versions don't read, or that needs an extension API this host isn't, is refused before it runs.
    const problem = contractProblem(extension)
    if (problem) throw new Error(problem)
    claimed.add(extension.name)
    const undo: (() => void)[] = [() => { claimed.delete(extension.name); announced.delete(extension.name); announce() }]
    const ownKey = (key: string) => {
      if (key !== extension.name && !key.startsWith(`${extension.name}.`)) throw new Error(`Extension ${extension.name} must name its settings "${extension.name}.<key>", not "${key}"`)
    }
    const api: DaemonApi = {
      app: options.app,
      dataDir: options.dataDir,
      agentsDir,
      harness,
      agent(agentPart, { always = true } = {}) {
        const { installed, undo: uninstall } = agentExtension(agentPart, always)
        undo.push(uninstall)
        if (always) return
        const own = chosenParts.get(extension.name) ?? new Map<Extension, Extension>()
        chosenParts.set(extension.name, own.set(agentPart, installed))
        undo.push(() => { own.delete(agentPart); if (!own.size) chosenParts.delete(extension.name) })
      },
      settings: {
        register(section) {
          ownKey(section.id)
          for (const setting of section.settings) ownKey(setting.key)
          undo.push(settings.register(section))
        },
        get: (key) => settings.get(key),
        snapshot: () => settings.snapshot(),
        onChange: (listener) => { undo.push(settings.onChange(listener)) },
      },
      action: (action) => { undo.push(router.register({ ...action, id: named(extension.name, action.id), runs: 'machine' })) },
      dispatch: (id, params) => router.dispatch(id, params ?? {}, { source: extension.name, notify: () => {} }, { source: extension.name }),
      actions: (exposure) => router.list(exposure),
      method(name, run, options = {}) {
        const id = named(extension.name, name)
        if (methods.has(id) || router.has(id)) throw new Error(`Method ${id} is already defined`)
        const parse = paramsParser(id, options.params)
        methods.set(id, async (params: unknown) => run(parse(params) as never))
        undo.push(() => { methods.delete(id) })
      },
      pane(kind, about) {
        if (paneKinds.some((p) => p.kind === kind && p.profiles === profiles)) throw new Error(`Pane kind ${kind} is already described`)
        const entry = { kind, about, owner: extension.name, ...(profiles ? { profiles } : {}) }
        paneKinds.push(entry)
        undo.push(() => { paneKinds.splice(paneKinds.indexOf(entry), 1) })
      },
      view(id, view) {
        const name = named(extension.name, id)
        const problem = dataViewProblem(view)
        if (problem) throw new Error(`View ${name} ${problem}`)
        const source = view.value ?? view.method!
        if (!source.startsWith(`${extension.name}.`)) throw new Error(`View ${name} must read a value or method of ${extension.name}'s, not ${source}`)
        if (dataViews.some((v) => v.info.id === name)) throw new Error(`View ${name} is already declared`)
        // A profile's show only in its threads: the places that show one.
        const fits = profiles ? view.fits.filter((p) => p !== 'space') : view.fits
        if (!fits.length) throw new Error(`View ${name} fits no place a profile's view is drawn in (aside, pane)`)
        const entry = { info: { ...view, fits, id: name, extension: extension.name }, ...(profiles ? { profiles } : {}) }
        dataViews.push(entry)
        publishViews()
        undo.push(() => { dataViews.splice(dataViews.indexOf(entry), 1); publishViews() })
        // Told to the agent as a pane kind it can open, when it says what it shows.
        if (view.about && view.context === 'thread' && fits.includes('pane')) api.pane(name, view.about)
      },
      value<T extends Json>(key: string, initial: T): LiveValue<T> {
        const name = named(extension.name, key)
        const entry = valueOf(name)
        if (entry.owned) throw new Error(`Value ${name} is already published`)
        entry.owned = true
        // Gone with it: watchers see null again (as before it was set up), and a later watch waits on null.
        undo.push(() => {
          entry.owned = false
          entry.value = null
          for (const listener of entry.listeners) listener(null)
          prune(name)
        })
        const set = (next: T) => {
          entry.value = next
          for (const listener of entry.listeners) listener(next)
        }
        set(initial)
        return { get: () => entry.value as T, set, update: (edit) => set(edit(entry.value as T)) }
      },
      status: (contribute) => { contributors.push(contribute); undo.push(() => { contributors.splice(contributors.indexOf(contribute), 1) }) },
      submit(transform) {
        const entry = { transform, owner: extension.name, ...(profiles ? { profiles } : {}) }
        transforms.push(entry)
        undo.push(() => { transforms.splice(transforms.indexOf(entry), 1) })
      },
      invalidate() { changed(); heedStatus() },
      thread(hooks) { own(threadHooks, hooks) },
      state<T extends Json>() {
        const name = extension.name
        return {
          get: async (id: string) => stateOf((await get(id)).meta, name) as T | undefined,
          set: (id: string, next: T | undefined) => editState(id, name, () => next),
          update: (id: string, edit: (current: T | undefined) => T | undefined) => editState(id, name, (current) => edit(current as T | undefined)),
        }
      },
      facts(describe) {
        if (factSources.some((f) => f.owner === extension.name)) throw new Error(`Extension ${extension.name} already says its facts`)
        own(factSources, describe as (typeof factSources)[number]['value'])
        changed()
      },
      agentFor(choose) { own(choosers, choose as (typeof choosers)[number]['value']); changed() },
      threads: {
        list: (options) => list(options),
        get: async (id) => info(id, await get(id)),
        conversation: async (id) => (await get(id)).conversation,
        of: (conversationId) => mounted.has(String(conversationId)) ? String(conversationId) : undefined,
        attachments: attachmentsOf,
        create: ({ hidden, ...params }) => startThread({ ...params, ...(hidden ? { hidden: extension.name } : {}), by: extension.name }),
        async submit(id, text, { whenBusy = 'followUp' } = {}) { await submit(id, text, randomUUID(), whenBusy, [], extension.name) },
        lastAnswer: (id) => answerOf(id),
        entries: (id, limit = 20) => newest(id, limit),
        async archive(id, { whenIdle = false } = {}) {
          if (!whenIdle) return archive(id)
          await archiveWhenDone(id)
          return { notes: {} }
        },
        async unarchive(id) { await unarchive(id) },
        clear: (id) => clear(id),
      },
    }
    /** Keep something it registered about threads in `list`, as its own, until it's torn down. */
    function own<T>(list: Owned<T>[], value: T) {
      const entry: Owned<T> = { value, owner: extension.name, ...(profiles ? { profiles } : {}) }
      list.push(entry)
      undo.push(() => { list.splice(list.indexOf(entry), 1); changed() })
    }
    const teardown = () => { for (const step of undo.splice(0).reverse()) step() }
    try {
      const cleanup = await extension.setup?.(api)
      if (cleanup) undo.push(cleanup)
    } catch (error) {
      teardown()
      throw new Error(`Extension ${extension.name} failed to start: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    // Offered once it's set up: a client that sees `ext:<name>` finds its methods there, and one that fails never shows.
    announced.set(extension.name, manifestOf(extension))
    announce()
    return teardown
  }
  // The core's own, then the bundled ones: for the daemon's life, each giving every thread its agent parts unless the
  // thread goes without it.
  // Before any extension looks for its hidden threads.
  await migrateHidden()
  for (const extension of [...core, ...options.extensions ?? []]) {
    cleanups.push(await setUp(extension, (part, always) => {
      if (always) return { installed: part, undo: installBuiltin(part, extension.name) }
      registry.install(part)
      return { installed: part, undo: () => registry.uninstall(part) }
    }))
    extensions.set(extension.name, aboutOf(extension))
  }
  let unregisterSwitches = registerExtensionSettings(settings, [...extensions.values()])
  /**
   * Extensions a window has whose work is all there (no daemon half): known here as the window declares them, so an
   * optional one has its switch in Settings and a profile can do without it, as with any other. Until a window
   * connects (after a restart), threads aren't told they go without one. Its name is claimed, so no profile's
   * extension takes it. When windows disagree on one, the newest version's word is taken (a new title, now required),
   * whatever order they say it in; never last-come.
   */
  const declared = new Set<string>()
  function declare(abouts: ExtensionAbout[]) {
    let news = false
    for (const about of abouts) {
      const name = about?.name
      if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name) || RESERVED.has(name)) continue
      if (!declared.has(name) && (extensions.has(name) || claimed.has(name))) continue
      const next = aboutOf(about)
      if (next.version !== undefined && !parseVersion(next.version)) continue
      const known = extensions.get(name)
      if (JSON.stringify(known) === JSON.stringify(next)) continue
      // The newest version's word; two words at one version (windows built apart), settled by their text, so the
      // same one stands whatever order the windows connect in.
      if (known && (compareVersion(next.version ?? UNVERSIONED, known.version ?? UNVERSIONED) || (JSON.stringify(next) > JSON.stringify(known) ? 1 : -1)) < 0) continue
      extensions.set(name, next)
      declared.add(name)
      claimed.add(name)
      news = true
    }
    if (!news) return
    unregisterSwitches()
    unregisterSwitches = registerExtensionSettings(settings, [...extensions.values()])
    changed()
  }
  // Turning one off changes what threads go without, and what this machine offers: clients are told both.
  let switches = ''
  settings.onChange(() => {
    const now = JSON.stringify([...extensions.keys()].map((name) => settings.get(`extensions.${name}`)))
    if (now === switches) return
    switches = now
    changed()
    announce()
  })

  // ── Profiles ────────────────────────────────────────────────────────────────────────────────────────────────────

  const profiles = new Map<string, LoadedProfile>()
  /**
   * A profile's daemon extension, set up once however many profiles have it (by its file at one version, `key`: see
   * ProfileDaemonExtension), and torn down when the last of them lets it go. `profiles`: their folders, whose threads
   * its pane kinds are for; `parts`: the agent parts it gave, which each of them selects.
   */
  type Shared = { key: string; file: string; profiles: Set<string>; parts: Extension[]; teardown: () => void }
  const shared = new Map<string, Shared>()
  /** What each loaded profile set up or shares, and how to let go of all of it. */
  const holds = new Map<string, { uses: Shared[]; release: () => void }>()
  /** Profiles' agent parts, installed once by name however many profiles have them, and uninstalled after the last. */
  const installs = new Map<string, number>()
  const install = (part: Extension) => {
    installs.set(part.name, (installs.get(part.name) ?? 0) + 1)
    registry.install(part)
    return () => {
      const left = installs.get(part.name)! - 1
      if (left) return void installs.set(part.name, left)
      installs.delete(part.name)
      registry.uninstall(part)
    }
  }
  /** Profile `dir`'s use of a daemon extension: the one set up already for another profile, else set up now. */
  async function share(item: ProfileDaemonExtension, dir: string) {
    let entry = shared.get(item.key)
    if (!entry) {
      const made: Shared = { key: item.key, file: item.file, profiles: new Set(), parts: [], teardown: () => {} }
      made.teardown = await setUp(item.extension, (part, always) => {
        const named = { ...part, name: `${item.prefix}/${part.name}` }
        const uninstall = install(named)
        if (!always) return { installed: named, undo: uninstall }
        made.parts.push(named)
        return { installed: named, undo: () => { made.parts.splice(made.parts.indexOf(named), 1); uninstall() } }
      }, made.profiles)
      shared.set(item.key, entry = made)
    }
    const used = entry
    used.profiles.add(dir)
    publishViews()
    return {
      entry: used,
      release() {
        used.profiles.delete(dir)
        publishViews()
        if (used.profiles.size) return
        shared.delete(used.key)
        used.teardown()
      },
    }
  }
  /** A profile's agent parts: its own agent extensions, and those its daemon extensions give. */
  const partsOf = (profile: LoadedProfile) => [...profile.extensions, ...(holds.get(profile.dir)?.uses.flatMap((use) => use.parts) ?? [])]
  /** Whether a profile is still as it was loaded: its files, and those of the one it extends, unchanged. */
  const current = (profile: LoadedProfile) =>
    Object.entries(profile.versions).every(([dir, hash]) => { try { return hashProfile(dir) === hash } catch { return false } })
  /** Whether a thread of one of these profiles is mid-run: its profile isn't loaded again under it. */
  const running = (dirs: Set<string>) => [...mounted.values()].some((m) => m.live?.run && m.meta.profile && dirs.has(m.meta.profile.dir))
  /** Let go of everything a profile set up: what it shares stays for the other profiles that have it. */
  function unload(dir: string) {
    holds.get(dir)?.release()
    holds.delete(dir)
    if (profiles.delete(dir)) changed()
  }
  /** Profile loads, one at a time: two never set up the same extension at once, nor an older version last. */
  let loads: Promise<unknown> = Promise.resolve()
  /**
   * A profile as its files are now: loaded again (its extensions torn down and set up again) when they changed, and
   * nothing of it left set up when it's gone, no longer allowed, or broken. Not under a run, though: a thread mid-run
   * keeps the profile it started with, and the change is loaded for its next turn.
   */
  function profileOf(ref: ProfileRef): Promise<LoadedProfile> {
    const cached = profiles.get(ref.dir)
    if (cached && current(cached)) return Promise.resolve(cached)
    const next = loads.then(() => reload(ref))
    loads = next.catch(() => {})
    return next
  }
  async function reload(ref: ProfileRef): Promise<LoadedProfile> {
    const cached = profiles.get(ref.dir)
    if (cached && (current(cached) || running(new Set([ref.dir])))) return cached
    let loaded: LoadedProfile
    try {
      if (!existsSync(join(ref.dir, 'profile.ts'))) throw new RpcError('not_found', `No profile ${ref.name} at ${ref.dir}`)
      loaded = await loadProfile(ref, userProfiles, trust)
    } catch (error) {
      unload(ref.dir)
      throw error
    }
    // Another version of a file it has, set up for other profiles too: they let go of it, and load this one next time.
    const others = new Set([...shared.values()]
      .filter((use) => loaded.daemon.some((d) => d.file === use.file && d.key !== use.key))
      .flatMap((use) => [...use.profiles]).filter((dir) => dir !== ref.dir))
    if (running(others)) {
      if (cached) return cached
      throw new RpcError('busy', `Profile ${ref.name} has an extension a running thread has another version of`, { hint: 'Try again once it finishes.' })
    }
    unload(ref.dir)
    for (const dir of others) unload(dir)
    // Everything it sets up is undone together: when a later step fails too, so a fixed profile can load again.
    const uses: Shared[] = []
    const undo: (() => void)[] = []
    const release = () => { for (const step of undo.splice(0).reverse()) step() }
    try {
      for (const item of loaded.daemon) {
        const { entry, release } = await share(item, ref.dir)
        uses.push(entry)
        undo.push(release)
      }
      for (const extension of loaded.extensions) undo.push(install(extension))
    } catch (error) {
      release()
      throw new RpcError('invalid', `Profile ${ref.name}: ${(error as Error).message}`)
    }
    holds.set(ref.dir, { uses, release })
    profiles.set(ref.dir, loaded)
    // What its threads go without may have changed with it.
    changed()
    for (const name of loaded.spec.without ?? []) {
      const known = extensions.get(name)
      if (!known) console.warn(`Profile ${ref.name}: without ${name}, which isn't an extension here`)
      else if (known.required) console.warn(`Profile ${ref.name}: ${name} is required, and can't be done without`)
    }
    return loaded
  }

  /**
   * What a turn runs with: the thread's own choices, else what an extension chose for it (`agentFor`: Ego's), else its
   * profile's, else this machine's settings. `id` is unset for a thread being made.
   */
  async function agentOf(id: string | undefined, meta: ThreadMeta) {
    const profile = meta.profile ? await profileOf(meta.profile) : undefined
    const { choice, without } = choiceAndWithout(id, meta, profile)
    const { model, thinkingLevel } = agent.resolve({
      model: meta.model ?? choice?.model ?? profile?.spec.model, thinking: meta.thinking ?? choice?.thinking ?? profile?.spec.thinking,
    })
    // Only parts its own extension gave with `always: false`.
    const chosen = (choice?.extensions ?? []).map((part) => chosenParts.get(choice!.by)?.get(part) ?? console.warn(`agentFor of ${choice!.by} chose ${part.name}, which it doesn't give with agent(part, { always: false })`)).filter((part) => part !== undefined)
    const extensions = [...partsFor(without), ...chosen, ...(profile ? partsOf(profile) : [])]
    // Always said, never left as it was: instructions a chooser gave go when it no longer answers.
    const instructions = choice?.instructions ?? (profile?.spec.prompt || null)
    return { model, thinkingLevel, extensions, instructions, without }
  }

  /**
   * Send `text` to a thread, with the model and thinking it chose, else what this machine's settings say now. `by`: the
   * extension sending it (`threads.submit`, `threads.create`'s prompt); none for a client's (a window, the command line).
   */
  async function submit(id: string, text: string, requestId: string, whenBusy?: 'steer' | 'followUp', attachments: Attachment[] = [], by?: string) {
    if (!text.trim() && !attachments.length) throw new RpcError('invalid', 'Nothing to send')
    const m = await get(id)
    // Put away: it can be read, not written to, until it's brought back.
    if (m.meta.archived) throw new RpcError('archived', 'This thread is archived', { hint: 'Unarchive it to send to it.' })
    // Its profile loaded first, for what the thread goes without.
    const { model, thinkingLevel, without, ...rest } = await agentOf(id, m.meta)
    // An extension's own thread runs as that extension makes it, or not at all: not while it's off here, or the thread
    // goes without it.
    if (m.meta.owner && (!features().includes(`ext:${m.meta.owner}`) || without.has(m.meta.owner))) throw new RpcError('invalid', `This thread is the ${m.meta.owner} extension's, which is off here`)
    if (!model) throw new RpcError('no_model', 'No model is available', { hint: 'Sign in to a provider in Settings.' })
    await m.conversation.configure({ model, thinkingLevel: thinkingLevel ?? null, ...rest }, context)
    if (!m.meta.title) await updateMeta(id, (meta) => { meta.title = titleOf(text.trim() || attachments.map((a) => a.name).join(', ')) })
    const content = await transformed(id, m, { text, attachments, ...(by ? { by } : {}) }, await contentOf(id, text, attachments))
    const submission = await m.conversation.submit({ type: 'input', content, requestId, ...(whenBusy ? { whenBusy } : {}) }, context)
    return String(submission.id)
  }

  /**
   * A message's content as extensions' submit transforms leave it (a skill it names brought along, say): each in turn,
   * those of extensions the thread goes without skipped, and a profile's for its own threads only. Untouched, it's sent
   * as it came.
   */
  async function transformed(id: string, m: Mounted, message: Pick<OutgoingMessage, 'text' | 'attachments' | 'by'>, content: string | MessageBlock[]) {
    const without = withoutOf(id, m.meta, m.meta.profile && profiles.get(m.meta.profile.dir))
    const applying = transforms.filter((t) => !without.has(t.owner) && (!t.profiles || (m.meta.profile && t.profiles.has(m.meta.profile.dir))))
    if (!applying.length) return content
    const thread = info(id, m)
    let blocks: MessageBlock[] = typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : content
    let touched = false
    for (const { transform } of applying) {
      // A copy: only what it returns counts, whether the message came as text or as blocks.
      const next = await transform({ thread, ...message, content: [...blocks] })
      if (next) { blocks = next; touched = true }
    }
    return touched ? blocks : content
  }

  /**
   * A message's content with its attachments: each file saved under attachments/<thread>/ on this machine and named to
   * the agent by its path (a small text file inline too), images also given to the model as images.
   */
  /** Where a thread's files are kept on this machine: its attachments, and the images it showed. */
  function attachmentsOf(id: string) { return join(options.dataDir, 'attachments', id) }
  /** A file of a thread's that clients may read: in its folder, or among the files it keeps (attachments, images it showed). */
  function threadFile(cwd: string, id: string, path: string) {
    const kept = isAbsolute(path) && resolvePath(path).startsWith(`${attachmentsOf(id)}/`)
    return kept ? resolvePath(path) : editable(cwd, path)
  }
  /**
   * A file of a thread's that clients may edit: in its folder, or the app's layout (`layout.json` in the data folder,
   * which the desktop app on this computer keeps: Edit layout… opens it beside any thread here).
   */
  function editable(cwd: string, path: string) {
    const layout = join(options.dataDir, 'layout.json')
    return isAbsolute(path) && resolvePath(path) === layout ? layout : inFolder(cwd, path)
  }

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
    params: obj({
      cwd: opt(str()), title: opt(str()), model: opt(str()), thinking: opt(str()), prompt: opt(str()), attachments: opt(arr(ATTACHMENT)), profile: opt(str()),
      worktree: opt(bool()), parent: opt(str()), options: opt(obj({}, { open: true })),
    }),
    run: (params) => startThread(params as NewThread),
  }))
  /**
   * A new thread as asked for: where, with what; a child of `parent` when a thread starts it (top-level when that one is
   * hidden, an extension's own); `hidden`, in no list and the extension's of that name. Extensions' `creating` hooks
   * may move it (a worktree) and give it state.
   */
  async function startThread({ cwd, title, model: ownModel, thinking, prompt, attachments, profile: profileName, worktree, parent, options: asked, hidden, by }: NewThread & { hidden?: string; by?: string }) {
    const dir = cwd?.trim() ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : defaultCwd
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new RpcError('invalid', `No folder ${dir} on ${machine.hostname}`)
    if (ownModel && !agent.catalog().models.some((m) => m.value === ownModel)) throw new RpcError('invalid', `No model ${ownModel} here; sign in to its provider first`)
    if (parent && (await get(parent)).meta.hidden) parent = undefined
    // The project's profile (or the user's) of that name, else the default one there is; checked (and allowed) now.
    // None for an extension's own thread: it runs as that extension makes it, whatever profiles say.
    const ref = hidden ? undefined : findProfile(dir, userProfiles, profileName?.trim() || undefined)
    const loaded = ref ? await profileOf(ref) : undefined
    // Its session is the project; where in it it works is the folder given, unless a hook moves it.
    const checkout = await checkoutOf(dir)
    const draft: ThreadDraft = {
      cwd: dir, root: checkout?.root ?? dir, ...(checkout ? { checkout } : {}), title: title?.trim() ?? '',
      ...(prompt ? { prompt } : {}), ...(parent ? { parent } : {}), ...(ref && loaded ? { profile: { ref, spec: loaded.spec } } : {}),
      // Its profile's, then what it was started with: `worktree` the shorthand for `worktrees`, in both.
      options: {
        ...clone(loaded?.spec.options), ...(loaded?.spec.worktree !== undefined ? { worktrees: loaded.spec.worktree } : {}),
        ...(worktree !== undefined ? { worktrees: worktree } : {}), ...clone(asked),
      },
    }
    const ext: Record<string, Json> = {}
    const meta = { ...(ref ? { profile: ref } : {}) } as ThreadMeta
    const off = switchedOff(loaded)
    // The hooks that took part, to undo what they did (`abandoned`, in reverse) if the thread isn't made after all.
    const took: (typeof threadHooks)[number][] = []
    let id: string
    try {
      for (const hook of threadHooks) {
        if (!hook.value.creating || !appliesTo(hook, off, meta)) continue
        let made: ThreadCreating | void
        try {
          made = await hook.value.creating(clone(draft))
        } catch (error) {
          throw refusal(hook.owner, error)
        }
        took.push(hook)
        if (made?.cwd) draft.cwd = made.cwd
        if (made?.state !== undefined) ext[hook.owner] = clone(made.state)
      }
      id = await createThread({
        title: draft.title, cwd: draft.cwd, createdAt: Date.now(), root: draft.root, ...(Object.keys(ext).length ? { ext } : {}),
        ...(ownModel ? { model: ownModel } : {}), ...(thinking ? { thinking } : {}), ...(ref ? { profile: ref } : {}), ...(parent ? { parent } : {}),
        ...(hidden ? { hidden: true, owner: hidden } : {}),
      })
    } catch (error) {
      for (const hook of took.reverse()) {
        try {
          await hook.value.abandoned?.(clone(draft), clone(ext[hook.owner]))
        } catch (undoing) {
          console.error(`Extension ${hook.owner}: abandoned failed:`, undoing)
        }
      }
      throw error
    }
    // Made: a first message that fails (no model yet) leaves it made, and says why.
    if (prompt?.trim() || attachments?.length) await submit(id, prompt ?? '', randomUUID(), undefined, attachments, by)
    return info(id, await get(id))
  }
  /** A new thread with `meta`: its id, once extensions were told it's there (`created`). */
  async function createThread(meta: ThreadMeta) {
    const { model, thinkingLevel } = await agentOf(undefined, meta)
    const conversation = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), cwd: meta.cwd },
      init: async (tx, created) => {
        Object.assign(await tx.doc(ThreadDoc, created), meta)
        ;(await tx.doc(Catalog)).ids.push(created)
      },
    }, context)
    await mount(conversation.id)
    changed()
    await tell('created', String(conversation.id))
    return String(conversation.id)
  }
  /**
   * Start a thread over (`threads.clear`): stopped, then a new context, so the model sees nothing before it, and the
   * transcript starts after it. Windows showing it watch again, from there: a watch that ends `stopped` is watched again.
   */
  async function clear(id: string) {
    const m = await get(id)
    await m.conversation.abort(context)
    await m.conversation.reset(undefined, context)
    await m.conversation.waitForIdle(context)
    const last = (await m.conversation.entries({ order: 'descending' }, 1, undefined, context)).items[0]?.id
    await updateMeta(id, (meta) => {
      meta.cleared = Number(last ?? 0) + 1
      meta.seen = last === undefined ? {} : { entryId: Number(last) }
      delete meta.panes
      delete meta.pane
    })
    for (const stop of transcriptWatches.get(id) ?? []) void stop()
  }
  /**
   * Hidden threads from before extensions made them: Ego's, kept apart in the catalog (`ego`), or older, listed and
   * marked `meta`. Each becomes a hidden thread of the ego extension, which takes one up and leaves the rest. Remove
   * with LEGACY (and the catalog's `ego`), once databases from before (2026-11) are no longer opened (MIGRATIONS'
   * `hidden-threads`).
   */
  async function migrateHidden() {
    const catalog = await harness.snapshot(Catalog, context)
    const marked: number[] = []
    for (const id of catalog?.ids ?? []) {
      const meta = await harness.snapshot(ThreadDoc, id as ConversationId, context)
      if (meta?.meta && !meta.hidden) marked.push(id)
      // An extension's own thread made with the user's default profile, as one was for a while: it has none now.
      if (meta?.owner && meta.profile) {
        await (await harness.conversation(id as ConversationId, context))?.commit(async (tx) => { delete (await tx.doc(ThreadDoc, id as ConversationId)).profile }, context)
      }
    }
    const kept = catalog?.ego
    if (kept === undefined && !marked.length) return
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Catalog)
      if (doc.ego !== undefined && !doc.ids.includes(doc.ego)) doc.ids = [...doc.ids, doc.ego].sort((a, b) => a - b)
      delete doc.ego
    }, context)
    for (const id of [...marked, ...(kept === undefined ? [] : [kept])]) {
      await (await harness.conversation(id as ConversationId, context))?.commit(async (tx) => {
        const meta = await tx.doc(ThreadDoc, id as ConversationId)
        meta.hidden = true
        meta.owner = 'ego'
      }, context)
    }
  }
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
    id: 'thread.withdraw', title: 'Take back a message waiting its turn', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str(), submission: str() }),
    // Gone in already (or settled), it stays: only what still waits can be taken back.
    async run({ id, submission }) {
      await get(id)
      await harness.abortSubmission(Number(submission) as SubmissionId, context, Number(id) as ConversationId)
      return null
    },
  }))
  router.register(defineAction({
    id: 'thread.archive', title: 'Archive the thread', runs: 'machine', expose: ['ui', 'cli'], keys: 'mod+shift+e', ...thread,
    params: obj({ id: str() }),
    async run({ id }) {
      const { notes } = await archive(id)
      // `worktree`: what a window older than `notes` reads, from the worktrees extension's facts (the alias
      // 'thread.archive:worktree').
      const worktree = info(id, await get(id)).ext?.worktrees as { removed?: boolean } | undefined
      return { notes, worktree: worktree ? (worktree.removed ? 'removed' as const : 'kept' as const) : null }
    },
  }))
  /**
   * Put a thread away, unless an extension's `archiving` refuses; then its `archived` hooks clean up (a worktree, say).
   * Says what the extensions did, each in a line of its own (`notes`).
   */
  async function archive(id: string): Promise<{ notes: ArchiveNotes }> {
    const notes: ArchiveNotes = {}
    // Already away: nothing for the hooks to see.
    if (!(await get(id)).meta.archived) {
      await withProfile(id)
      await ask('archiving', id, notes)
      // Cleaned up before clients see it archived: never shown put away with its worktree still there.
      await tell('archived', id, { archived: true }, notes)
      await updateMeta(id, (m) => { m.archived = true; delete m.archiveWhenDone })
    }
    return { notes }
  }
  /** Bring a thread back, unless an extension's `unarchiving` refuses (or can't put back its worktree). */
  async function unarchive(id: string) {
    if (!(await get(id)).meta.archived) return
    await withProfile(id)
    await ask('unarchiving', id)
    await updateMeta(id, (m) => { delete m.archived; delete m.archiveWhenDone })
    await tell('unarchived', id)
  }
  /**
   * Archive a thread once its run ends: how a thread archives itself, mid-turn, without its worktree going from under
   * the turn or the turn being cut short. Kept in its metadata, so a restart in between still archives it.
   */
  async function archiveWhenDone(id: string) {
    await updateMeta(id, (m) => { m.archiveWhenDone = true })
    archiveIfDone(id, await get(id))
  }
  function archiveIfDone(id: string, m: Mounted) {
    if (!m.meta.archiveWhenDone || m.meta.archived || m.live?.run || archiving.has(id)) return
    archiving.add(id)
    // What it did, or that it was refused (an extension's `archiving`) or failed and given up: said in the thread, where
    // the agent said it would be archived. Its turn is over, so there's no one else to tell.
    void archive(id).then(async ({ notes }) => {
      const said = Object.values(notes)
      if (said.length) await note(id, `Archived. ${said.join(' ')}`)
    }, async (error) => {
      await updateMeta(id, (meta) => { delete meta.archiveWhenDone })
      await note(id, `Couldn't archive this thread: ${error instanceof Error ? error.message : String(error)}`)
    }).catch((error) => console.error(`Couldn't archive thread ${id}:`, error)).finally(() => archiving.delete(id))
  }
  /** A line in a thread's transcript from Superego itself, not the agent's (`superego.note`): for the user, not the model. */
  async function note(id: string, text: string) {
    await (await get(id)).conversation.submit({ type: 'write', entry: { kind: NOTE_ENTRY, data: { text } } }, context)
  }
  router.register(defineAction({
    id: 'thread.unarchive', title: 'Unarchive the thread', runs: 'machine', expose: ['ui', 'cli'], ...thread,
    params: obj({ id: str() }),
    async run({ id }) { await unarchive(id); return null },
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
      const file = editable((await get(id)).meta.cwd, path)
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
    id: 'auth.retry', title: 'Retry the threads waiting for sign-in', runs: 'machine', expose: ['ui', 'cli'],
    params: obj({ provider: opt(str()) }),
    async run({ provider }) { return { retried: await retrySignIn(provider) } },
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

  // Mount everything once so statuses (and anything a previous process left running) are live from the start.
  await list()
  await list({ hidden: true })
  // A run cut off by the last stop resumes where it was, maybe inside a profile's tool: its profile is loaded first, so
  // the tool is there to carry on with (a profile that no longer loads leaves the run to end as interrupted).
  for (const m of mounted.values()) {
    if (m.live?.run && m.meta.profile) await profileOf(m.meta.profile).catch((error: Error) => console.error(`Profile ${m.meta.profile!.name}: ${error.message}`))
  }
  harness.resume()
  // Waiting on threads gone since (deleted, say) no longer; a provider whose credentials changed while the daemon was
  // down is retried. Then the value says which are rejected, as it keeps saying.
  for (const rejection of agent.rejections.all()) for (const id of Object.keys(rejection.threads)) if (!mounted.has(id)) agent.rejections.release(id)
  for (const provider of agent.changedSinceRejected()) void retrySignIn(provider)
  publishRejected()
  listListeners.add(publishRejected)
  cleanups.push(agent.rejections.onChange(changed), agent.onCredentials((provider) => void retrySignIn(provider)))
  // The profiles of the threads in use, loaded in the background: their facts and what they go without show without
  // waiting for a turn. An archived thread's load when it's brought back.
  const loadingProfiles = (async () => {
    const refs = new Map([...mounted.values()].filter((m) => !m.meta.archived && m.meta.profile).map((m) => [m.meta.profile!.dir, m.meta.profile!]))
    for (const ref of refs.values()) await profileOf(ref).catch((error: Error) => console.error(`Profile ${ref.name}: ${error.message}`))
  })()


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
          return { version: PROTOCOL_VERSION, ...offer(), api: EXTENSION_API, machine, methods: [...Object.keys(handlers), ...router.list().map((a) => a.id), ...methods.keys()] }
        },
        'thread.list': ({ archived }: { archived?: boolean } = {}) => list({ archived: Boolean(archived) }),
        'agent.models': async () => agent.catalog(),
        'file.read': async ({ id, path, base64 }: { id: string; path: string; base64?: boolean }) => {
          const file = threadFile((await get(id)).meta.cwd, id, path)
          const info = await stat(file).catch(() => undefined)
          if (!info?.isFile()) throw new RpcError('not_found', `No file ${path}`)
          if (info.size > 16 * 1024 * 1024) throw new RpcError('too_large', `${path} is larger than 16 MB`)
          return { path: file, content: await readFile(file, base64 ? 'base64' : 'utf8'), mtimeMs: info.mtimeMs, size: info.size }
        },
        // Which version of each file there is, without its bytes: what the window checks its images against. A path
        // file.read wouldn't read, or no file, is null.
        'file.stat': async ({ id, paths }: { id: string; paths: string[] }) => {
          const { cwd } = (await get(id)).meta
          return {
            files: await Promise.all(paths.map(async (path) => {
              const info = await Promise.resolve().then(() => stat(threadFile(cwd, id, path))).catch(() => undefined)
              return info?.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null
            })),
          }
        },
        'file.find': async ({ id, name }: { id: string; name: string }) => locate((await get(id)).meta.cwd, name),
        // A profile's UI is its code too: served only for a real profile folder, and only once it is allowed.
        'profile.ui': async (ref: ProfileRef) => {
          // One that was loaded and is gone now is let go of (profileOf), and the window's UI of it with it.
          const known = profiles.get(ref.dir)
          if (!isProfileDir(ref, userProfiles) && !known) throw new RpcError('not_found', `No profile at ${ref.dir}`)
          const loaded = await profileOf(known ? { scope: known.scope, name: known.name, dir: known.dir } : { scope: ref.scope, name: ref.name, dir: ref.dir })
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
        async 'threads.watch'({ hidden = false }: { hidden?: boolean } = {}) {
          const sub = randomUUID()
          let last = ''
          const push = async () => {
            const value = await list({ hidden: Boolean(hidden) })
            const json = JSON.stringify(value)
            if (json !== last) { last = json; notify('threads.changed', { sub, value }) }
          }
          listListeners.add(push)
          subs.set(sub, () => { listListeners.delete(push) })
          const value = await list({ hidden: Boolean(hidden) })
          last = JSON.stringify(value)
          return { sub, value }
        },
        'settings.watch': serveSettings(settings, (params) => notify('settings.changed', params), subs)['settings.watch'],
        async 'file.watch'({ id, path }: { id: string; path: string }) {
          const file = editable((await get(id)).meta.cwd, path)
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
        'value.watch': ({ key }: { key: string }) => watchValue(key, (sub, value) => notify('value.changed', { sub, key, value })),
        // Watches that moved into an extension's value, under their old names and notifications.
        ...Object.fromEntries(Object.entries(MOVED_WATCHES).map(([method, { value: key, event }]) =>
          [method, () => watchValue(key, (sub, value) => peer.notify(event, { sub, value }))])),
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
          router.dispatch(router.has(id) ? id : MOVED_METHODS[id] ?? id, params, { notify, source: client }, { source: exposure ?? client, ...(exposure ? { exposure } : {}) }),
        /** The newest dispatches on this machine, oldest first. */
        'action.log': async () => router.log(),
        /** The window's extensions, as each declares itself: those without a daemon half become known here (see declare). */
        'extensions.declare': async ({ extensions: abouts }: Methods['extensions.declare']['params']) => { declare(Array.isArray(abouts) ? abouts : []); return null },
      }
      /** A live value, then `tell` with each new one, until unwatched. */
      function watchValue(key: string, tell: (sub: string, value: Json) => void) {
        const entry = valueOf(key)
        const sub = randomUUID()
        const listener = (value: Json) => tell(sub, value)
        entry.listeners.add(listener)
        subs.set(sub, () => { entry.listeners.delete(listener); prune(key) })
        return { sub, value: entry.value }
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
        const name = router.has(method) || methods.has(method) ? method : MOVED_METHODS[method] ?? method
        if (router.has(name)) return open(method, (params) => router.dispatch(name, params, ctx(), { source: client }))
        const read = methods.get(name)
        return read && open(method, read)
      })
      return () => {
        connections.delete(peer)
        for (const stop of subs.values()) void stop()
        subs.clear()
      }
    },
    async close() {
      await loadingProfiles
      await webQueue
      await web?.close()
      for (const cleanup of cleanups.reverse()) cleanup()
      agent.close()
      for (const m of mounted.values()) await m.stop()
      await harness.close(context)
      await agent.rejections.saved()
    },
  }

  // ── Web access ──────────────────────────────────────────────────────────────────────────────────────────────────

  const webDevices = await WebDevices.open(options.dataDir)
  let web: WebServer | undefined
  let webKey = ''
  let webError: string | undefined
  /** Tailscale serve: how setting it up went, and while it serves, what requests through it look like. */
  let tailscale: TailscaleState | undefined
  let served: Omit<ServedByTailscale, 'pairOwner' | 'nodeAt'> & { port: number } | undefined
  let names: { at: number; map: Map<string, string> } = { at: 0, map: new Map() }
  const nodeAt = async (address: string) => {
    if (!names.map.has(address) && Date.now() - names.at > 30_000) names = { at: Date.now(), map: await tailnetNames() }
    return names.map.get(address)
  }
  const pairOwner = () => settings.get<boolean>('web.tailscale.pairing') === true
  /** Serve (or stop serving) browsers as the Web access settings say, whenever they change; one change at a time. */
  let webQueue = Promise.resolve()
  const applyWeb = () => (webQueue = webQueue.then(applyWebNow, applyWebNow))
  const applyWebNow = async () => {
    const access = settings.get<string>('web.access') ?? 'off'
    const port = settings.get<number>('web.port') ?? 7777
    if (access !== 'off') await webDevices.setNotice(undefined)
    const key = access === 'off' || !options.webRoot ? '' : `${access}:${port}`
    if (key === webKey) return
    webKey = key
    if (served) await stopServe(served.port)
    served = undefined
    tailscale = undefined
    await web?.close()
    web = undefined
    webError = undefined
    if (key) {
      try {
        web = await serveWeb({ root: options.webRoot!, port, devices: webDevices, serve: daemon.serve,
          tailscale: () => served && { ...served, pairOwner: pairOwner(), nodeAt },
          artifact: async (thread, path) => readFile(inFolder((await get(thread)).meta.cwd, path)) })
      } catch (error) {
        webError = (error as Error).message
      }
      if (web && access === 'tailscale') {
        tailscale = { state: 'starting' }
        settings.invalidate()
        const prefix = `.tailscale-${randomUUID()}`
        const port = web.port
        tailscale = await startServe(port, prefix)
        if (tailscale.state === 'serving') served = { prefix, name: tailscale.name, ...(tailscale.owner ? { owner: tailscale.owner } : {}), port }
      }
    }
    settings.invalidate()
  }
  const webAddress = () => tailscale?.state === 'serving' ? tailscale.url : web?.url
  /** The devices list: paired devices, and the owner's own through Tailscale while those get in without pairing. */
  const webDeviceList = () => webDevices.list().filter((d) => !d.tailscale || (served && !pairOwner()))
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
    description: 'Use this machine from a browser or a phone: it serves the app and its threads to the devices you pair.',
    settings: [
      { key: 'web.access', title: 'Serve the app', default: 'off', type: { type: 'choice', options: [
        { value: 'off', label: 'Off' }, { value: 'local', label: 'To this computer' }, { value: 'tailscale', label: 'Over Tailscale' },
      ] }, disabled: () => options.webRoot ? undefined : 'This daemon has no web app to serve.' },
      { key: 'web.port', title: 'Port', default: 7777, type: { type: 'number', min: 1024, max: 65535, step: 1 } },
      { key: 'web.tailscale.pairing', title: 'Require pairing for my Tailscale login too', default: false, type: { type: 'boolean' },
        description: 'Otherwise your own devices on the tailnet get in without pairing.', hidden: () => settings.get('web.access') !== 'tailscale' },
    ],
    data: () => ({
      url: webAddress() ?? null, tailscale: tailscale ?? null, devices: webDeviceList(),
      notice: webDevices.notice ?? null, error: webError ?? null,
    }),
  })
  // Serving the local network (plain HTTP, one token) is gone: a machine that did is off now, and Settings says why.
  if (settings.get('web.access') === 'network') {
    await settings.reset('web.access')
    await webDevices.setNotice('Serving the local network over plain HTTP is gone: use Tailscale to reach this machine from other devices.')
  }
  webDevices.onChange(() => settings.invalidate())
  // Pairing switched on for the owner's login: their devices through Tailscale get in no more, as of now.
  let pairingOwner = pairOwner()
  settings.onChange(() => {
    if (pairOwner() !== pairingOwner && (pairingOwner = pairOwner())) web?.disconnect((id) => id.startsWith('tailscale:'))
  })
  const webOn = () => { if (!web) throw new RpcError('web_off', 'Web access is off: turn it on in Settings → Web access.') }
  router.register(defineAction({
    id: 'web.pair', title: 'Pair a device for web access', runs: 'machine', expose: ['ui', 'cli'], params: obj({}),
    async run() {
      webOn()
      const { ticket, code, expires } = webDevices.pair()
      return { link: `${webAddress()}/#pair=${ticket}`, code, expires }
    },
  }))
  router.register(defineAction({
    id: 'web.devices', title: 'List the devices paired for web access', runs: 'machine', expose: ['ui', 'cli'], params: obj({}),
    run: async () => webDeviceList(),
  }))
  router.register(defineAction({
    id: 'web.revoke', title: 'Unpair a device', runs: 'machine', expose: ['ui', 'cli'], params: obj({ id: str() }),
    async run({ id }) {
      if (id.startsWith('tailscale:')) throw new RpcError('invalid', 'Your own Tailscale login is let in as a whole: require pairing for it instead.')
      if (!(await webDevices.revoke(id))) throw new RpcError('not_found', `No device ${id}`)
      return null
    },
  }))
  router.register(defineAction({
    id: 'web.rename', title: 'Rename a paired device', runs: 'machine', expose: ['ui', 'cli'], params: obj({ id: str(), name: str() }),
    async run({ id, name }) {
      const device = await webDevices.rename(id, name)
      if (!device) throw new RpcError('not_found', `No device ${id}`)
      return device
    },
  }))
  settings.onChange(() => void applyWeb())
  await applyWeb()
  return daemon
}
