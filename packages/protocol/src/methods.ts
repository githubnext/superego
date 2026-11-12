// The daemon's public method table. One place names every method, its params and its result; the daemon's dispatch,
// the typed client and (later) the CLI and schema are derived from it.
import type { ConversationView } from '@earendil-works/pi-durable'
import type { ActionInfo, ActionLogEntry, Exposure } from './actions.ts'
import type { AuthEvent, Json, SettingsSnapshot } from './settings.ts'
import type { Status } from './status.ts'

/**
 * The protocol's generation. It changes only for a break no feature flag can bridge; a daemon and client of different
 * generations refuse each other. Everything else is additive and announced in `FEATURES`.
 */
export const PROTOCOL_VERSION = 1

/**
 * What a daemon of this build offers, announced in `hello`. Clients check a feature before using it, so an older
 * daemon on another machine keeps working with a newer app (and the other way round) for whatever both know.
 */
export const FEATURES = ['threads', 'settings', 'auth', 'restart', 'restart-env', 'actions'] as const
export type Feature = (typeof FEATURES)[number]

export type ThreadId = string

export type ThreadInfo = {
  id: ThreadId
  title: string
  cwd: string
  createdAt: number
  /** When anything last happened in it: a message, or work going on. Absent from older daemons. */
  activeAt: number
  /** The model its next turn runs with. */
  model?: string
  /** Whether it chose its own model and thinking, rather than following the machine's settings. */
  ownModel?: boolean
  /** The model (`provider/model`) and thinking it chose itself, rather than following its profile or the machine's settings. */
  chosen?: { model?: string; thinking?: string }
  /** What it has spent so far, in dollars, as the providers price it. */
  cost?: number
  /** The panes open beside it, and the one in front (none: the thread itself). */
  panes?: Pane[]
  pane?: string
  /** The profile it runs with: one of the project's, or one of the user's. Absent: plain Superego. */
  profile?: ProfileRef
  /** The session it belongs to, on its machine: a project, by the folder it lives in (a repository's main checkout). */
  session: { root: string; name: string }
  /** The thread that started it, if one did (an agent's thread_start, say): it shows nested under that one. */
  parent?: ThreadId
  /** Its own git worktree, when it has one; `removed` once archiving took it away (its branch stays). */
  worktree?: { path: string; branch: string; removed?: boolean }
  /** Put away: listed only with `archived`, readable, and taking no messages until unarchived. */
  archived?: boolean
  /** The machine's own agent, about Superego itself: setting up machines, projects, profiles, skills (see `thread.meta`). */
  meta?: boolean
  status: Status
}

/** `id` is the machine's identity: stable across restarts and routes, so a client can tell it is the same machine. */
/** The models a machine can run, and the default a new thread gets there. */
export type ModelCatalog = {
  models: { value: string; label: string; group: string; thinking: string[] }[]
  default: { model?: string; thinking: string | null }
}

/** What a new thread starts with. Unset: this machine's defaults. */
/**
 * A pane: a view beside a thread (a diff, an editor, a preview, a profile's graph, another thread). `kind` names what
 * draws it; `params` are its own. Kept with the thread, so it follows the thread to every client.
 */
export type Pane = { id: string; kind: string; title?: string; params?: Json }

/** A profile: the user's (`~/.superego/profiles/<name>`) or a project's (`.superego/profiles/<name>`), and its folder. */
export type ProfileRef = { name: string; scope: 'user' | 'project'; dir: string }
/** A profile a thread in some folder could start with (see the daemon's profiles.ts). */
export type ProfileInfo = ProfileRef & { description?: string; allowed: boolean }

/** A file sent with a message: images go to the model as images; any file is saved on the thread's machine. */
export type Attachment = { name: string; mimeType: string; /** Base64. */ data: string }

export type NewThread = {
  cwd?: string
  title?: string
  /** `provider/model`, for this thread's turns from now on. */
  model?: string
  /** A thinking level, or `off`. */
  thinking?: string
  /** A first message, sent right away. */
  prompt?: string
  /** Files sent with the first message. */
  attachments?: Attachment[]
  /** In a git repository: a worktree of its own, rather than the checkout (its profile's choice when unset; else no). */
  worktree?: boolean
  /** The profile to run with; unset takes the folder's default (the project's, else the user's). */
  profile?: string
  /** The thread starting it, on the same machine. */
  parent?: string
}

export type MachineInfo = {
  id: string; hostname: string; platform: string; pid: number; dataDir: string
  /** The build of the code this daemon runs (see `readBuild`); clients compare it with what is on disk now. */
  build: string
}

export type Hello = { version: number; features: string[]; machine: MachineInfo; methods: string[] }

export type Methods = {
  hello: { params: { client: string; version: number; features?: string[] }; result: Hello }
  /** The threads, newest first; `archived` lists the ones put away instead. */
  'thread.list': { params: { archived?: boolean }; result: ThreadInfo[] }
  'thread.create': { params: NewThread; result: ThreadInfo }
  'agent.models': { params: {}; result: ModelCatalog }
  /** A file in a thread's folder (not outside it), as text. */
  'file.read': { params: { id: ThreadId; path: string; base64?: boolean }; result: { path: string; content: string } }
  /** A file in a thread's folder, then `file.changed` whenever it changes on disk (by anyone), until unwatched. */
  'file.watch': { params: { id: ThreadId; path: string }; result: { sub: string; content: string | null } }
  /** A file in a thread's folder by the name a link gives it ([[Note]], Note.md, path/Note): its path, or null. */
  /**
   * What a path a message names points at in a thread's folder: a file (or a note by its name), or a `folder` (`''` the
   * folder itself), with the `line` it names. `path` is null when there's nothing, `outside` when it's past the folder.
   */
  'file.find': { params: { id: ThreadId; name: string }; result: { path: string | null; folder?: boolean; line?: number; outside?: boolean } }
  /** The skills on this machine (`~/.agents/skills`), which a message names as `$name` or `/skill:name`. */
  'skill.list': { params: {}; result: { name: string; description: string }[] }
  /** What changed in a thread's folder, by git: the unified diff against HEAD, and files git doesn't track yet. */
  'thread.diff': { params: { id: ThreadId }; result: { diff: string; untracked: string[]; repo: boolean } }
  /** A profile's UI extensions: their entry modules, and a hash that changes when any of its files do. */
  'profile.ui': { params: ProfileRef; result: { hash: string; entries: string[] } }
  /** One module of a profile's UI, as JavaScript (types stripped); its own imports are left for the window to load. */
  'profile.module': { params: ProfileRef & { path: string }; result: { path: string; code: string } }
  'thread.rename': { params: { id: ThreadId; title: string }; result: null }
  'thread.submit': { params: { id: ThreadId; text: string; attachments?: Attachment[]; requestId?: string; whenBusy?: 'steer' | 'followUp' }; result: { submission: string } }
  'thread.abort': { params: { id: ThreadId }; result: null }
  /** The user looked at the thread: its done/error status clears. */
  'thread.seen': { params: { id: ThreadId }; result: null }
  /** Snapshot of the conversation view, then `watch.ops` notifications with Chord delta ops against it. */
  /** Entries older than `before` (an entry id), oldest first: scrolling back past a watch's window. */
  'thread.history': { params: { id: ThreadId; before: number; limit?: number }; result: { entries: unknown[]; more: boolean } }
  'thread.watch': { params: { id: ThreadId }; result: { sub: string; value: ConversationView } }
  /** Snapshot of the thread list, then `threads.changed` notifications with the whole list. */
  'threads.watch': { params: {}; result: { sub: string; value: ThreadInfo[] } }
  unwatch: { params: { sub: string }; result: null }

  /** Snapshot of every section and value, then `settings.changed` with the whole snapshot. */
  'settings.watch': { params: {}; result: { sub: string; value: SettingsSnapshot } }
  'settings.set': { params: { key: string; value: Json }; result: null }
  /** Start a sign-in. It reports through `auth.event`; prompts are answered with `auth.respond`. */
  'auth.login': { params: { provider: string; type: 'api_key' | 'oauth'; key?: string }; result: { flow: string } }
  'auth.respond': { params: { flow: string; prompt: string; value: string }; result: null }
  'auth.cancel': { params: { flow: string }; result: null }
  'auth.logout': { params: { provider: string }; result: null }

  /**
   * Restart onto newer code: the daemon exits and the client starts the new one. Refused (`restarted: false`) while a
   * thread is working, unless `interrupt`; interrupted runs resume after the restart. `build` must be the running
   * build, so a client never restarts a daemon it didn't inspect.
   */
  /** Snapshot of an extension's live value, then `value.changed` with each new one. */
  'value.watch': { params: { key: string }; result: { sub: string; value: Json } }
  /** Every action on this machine, as data. */
  'action.list': { params: {}; result: ActionInfo[] }
  /** Run any action by id; `exposure` says who is asking (the command line passes `cli`), and params are coerced. */
  'action.run': { params: { id: string; params?: unknown; exposure?: Exposure }; result: unknown }
  /** This machine's newest dispatches. */
  'action.log': { params: {}; result: ActionLogEntry[] }
  /** `env` is laid over the daemon's own environment for its successor: `box run superego daemon restart` adds its keys. */
  'daemon.restart': { params: { build: string; interrupt?: boolean; env?: Record<string, string> }; result: { restarted: boolean; busy: boolean } }
}

export type Notifications = {
  'watch.ops': { sub: string; ops: unknown[] }
  'watch.end': { sub: string; reason: string }
  'threads.changed': { sub: string; value: ThreadInfo[] }
  'settings.changed': { sub: string; value: SettingsSnapshot }
  'auth.event': { flow: string; event: AuthEvent }
  'value.changed': { sub: string; key: string; value: Json }
  /** A watched file, as it is on disk now (`content: null`: gone). */
  'file.changed': { sub: string; content: string | null }
}

/** The methods every settings endpoint (a daemon, or the app itself) answers. */
export type SettingsMethods = Pick<Methods, 'settings.watch' | 'settings.set' | 'unwatch'>

export type MethodName = keyof Methods
export type Params<M extends MethodName> = Methods[M]['params']
export type Result<M extends MethodName> = Methods[M]['result']

/** A typed view over anything that can make calls and listen for notifications. */
export type Client = {
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>
  on<N extends keyof Notifications>(event: N, listener: (params: Notifications[N]) => void): () => void
}
