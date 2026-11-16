// The daemon's public method table. One place names every method, its params and its result; the daemon's dispatch,
// the typed client and (later) the CLI and schema are derived from it.
import type { ConversationView } from '@earendil-works/pi-durable'
import type { ActionInfo, ActionLogEntry, Exposure } from './actions.ts'
import type { ExtensionAbout } from './app.ts'
import type { ExtensionManifest } from './contract.ts'
import type { AuthEvent, Json, SettingsSnapshot } from './settings.ts'
import type { Status } from './status.ts'
import type { MachineVersion } from './version.ts'

/**
 * The protocol's generation. It changes only for a break no feature flag can bridge; a daemon and client of different
 * generations refuse each other. Within one, the core's methods and features only grow (`RELEASED` in released.ts holds
 * what was released, and a test keeps it there), each new one announced in `FEATURES`. Not the extension API
 * (`EXTENSION_API`) nor the release (`MachineVersion`): see the guide (packages/cli/skill/guide.md), "Versions and
 * compatibility".
 */
export const PROTOCOL_VERSION = 2

/**
 * What a daemon of this build offers, announced in `hello`. Clients check a feature before using it, so an older
 * daemon on another machine keeps working with a newer app (and the other way round) for whatever both know.
 */
/** A line Superego writes in a thread's transcript itself, for the user, not the model: an entry of this kind, `{ text }`. */
export const NOTE_ENTRY = 'superego.note'

export const FEATURES = ['threads', 'settings', 'auth', 'restart', 'restart-env', 'actions', 'hidden-threads', 'data-views', 'scoped-values', 'heartbeat', 'channels', 'uploads', 'keeps-running', 'clients', 'relay'] as const
export type Feature = (typeof FEATURES)[number]

export type ThreadId = string

/** A file's version, as the daemon sees it: when it last changed, and its size in bytes. */
export type FileVersion = { mtimeMs: number; size: number }

/** A thread, as its machine tells clients about it (`thread.list`, `useThreads`). */
export type ThreadInfo = {
  id: ThreadId
  title: string
  /** The folder it works in. */
  cwd: string
  /** When it was made, ms since the epoch. */
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
  /** The id of the pane in front. */
  pane?: string
  /** The profile it runs with: one of the project's, or one of the user's. Absent: plain Superego. */
  profile?: ProfileRef
  /** The project it belongs to, on its machine: a repository (by its main checkout, worktrees included) or a folder. */
  project: { root: string; name: string }
  /** The thread that started it, if one did (an agent's thread_start, say): it shows nested under that one. */
  parent?: ThreadId
  /** Put away: listed only with `archived`, readable, and taking no messages until unarchived. */
  archived?: boolean
  /**
   * The optional extensions it goes without: turned off on its machine, or left out by its profile. The window draws
   * none of their UI for it either. Absent: it has them all.
   */
  without?: string[]
  /** Left out of every list: an extension's own thread (an agent of its own), opened by id. */
  hidden?: boolean
  /** For a hidden thread, the extension whose it is: there whether that extension is on or off, unlike its facts. */
  owner?: string
  /** What extensions say about it (their facts), by extension name: `facts.worktrees`, say. Absent: nothing. */
  facts?: Record<string, Json>
  /** What it's doing: `idle`, `working`, `done`, `blocked` (on the user) or `error`, with a line saying more. */
  status: Status
}

/** The models a machine can run, and the default a new thread gets there. */
export type ModelCatalog = {
  models: { value: string; label: string; group: string; thinking: string[] }[]
  default: { model?: string; thinking: string | null }
}

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
/** An attachment as a message carries it: inline, or (with the `uploads` feature) by an upload on the same connection. */
export type AttachmentRef = Attachment | { name: string; mimeType: string; upload: string }

/** What a new thread starts with. Unset: this machine's defaults. */
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
  attachments?: AttachmentRef[]
  /** In a git repository: a worktree of its own, rather than the checkout (its profile's choice when unset; else no). */
  worktree?: boolean
  /** The profile to run with; unset takes the folder's default (the project's, else the user's). */
  profile?: string
  /** The thread starting it, on the same machine. */
  parent?: string
  /**
   * What extensions are asked for, by name, as their `starting` hooks read it: `{ worktrees: true }`. `worktree` is
   * the shorthand for `worktrees`.
   */
  options?: Record<string, Json>
}

/**
 * Whether a daemon will still be there after the user logs out or the machine reboots: the service that runs it (systemd
 * or launchd; null when it is only a process the first connection started), and whether that service survives a logout
 * (lingering on Linux; null when not known, as for a launchd agent, which lasts as long as the login session).
 */
export type KeepsRunning = { service: 'systemd' | 'launchd' | null; afterLogout: boolean | null }

/** `id` is the machine's identity: stable across restarts and routes, so a client can tell it is the same machine. */
export type MachineInfo = {
  id: string; hostname: string; platform: string; pid: number; dataDir: string
  /** With the `keeps-running` feature. */
  keepsRunning?: KeepsRunning
  /** The build of the code this daemon runs (see `readBuild`); clients compare it with what is on disk now. */
  build: string
  /** The git commit of the checkout it runs from, and when it was made (ms); absent from older daemons and outside git. */
  commit?: string
  committedAt?: number
}

export type Hello = {
  version: number; features: string[]; machine: MachineInfo; methods: string[]
  /** The extensions set up and on there (those in `features` as `ext:<name>`), each at its version. Absent from daemons before versions. */
  extensions?: ExtensionManifest[]
  /** The extension API it gives extensions (`EXTENSION_API`). Absent from daemons before versions. */
  api?: string
  /** The id this connection has in the daemon's client list (see `clients.watch`), with the `clients` feature. */
  client?: string
}

/**
 * A connection to a daemon, as its client list shows it. `kind` is what the client said it is in `hello` (`superego-app`,
 * `web`, `superego-cli`, `superego-outside`); `label` names it for people: the computer it runs on, a browser's device name, a Tailscale login.
 */
export type ClientInfo = {
  id: string; kind: string; label: string; connectedAt: number; activeAt: number
  /** How it came in: the unix socket (or ssh to it), a paired browser, or Tailscale. */
  via: 'socket' | 'web' | 'tailscale'
  /** The paired browser it is, for `web`. */
  device?: string
}

/**
 * How a client's connection to a machine stands. `needs-login`: ssh wants a password, a code or a key it doesn't have,
 * so the link waits for a login instead of retrying. `host-key`: the host key is unknown or changed (the error says
 * which), and it waits for that to be put right.
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'needs-login' | 'host-key'

/** A machine as a client shows it: its link's state, and what the last hello said. */
export type MachineEntry = {
  id: string; label: string; state: ConnectionState | 'disabled'; error?: string; errorKind?: string
  /** Who answered, from the last hello: the daemon's identity and hostname, and what it offers. */
  machine?: { id: string; hostname: string }
  /** Whether its daemon will outlive a logout and a reboot, from the last hello. */
  keepsRunning?: KeepsRunning
  features?: string[]
  /** The extensions it offers, each at its version (see `Hello.extensions`). */
  extensions?: ExtensionManifest[]
  /** What it runs, to tell it from what this computer runs (see `compareVersions`). */
  version?: MachineVersion
  /** Absent for this computer, which can't be removed. */
  remote?: { route: string; enabled: boolean; /** Reached with ssh, so it can log in. */ ssh: boolean }
}

export type Methods = {
  /** `label` names this client in others' client lists: the app and CLI send their computer's hostname. */
  hello: { params: { client: string; version: number; features?: string[]; label?: string }; result: Hello }
  /** Nothing, answered at once: a client pinging every few seconds notices a dead link in seconds (`heartbeat`). */
  ping: { params: {}; result: null }
  /** Open a channel (a byte stream). The daemon accepts `upload` {name, mimeType, size}; its id names the upload. */
  'ch.open': { params: { ch: string; kind: string; params?: unknown; window: number }; result: { window: number } }
  /** The threads, newest first; `archived` lists the ones put away instead, `hidden` those in no list (extensions' own). */
  'thread.list': { params: { archived?: boolean; hidden?: boolean }; result: ThreadInfo[] }
  'thread.start': { params: NewThread; result: ThreadInfo }
  'agent.models': { params: {}; result: ModelCatalog }
  /** A file in a thread's folder (not outside it), as text. */
  /** `mtimeMs` and `size`: its version, as `file.stat` says it (absent from older daemons). */
  'file.read': { params: { thread: ThreadId; path: string; base64?: boolean }; result: { path: string; content: string; mtimeMs?: number; size?: number } }
  /** Which version of each file there is, without reading them (null: none, or not the thread's). Absent from older daemons. */
  'file.stat': { params: { thread: ThreadId; paths: string[] }; result: { files: (FileVersion | null)[] } }
  /** A file in a thread's folder, then `file.changed` whenever it changes on disk (by anyone), until unwatched. */
  'file.watch': { params: { thread: ThreadId; path: string }; result: { sub: string; content: string | null } }
  /**
   * What a path a message names points at in a thread's folder: a file (or a note by its name), or a `folder` (`''` the
   * folder itself), with the `line` it names. `path` is null when there's nothing, `outside` when it's past the folder.
   */
  'file.find': { params: { thread: ThreadId; name: string }; result: { path: string | null; folder?: boolean; line?: number; outside?: boolean } }
  /** A profile's UI extensions: their entry modules, and a hash that changes when any of its files do. */
  'profile.ui': { params: ProfileRef; result: { hash: string; entries: string[] } }
  /** One module of a profile's UI, as JavaScript (types stripped); its own imports are left for the window to load. */
  'profile.module': { params: ProfileRef & { path: string }; result: { path: string; code: string } }
  'thread.rename': { params: { thread: ThreadId; title: string }; result: null }
  /**
   * Run a thread with another profile from its next turn: by name, as `profile.list` gives them for its folder; none,
   * the default there (none of those either: no profile). The one it runs now, or null.
   */
  'thread.setProfile': { params: { thread: ThreadId; profile?: string }; result: ProfileRef | null }
  'thread.send': { params: { thread: ThreadId; text: string; attachments?: AttachmentRef[]; requestId?: string; whenBusy?: 'steer' | 'followUp' }; result: { submission: string } }
  'thread.stop': { params: { thread: ThreadId }; result: null }
  /** Take back a message sent while the agent was busy, still waiting its turn (an item of the thread's `pi.inbox`). */
  'thread.withdraw': { params: { thread: ThreadId; submission: string }; result: null }
  /**
   * Send a follow-up waiting for the agent to finish now: the same item becomes a steer, going in after the current
   * step. `steers`, or what became of it first: `placed` (gone in already), `settled` (taken back, or done).
   */
  'thread.steer': { params: { thread: ThreadId; submission: string }; result: { status: 'steers' | 'placed' | 'settled' } }
  /** The user looked at the thread: its done/error status clears. */
  'thread.seen': { params: { thread: ThreadId }; result: null }
  /** Entries older than `before` (an entry id), oldest first: scrolling back past a watch's window. */
  'thread.history': { params: { thread: ThreadId; before: number; limit?: number }; result: { entries: unknown[]; more: boolean } }
  /** Snapshot of the conversation view, then `watch.ops` notifications with Chord delta ops against it. */
  'thread.watch': { params: { thread: ThreadId }; result: { sub: string; value: ConversationView } }
  /**
   * Snapshot of the thread list, then `threads.changed` notifications with the whole list. `hidden`: the threads no list
   * shows instead (extensions' own), for a window showing one.
   */
  'threads.watch': { params: { hidden?: boolean }; result: { sub: string; value: ThreadInfo[] } }
  unwatch: { params: { sub: string }; result: null }

  /** Snapshot of every section and value, then `settings.changed` with the whole snapshot. */
  'settings.watch': { params: {}; result: { sub: string; value: SettingsSnapshot } }
  'settings.set': { params: { key: string; value: Json }; result: null }
  /** Start a sign-in. It reports through `auth.event`; prompts are answered with `auth.respond`. */
  'auth.signIn': { params: { provider: string; type: 'api_key' | 'oauth'; key?: string }; result: { flow: string } }
  'auth.respond': { params: { flow: string; prompt: string; value: string }; result: null }
  'auth.cancel': { params: { flow: string }; result: null }
  'auth.signOut': { params: { provider: string }; result: null }

  /**
   * Snapshot of an extension's live value, then `value.changed` with each new one. Watched by name: null until an
   * extension publishes it, then its value. `scope` (feature `scoped-values`): only that part of it, told only when
   * that part changes: a scoped value's (`superego.scopedValue`) value in that scope (a thread's, by its id); a plain
   * value's entry of that key, if it's an object (else null). Unscoped, a scoped value is every scope's, by scope.
   */
  'value.watch': { params: { key: string; scope?: string }; result: { sub: string; value: Json } }
  /** Every action on this machine, as data; given `exposure`, only those it may run now. */
  'action.list': { params: { exposure?: Exposure }; result: ActionInfo[] }
  /** Run any action by id; `exposure` says who is asking (the command line passes `cli`), and params are coerced. */
  'action.run': { params: { id: string; params?: unknown; exposure?: Exposure }; result: unknown }
  /** This machine's newest dispatches. */
  'action.log': { params: {}; result: ActionLogEntry[] }
  /** The window's extensions, as each declares itself: those without a daemon half become known to the machine too. */
  'extensions.declare': { params: { extensions: ExtensionAbout[] }; result: null }
  /**
   * What each extension here is and does, for an author finding out why theirs doesn't show (`superego extensions`):
   * where it's from, how it stands, what it registered, who watches its values; its profiles' loads; and, given a
   * thread, which extensions that thread goes without, and why.
   */
  'extensions.inspect': { params: { thread?: string }; result: ExtensionsReport }
  /**
   * Restart onto newer code: the daemon exits and the client starts the new one. Refused (`restarted: false`) while a
   * thread is working, unless `interrupt`; interrupted runs resume after the restart. `build` must be the running
   * build, so a client never restarts a daemon it didn't inspect. `env` is laid over the daemon's own environment for
   * its successor: `box run superego daemon restart` adds its keys.
   */
  'daemon.restart': { params: { build: string; interrupt?: boolean; env?: Record<string, string> }; result: { restarted: boolean; busy: boolean } }

  /** Who is connected to this machine, then `clients.changed` with the whole list. */
  'clients.watch': { params: {}; result: { sub: string; value: ClientInfo[] } }
  /**
   * Ask another client (by id) to run one of its window actions: it gets `client.perform` and dispatches it itself.
   * Only the navigation in PERFORMABLE; anything else is refused here and ignored there.
   */
  'client.perform': { params: { client: string; action: string; params?: Json }; result: null }

  /**
   * The machines this daemon reaches (`relay`): itself as `local`, then those in `machines.json` on its computer, with
   * their links' states; then `machines.changed` with the whole list.
   */
  'machines.watch': { params: {}; result: { sub: string; value: MachineEntry[] } }
  /**
   * Call a method on a machine this daemon reaches, through its link there. Its notifications come back to this
   * connection as `relay.event`, and watches it opened there end when this connection does.
   */
  'relay.call': { params: { machine: string; method: string; params?: unknown }; result: unknown }
  /** Drop a link and connect again, as after a login or a reinstall there. */
  'machine.reconnect': { params: { id: string }; result: null }
}

/** An extension as `extensions.inspect` reports it. */
export type ExtensionReport = {
  name: string
  version?: string
  api?: string
  title?: string
  required?: boolean
  /** Where it's from: the core's, the app's own (bundled), a profile's (its file, and the profiles that have it), or a window's (no daemon half). */
  source: 'core' | 'bundled' | 'profile' | 'window'
  file?: string
  profiles?: string[]
  /** `set up` and running; `off` (switched off here); or why it isn't: it threw (`failed`), was refused before it ran, or its setup took too long. */
  state: 'set up' | 'off' | 'failed' | 'refused' | 'timed out'
  error?: string
  /** What it registered, by kind (`methods`, `actions`, `values`, `views`, `thread hooks`, …): names, or how many. */
  registered: Record<string, string[]>
  /** Its live values being watched now: by how many, whole, and in how many scopes. */
  watches: { value: string; whole: number; scopes: number }[]
}

/** What `extensions.inspect` says. */
export type ExtensionsReport = {
  api: string
  extensions: ExtensionReport[]
  /** The profiles loaded or tried here, and how each stands. */
  profiles: { name: string; scope: 'user' | 'project'; dir: string; state: 'loaded' | 'failed'; error?: string }[]
  /** Given a thread: its profile, and each extension that doesn't take part in it, with why. */
  thread?: { id: string; profile?: string; without: { extension: string; why: string }[] }
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
  /** What the daemon offers now, as `hello` said it: sent to every client whenever it changes (an extension set up, torn down, switched off). */
  'features.changed': { features: string[]; extensions?: ExtensionManifest[] }
  /** Channels: byte streams a client and the daemon open. */
  'ch.data': { ch: string; data: string }
  'ch.ack': { ch: string; bytes: number }
  'ch.end': { ch: string }
  'ch.abort': { ch: string; message: string }
  'clients.changed': { sub: string; value: ClientInfo[] }
  /** Another client asks this one to run a window action. A client that has no such action ignores it. */
  'client.perform': { from: ClientInfo; action: string; params?: Json }
  'machines.changed': { sub: string; value: MachineEntry[] }
  /** A notification from a machine reached through this daemon, for a connection that has called it. */
  'relay.event': { machine: string; method: string; params: unknown }
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

/**
 * The window actions another client may ask a window to run (`client.perform`): moving around, nothing that changes,
 * sends, opens or shows anything beyond the threads and panes already there. A window takes them only from its own
 * machine's daemon (see the app's perform.ts).
 */
export const PERFORMABLE: ReadonlySet<string> = new Set([
  'thread.select', 'thread.next', 'thread.previous', 'thread.unread', 'project.next', 'project.previous', 'pane.next', 'pane.previous',
])
