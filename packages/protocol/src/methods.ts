// The daemon's public method table. One place names every method, its params and its result; the daemon's dispatch,
// the typed client and (later) the CLI and schema are derived from it.
import type { ConversationView } from '@earendil-works/pi-durable'
import type { ActionInfo, ActionLogEntry, Exposure } from './actions.ts'
import type { ExtensionAbout } from './app.ts'
import type { ExtensionManifest } from './contract.ts'
import type { AuthEvent, CustomProviderInput, Json, SettingsSnapshot } from './settings.ts'
import type { Status } from './status.ts'
import type { MachineVersion } from './version.ts'

/**
 * The protocol's generation. It changes only for a break no feature flag can bridge; a daemon and client of different
 * generations refuse each other. Within one, the core's methods and features only grow (`RELEASED` in released.ts holds
 * what was released, and a test keeps it there), each feature added since the generation began announced in `FEATURES`. Not the extension API
 * (`EXTENSION_API`) nor the release (`MachineVersion`): see the skill's lifecycle topic (packages/cli/skill/lifecycle.md),
 * "Versions and compatibility".
 */
export const PROTOCOL_VERSION = 2

/** A line Superego writes in a thread's transcript itself, for the user, not the model: an entry of this kind, `{ text }`. */
export const NOTE_ENTRY = 'superego.note'

/**
 * An input to a thread's agent: an entry of this kind, with the model's user message as a plain one has it and `data`
 * saying how it came (`MessageOrigin`; `{}` for a window's user's). Every input is one: a user-role message of any
 * other kind (a compaction's summary, a reset's handoff, a continuation) wasn't sent by anyone.
 */
export const MESSAGE_ENTRY = 'superego.message'

/**
 * How a message to a thread came: `by` the extension that sent it (`threads.send`, `threads.start`'s prompt), `from`
 * the thread it was sent from (`thread_send`'s, a child's first message from its parent), `exposure` whom for when a
 * client ran it as the command line (`cli`) or an outside agent (`outside`). Empty for a window's user's.
 */
export type MessageOrigin = { by?: string; from?: ThreadId; exposure?: Exposure }

/** A thread as a link in a message, `[its title](thread:<id>)`: what a window shows as one, and what agents are told to write. */
export const linkTo = (thread: Pick<ThreadInfo, 'id' | 'title'>) => `[${thread.title.replace(/[[\]]/g, '')}](thread:${thread.id})`

/**
 * What a daemon of this build offers beyond what its generation began with, announced in `hello`. Clients check a
 * feature before using it, so an older daemon of the generation keeps working with a newer app (and the other way
 * round) for whatever both know. `thread-read`: the `thread.read` method. `forward`: `forward` channels, a TCP
 * connection to a port on its loopback (forward.ts). `image-read`: the `image.read` method, and transcripts whose images
 * come without their pixels (`ImageStub`). `file-locate`: the `file.locate` method. `pane-move`: the `pane.move` action.
 * `artifact-read`: the `artifact.read` method.
 */
export const FEATURES = ['thread-read', 'forward', 'image-read', 'file-locate', 'pane-move', 'artifact-read'] as const
export type Feature = (typeof FEATURES)[number]

export type ThreadId = string

/** A file's version, as the daemon sees it: when it last changed, and its size in bytes. */
export type FileVersion = { mtimeMs: number; size: number }

/**
 * An image as a transcript gives it to clients (`thread.watch`, `thread.history`): its kind and size, without its
 * pixels, which are read with `image.read` by where it is (`ImageRef`'s entry). Its size in pixels when its header says.
 */
export type ImageStub = { type: 'image'; mimeType: string; bytes: number; width?: number; height?: number }

/**
 * An image of a thread's, for `image.read`: a file it may read (`file.read`'s), or an image block of an entry of its
 * transcript, by the entry's id, the index of the message in its `model`, and the block's in that message's content.
 */
export type ImageRef = { path: string } | { entry: number; message: number; block: number }

/** A thread, as its machine tells clients about it (`thread.list`, `useThreads`). */
export type ThreadInfo = {
  id: ThreadId
  title: string
  /** The folder it works in. */
  cwd: string
  /** When it was made, ms since the epoch. */
  createdAt: number
  /** When anything last happened in it: a message, or work going on. */
  activeAt: number
  /** The model its next turn runs with, by its id (`claude-opus-4-5`). */
  model?: string
  /** Whose `model` is: pi-ai's provider id (`anthropic`, `openai`). */
  provider?: string
  /** How hard `model` thinks (`low`, `high`): absent, it doesn't. */
  thinking?: string
  /** The model (`provider/model`) and thinking it chose itself, rather than following its profile or the machine's settings. */
  chosen?: { model?: string; thinking?: string }
  /**
   * Whose choice its model is: its own (`chosen`), an extension's that runs it (Ego's), its profile's, or this machine's
   * settings. Absent while its profile hasn't loaded.
   */
  modelFrom?: 'thread' | 'extension' | 'profile' | 'machine'
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
  /**
   * The thread that started it, if one did (an agent's thread_start, say): it hears from it (its reports), and it shows
   * nested under that one, where that one is listed. A hidden one's child (Ego's) shows top-level.
   */
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
  /**
   * How its runs end isn't the user's to look at: someone else hears it (a child working for its parent, which gets
   * its report). It's never unread for finishing or failing; it still is when it needs the user. An extension says so
   * (`superego.quiet`).
   */
  quiet?: true
  /** What it's doing: `idle`, `working`, `done`, `blocked` (on the user) or `error`, with a line saying more. */
  status: Status
}

/** The models a machine can run, and the default a new thread gets there. */
export type ModelCatalog = {
  models: { value: string; label: string; group: string; thinking: string[] }[]
  default: { model?: string; thinking: string | null }
  /**
   * The models shown first in a model menu, in the user's order (the `agent.favourites` setting; until it's set, the
   * default and each signed-in provider's preferred model). One that can't be used here says why (`unavailable`).
   */
  favourites?: { value: string; label: string; group: string; unavailable?: string }[]
}

/**
 * A pane: a view beside a thread (a diff, an editor, a web page, a profile's graph, another thread). `kind` names what
 * draws it; `params` are its own. Kept with the thread, so it follows the thread to every client. `by: 'agent'`: what
 * it shows is its agent's choice (`pane_open`), until the user opens or changes it themselves. What would load from
 * the web on it (a page anywhere) waits for the user to say so: its address could carry what the agent read.
 */
export type Pane = { id: string; kind: string; title?: string; params?: Json; by?: 'agent' }

/**
 * A profile: the user's (`~/.superego/profiles/<name>`, or a profile source's `profiles/<name>`) or a project's
 * (`.superego/profiles/<name>`), and its folder. `source`: the profile source a user's profile comes from, as it was
 * installed (`git:github.com/mikker/superego-profiles`, `~/dev/superego-profiles`); unset, `~/.superego/profiles`.
 */
export type ProfileRef = { name: string; scope: 'user' | 'project'; dir: string; source?: string }
/**
 * A profile as `profile.list` tells it: once loaded, what it brings (its extensions, and what extensions' keys in it
 * bring, by their titles) and its problems: what's wrong with it that doesn't stop it loading (a key nothing reads).
 */
export type ProfileInfo = ProfileRef & { description?: string; allowed: boolean; extensions?: string[]; brings?: Record<string, string[]>; problems?: string[] }

/**
 * A profile source as `profile.sources` tells it: where the user's profiles beyond `~/.superego/profiles` come from, a
 * git repo (`git:<host>/<owner>/<repo>[@ref]`, cloned to `~/.superego/sources/<host>/<owner>/<repo>`) or a folder, read
 * in place. Its profiles are its `profiles/<name>/profile.ts`; one whose name an earlier source (or
 * `~/.superego/profiles`) has already is `shadowedBy` that one's folder, and not used. `state`: `ready`; `missing` (a
 * folder that isn't there); `not-cloned` (`profile update` clones it); `no-profiles` (no `profiles/` in it).
 */
export type ProfileSourceInfo = {
  source: string
  kind: 'git' | 'local'
  dir: string
  state: 'ready' | 'missing' | 'not-cloned' | 'no-profiles'
  /** A git source's pinned ref, and the commit it's at. */
  ref?: string
  commit?: string
  profiles: { name: string; dir: string; shadowedBy?: string }[]
}

/** A file sent with a message: images go to the model as images; any file is saved on the thread's machine. */
export type Attachment = { name: string; mimeType: string; /** Base64. */ data: string }
/** An attachment as a message carries it: inline, or by an upload on the same connection. */
export type AttachmentRef = Attachment | { name: string; mimeType: string; upload: string }

/**
 * A message of yours that was waiting its turn when its thread was stopped, to write again: as the agent would have
 * had it (`content`: its words, what extensions put in, its files' tags; images without their pixels), and its files,
 * read back (`gone`: those that couldn't be, by name).
 */
export type ReturnedMessage = { content: string | { type: string; text?: string; mimeType?: string }[]; attachments: Attachment[]; gone?: string[] }

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
  /** The profile to run with; unset takes the folder's default (the project's, else the user's). */
  profile?: string
  /** The thread starting it, on the same machine. */
  parent?: string
  /**
   * What extensions are asked for, by name, as their `starting` hooks read it, over its profile's `options`:
   * `{ worktrees: true }`, a git worktree of its own.
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
  /** The build of the code this daemon runs (see `readBuild`); clients compare it with what is on disk now. */
  build: string
  /** The git commit of the checkout it runs from, and when it was made (ms); absent outside git. */
  commit?: string
  committedAt?: number
}

export type Hello = {
  version: number; methods: string[]
  /** The protocol features it offers (`FEATURES`). */
  features: string[]
  /** Who answered, and whether its daemon will outlive a logout and a reboot. */
  machine: MachineInfo & { keepsRunning: KeepsRunning }
  /** The extensions set up and on there, each at its version. */
  extensions: ExtensionManifest[]
  /** The extension API it gives extensions (`EXTENSION_API`). */
  api: string
  /** The id this connection has in the daemon's client list (see `clients.watch`). */
  client: string
}

/**
 * A connection to a daemon, as its client list shows it. `kind` is what the client said it is in `hello` (`superego-app`,
 * `web`, `superego-cli`, `superego-outside`); `label` names it for people: the computer it runs on, a browser's device name, a tailnet device's.
 */
export type ClientInfo = {
  id: string; kind: string; label: string; connectedAt: number; activeAt: number
  /** How it came in: the unix socket (or ssh to it), a paired browser, or Tailscale. */
  via: 'socket' | 'web' | 'tailscale'
  /** The device it is: a paired browser's id, for `web`; `tailscale:<node>`, for `tailscale`. */
  device?: string
  /** The thread whose agent's shell it runs in, as it said in `hello`: an agent's command line, not the user's. */
  from?: ThreadId
  /**
   * On another computer than this machine, so its `localhost` isn't this one's: a browser through Tailscale, or over the
   * socket (ssh to it), a client whose hello named a computer (its hostname) other than this one.
   */
  elsewhere?: boolean
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

/**
 * What a "thread" pane on machine `host` takes to show thread `id` on machine `on` (both as a client calls them): a
 * thread on another machine by that machine's own id (its hello's), as every client knows it, not this one's name for
 * it. Undefined when that isn't known: a machine that never answered.
 */
export function threadPaneParams(machines: readonly Pick<MachineEntry, 'id' | 'machine'>[], host: string, on: string, id: string): { thread: string; machine?: string } | undefined {
  if (on === host) return { thread: id }
  const machine = machines.find((m) => m.id === on)?.machine?.id
  return machine ? { thread: id, machine } : undefined
}

/** The machine `name` names among `machines`: by its id, else by its name or hostname, in any case. */
export function machineNamed<M extends Pick<MachineEntry, 'id' | 'label' | 'machine'>>(machines: readonly M[], name: string): M | undefined {
  const wanted = name.toLowerCase()
  return machines.find((m) => m.id === name) ?? machines.find((m) => m.label.toLowerCase() === wanted || m.machine?.hostname.toLowerCase() === wanted)
}

export type Methods = {
  /**
   * `label` names this client in others' client lists: the app and CLI send their computer's hostname. `from`: the thread
   * whose agent's shell it runs in (the command line sees `<ID>_THREAD`): what it dispatches is that agent's, so actions
   * that record the user's consent refuse it, and what it sends a thread comes from that thread.
   */
  hello: { params: { client: string; version: number; label?: string; from?: ThreadId }; result: Hello }
  /** Nothing, answered at once: a client pinging every few seconds notices a dead link in seconds. */
  ping: { params: {}; result: null }
  /**
   * Open a channel (a byte stream). The daemon accepts `upload` {name, mimeType, size}, its id naming the upload; and
   * `forward` {port, host?}, a TCP connection to that port on its loopback (forward.ts).
   */
  'ch.open': { params: { ch: string; kind: string; params?: unknown; window: number }; result: { window: number } }
  /** The threads, newest first; `archived` lists the ones put away instead, `hidden` those in no list (extensions' own). */
  'thread.list': { params: { archived?: boolean; hidden?: boolean }; result: ThreadInfo[] }
  'thread.start': { params: NewThread; result: ThreadInfo }
  'agent.models': { params: {}; result: ModelCatalog }
  /**
   * A file on a thread's machine (a path relative to its folder, absolute, or `~/…`), as text (refused for a binary
   * file) or base64, with its version as `file.stat` says it.
   */
  'file.read': { params: { thread: ThreadId; path: string; base64?: boolean }; result: { path: string; content: string } & FileVersion }
  /**
   * A file an artifact (an HTML page of a thread's, shown sandboxed) asks for, as base64: only one really in the thread's
   * folder (a relative path that doesn't leave it, nor a symlink on the way), unlike `file.read`. With the
   * `artifact-read` feature.
   */
  'artifact.read': { params: { thread: ThreadId; path: string }; result: { content: string } }
  /**
   * An image of a thread's, as base64: whole, or as a `thumbnail` (at most 1600×4800, as small as a window shows it
   * in a transcript; the image itself when it's that small already), made on this machine and kept. A file's `version`
   * is the one read, as `file.stat` says it. With the `image-read` feature.
   */
  'image.read': { params: { thread: ThreadId; image: ImageRef; thumbnail?: boolean }; result: { data: string; mimeType: string; width?: number; height?: number; version?: FileVersion } }
  /** Which version of each file there is, without reading them (null: none). */
  'file.stat': { params: { thread: ThreadId; paths: string[] }; result: { files: (FileVersion | null)[] } }
  /** A file of a thread's (as `file.read` takes it), then `file.changed` whenever it changes on disk (by anyone), until unwatched. */
  'file.watch': { params: { thread: ThreadId; path: string }; result: { sub: string; content: string | null } }
  /**
   * What a path a message names points at: a file (or a note in the thread's folder by its name), or a `folder` (`''`
   * the thread's own), with the `line` it names. `path` is relative to the thread's folder when it's in it, else
   * absolute; null when there's nothing.
   */
  'file.find': { params: { thread: ThreadId; name: string }; result: { path: string | null; folder?: boolean; line?: number } }
  /**
   * The file or folder each path names (relative to a thread's folder, absolute or `~/…`), exactly as given (no search
   * by name, a `:line` or `#L` kept apart): what a window draws as a link in a message's code. Its `path` as
   * `file.find` gives it; null for nothing there. With the `file-locate` feature.
   */
  'file.locate': { params: { thread: ThreadId; names: string[] }; result: { found: ({ path: string; folder?: boolean; line?: number } | null)[] } }
  /** A profile's UI halves: their entry modules, and a hash that changes when any of its files do. */
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
  /**
   * Stop a thread: its run, and the messages waiting their turn. Yours (a window's, the command line's: no `by` or
   * `from`) come back, in order, to be written again; others' (another thread's `thread_send`, an extension's) are
   * withdrawn, and the thread's transcript says so.
   */
  'thread.stop': { params: { thread: ThreadId }; result: { returned: ReturnedMessage[] } }
  /** Take back a message sent while the agent was busy, still waiting its turn (an item of the thread's `pi.inbox`). */
  'thread.withdraw': { params: { thread: ThreadId; submission: string }; result: null }
  /**
   * Send a follow-up waiting for the agent to finish now: the same item becomes a steer, going in after the current
   * step. `steers`, or what became of it first: `placed` (gone in already), `settled` (taken back, or done).
   */
  'thread.steer': { params: { thread: ThreadId; submission: string }; result: { status: 'steers' | 'placed' | 'settled' } }
  /** The user looked at the thread: its done/error status clears. */
  'thread.seen': { params: { thread: ThreadId }; result: null }
  /** Entries older than `before` (an entry id), oldest first: scrolling back past a watch's window. Images as `ImageStub`s. */
  'thread.history': { params: { thread: ThreadId; before: number; limit?: number }; result: { entries: unknown[]; more: boolean } }
  /** Its last answer, as text (the newest assistant message that says something), if it has one. */
  'thread.lastAnswer': { params: { thread: ThreadId }; result: { text: string | null } }
  /**
   * A thread (listed, archived or hidden) and its last answer, as `thread.lastAnswer` says it. `wait`: once it isn't
   * working, and has answered a message just sent (unless its run doesn't start within ten seconds); a connection
   * that closes stops the wait. With the `thread-read` feature.
   */
  'thread.read': { params: { thread: ThreadId; wait?: boolean }; result: { thread: ThreadInfo; answer: string | null } }
  /** Snapshot of the conversation view, then `watch.ops` notifications with Chord delta ops against it. Images as `ImageStub`s. */
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
  /** Add an OpenAI-compatible provider, or change one added before (see `CustomProviderInput`). */
  'providers.save': { params: CustomProviderInput; result: { id: string } }
  'providers.remove': { params: { provider: string }; result: null }
  /** The models an OpenAI-compatible endpoint lists (`provider`: with that provider's stored key, without `key`). */
  'providers.models': { params: { baseUrl: string; key?: string; provider?: string }; result: { models: string[] } }

  /**
   * Snapshot of an extension's live value, then `value.changed` with each new one. Watched by name: null until an
   * extension publishes it, then its value. `scope`: only that part of it, told only when
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
  'extension.declare': { params: { extensions: ExtensionAbout[] }; result: null }
  /**
   * What each extension here is and does, for an author finding out why theirs doesn't show (`superego extensions`):
   * where it's from, how it stands, what it registered, who watches its values; its profiles' loads; and, given a
   * thread, which extensions that thread goes without, and why.
   */
  'extension.inspect': { params: { thread?: string }; result: ExtensionsReport }
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
   * The machines this daemon reaches: itself as `local`, then those in `machines.json` on its computer, with
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

/** An extension as `extension.inspect` reports it. */
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

/** What `extension.inspect` says. */
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
  'features.changed': { features: string[]; extensions: ExtensionManifest[] }
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
  'thread.select', 'thread.next', 'thread.previous', 'unread.next', 'project.next', 'project.previous', 'pane.next', 'pane.previous',
])
