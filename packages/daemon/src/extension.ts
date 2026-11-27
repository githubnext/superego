// The daemon half of an extension. An extension is a package with up to two halves, imported by the app at build time:
// `<pkg>/daemon` runs here, next to the agents; `<pkg>/ui` runs in the app's window. This half can give the agents
// tools, prompt sections and hooks (pi-durable extensions), register settings, define actions (intents) and methods
// (reads), publish live values for the UI to watch, describe pane kinds to the agent, add to a thread's status, add to
// what a message is sent with, take part in a thread's life (starting, turns, archiving), keep state with each thread
// and say things about it to clients, say what a run did, choose a thread's agent or add to it, and run sign-in flows
// of its own.
//
// Everything it registers is its own, named `<name>.<something>`, and undone when it's torn down: when the daemon
// stops, or (a profile's) when the profile's files change. Torn down, its `signal` aborts, what it registers after is
// refused, and its live values' `set` and `update` do nothing.
import type { AnyTask, Conversation, EntryRecord, Extension } from '@earendil-works/pi-durable'
import type { Teardown } from '@superego/protocol'
import type { ActionDef, ActionInfo, AgentKindMenu, AppConfig, Attachment, ChannelAcceptor, BlockedKind, DataView, Exposure, ExtensionAbout, Json, JsonSchema, MachineEntry, MessageOrigin, NewThread, NoticeAction, Pane, SettingsSnapshot, Static, ThreadInfo } from '@superego/protocol'
import type { SectionSpec } from '@superego/settings'
import type { AuthFlow } from './auth-flows.ts'
import type { DaemonContext } from './host.ts'
import type { LoginEnv } from './login-env.ts'
import type { LoadedSpec, ProfileKey, ProfileRef } from './profiles.ts'
import type { RunRecord } from './recap.ts'
import type { MachineDraft, MachinePatch } from './relay.ts'

export type { AuthFlow, MachineDraft, MachinePatch, RunRecord }

/** A tool call that ended, as `toolCalls` hears it: its thread, what the agent asked, and how it went. */
export type ToolCallRecord = {
  thread: string
  call: { id: string; name: string; args: Json }
  /** `text`: what the model was told, an error's message included. */
  result: { isError: boolean; text?: string }
}
export type { AuthFlowEvent } from './auth-flows.ts'

/**
 * A daemon half: what the extension is (`ExtensionAbout`: its name, title, description, whether it's required, and the
 * panes its UI half draws), and its setup. An extension whose work is all in the window has no setup: its `about` alone is
 * one, for a daemon that bundles it to know it from the start (its pane kinds, its switch in Settings, a profile doing
 * without it). A window also declares its extensions to each machine (`extension.declare`), for one that doesn't.
 */
export type DaemonExtension = ExtensionAbout & {
  /**
   * Called once when it's set up (the daemon starting, before interrupted work resumes; a profile loading). May return a
   * cleanup, run first at teardown. Given up on (and torn down) when it takes longer than 15s. A cleanup that returns a
   * promise is waited for (15s at most) before the daemon closes: return one for work of its own still finishing (a
   * write, a process stopping), so nothing touches the data folder once the daemon is closed.
   */
  setup?(superego: DaemonApi): void | (() => unknown) | Promise<void | (() => unknown)>
}

/** Identity for type inference: `export default defineDaemonExtension({ name, setup(superego) { … } })`. */
export const defineDaemonExtension = (extension: DaemonExtension) => extension

/**
 * An action of a daemon half (`superego.action`): it runs on its machine, so `runs` needn't be said. With a pi-schema
 * `params`, `run` gets them typed. Throw an `RpcError` for a clean error.
 */
export function defineAction<S extends JsonSchema | undefined, R>(
  def: Omit<ActionInfo, 'params' | 'expose' | 'runs'> & {
    runs?: 'machine'; params?: S; expose?: Exposure[]; secretIn?(params: unknown): string[]
    consentIn?(params: S extends JsonSchema ? Static<S> : Record<string, never>): string | undefined
    run(params: S extends JsonSchema ? Static<S> : Record<string, never>, context: DaemonContext): R | Promise<R>
  },
): ActionDef<any, R, DaemonContext> {
  return { expose: ['ui'], runs: 'machine', ...def } as ActionDef<any, R, DaemonContext>
}

/** A value an extension publishes; clients watch it with `value.watch` and get every change. Kept in memory only. */
export type LiveValue<T extends Json> = {
  get(): T
  /** Its value now is `next`: every watcher hears it. */
  set(next: T): void
  /** Set it from what it is now. */
  update(edit: (current: T) => T): void
}

/**
 * A value an extension publishes in scopes (each thread's, by its id): a client watches one scope (`useValue(machine,
 * key, { scope })`) and hears only that scope's changes. Watched whole, it's every scope's by scope. Kept in memory only.
 */
export type ScopedValue<T extends Json> = {
  /** Its value in `scope`: `initial` until set there. */
  get(scope: string): T
  set(scope: string, next: T): void
  update(scope: string, edit: (current: T) => T): void
  /** Forget `scope`: it reads `initial` again (forget a thread's once it's done with, so memory doesn't grow). */
  delete(scope: string): void
  /** The scopes it holds something in now. */
  scopes(): string[]
}

/** What `status` says of a thread that needs the user: what it waits on, and a line (or a few, Markdown) saying it. */
/**
 * What an extension says of a thread's status: it needs the user (`kind`: it shows as blocked), or, while it works, it
 * waits on something that isn't the user (`working`: "Waiting: 3 Claude Agent threads are running").
 */
export type StatusContribution = { kind: BlockedKind; msg?: string } | { working: string }

/** A block of what a message gives the model: text, or an image (base64). */
export type MessageBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/**
 * A message on its way to a thread's agent, as send transforms see it: what was typed, the files sent with it, and
 * the blocks the model will be given so far (the text first, then each file as the core names it).
 */
export type OutgoingMessage = {
  thread: ThreadInfo; text: string; attachments: Attachment[]; content: MessageBlock[]
  /** The extension that sent it (`threads.send`, or `threads.start`'s prompt): absent for a client's, the user's. */
  by?: string
  /**
   * Whom it was sent for, when that's said: a client running as the command line (`cli`) or an outside agent
   * (`outside`, through `superego mcp`), as `DaemonContext.exposure`; or what an extension's `threads.send` passed on. Absent
   * for a window's.
   */
  exposure?: Exposure
  /**
   * The thread it was sent from, when that's said: what an extension's `threads.send` passed on (thread_send's), or, for
   * `threads.start`'s prompt, the parent starting it.
   */
  from?: string
}

/**
 * A mention of a thing of an extension's kind in a message sent (`@canvas:fox-and-rhino`), as its resolver sees it: as
 * written (`ref`), its kind and id (unquoted), and the thread it's sent to.
 */
export type MentionTarget = { ref: string; kind: string; id: string; thread: ThreadInfo }

/**
 * What a mention names, said to the agent in a line after `<ref> is a <kind>: `: what it is, and how to read it
 * (`'"Fox & Rhino". Read it with canvas_read (id: "fox-and-rhino").'`). Undefined: it names nothing, and stays as written.
 */
export type MentionResolve = (mention: MentionTarget) => string | undefined | Promise<string | undefined>

/**
 * (API ^5.17) What an extension tells the user in a thread, without a run (`threads.notice`): `text`, what it says
 * (Markdown, a line or a few), also the thread's status line and its notification; drawn by this extension's entry
 * component for `kind` (`entry(kind, …)` in its UI half, given `data`) when it has one there, else as `text`; with
 * `actions`, buttons under it (`NoticeAction`: send the agent a message, or dispatch an action). `agent`: what its agent
 * is told of it, else `text`; false, nothing. `wake` (API ^5.18): it also starts the agent's run on it (after the run
 * going, if one is), as a message would, without a message beside it: for what the agent should act on (a build that
 * failed).
 */
export type ThreadNotice = { text: string; kind?: string; data?: Json; actions?: NoticeAction[]; agent?: string | false; wake?: boolean }

/** Changes what a message gives the model: returns the blocks to send instead, or nothing to leave them. */
export type SendTransform = (message: OutgoingMessage) => MessageBlock[] | void | Promise<MessageBlock[] | void>

/** A thread about to be made, as `starting` hooks see it: where it would work, and what was asked for. */
export type ThreadDraft = {
  /** The folder it would work in: as asked, or as a hook before this one changed it. */
  cwd: string
  /** Its project: the repository it belongs to (by its main checkout), or the folder. */
  root: string
  /** The repository the asked-for folder is in: its checkout's top, and the main checkout. */
  checkout?: { top: string; root: string }
  title: string
  prompt?: string
  /** The thread starting it. */
  parent?: string
  /** The profile it starts with, as loaded. */
  profile?: { ref: ProfileRef; spec: LoadedSpec }
  /** What extensions were asked for, by name: its profile's `options`, then `NewThread.options` over them. */
  options: Record<string, Json>
}

/**
 * Taking part in a thread's life. Hooks run in the order extensions were set up (the core's first, then the bundled,
 * then profiles'), one after another; not for threads that go without the extension, and a profile's only for its own
 * threads. The `-ing` hooks come first and may refuse by throwing (an `RpcError` for a clean message): the thread isn't
 * made, archived or unarchived, and the hooks after it don't run. The others are told after, and a throw there is only
 * logged: one extension's mistake never wedges a thread.
 */
export type ThreadHooks<S extends Json = Json> = {
  /**
   * Before a thread exists: may move where it works (`cwd`: a worktree, say) and give it this extension's state.
   * Each hook sees the draft as the ones before it left it.
   */
  starting?(draft: ThreadDraft): ThreadStarting<S> | void | Promise<ThreadStarting<S> | void>
  /**
   * The thread its `starting` took part in isn't made after all: a later hook refused, or making it failed. Undo what
   * `starting` did (remove the worktree it added); `state` is what it gave the thread. Told in reverse order.
   */
  abandoned?(draft: ThreadDraft, state: S | undefined): void | Promise<void>
  /** It exists, before its first message is sent. */
  started?(thread: ThreadInfo): void | Promise<void>
  /**
   * A run started: the thread went busy. Per run, not per message: one steered or queued into a run that's going is
   * part of it. Not for a run resumed after a restart (that one ends with a `turnEnd` alone).
   */
  turnStart?(thread: ThreadInfo): void | Promise<void>
  /** Its run ended: answered, failed or stopped. Not for one that ended while the daemon was down. */
  turnEnd?(thread: ThreadInfo): void | Promise<void>
  /**
   * It was stopped (`thread.stop`), withdrawing messages others had queued for it (another thread's `thread_send`, an
   * extension's), which `withdrawn` says the origins of, one each, in order. The user's own come back to them to write
   * again, and aren't here. Told in turn with its other hooks: the `turnEnd` of the run it stopped may be told before
   * or after it.
   */
  stopped?(thread: ThreadInfo, stop: ThreadStop): void | Promise<void>
  /**
   * It came to need the user (an extension's `status` says so: a question), mid-run: once each time, as the extension
   * whose status it is calls `invalidate()`.
   */
  blocked?(thread: ThreadInfo): void | Promise<void>
  /** About to be archived: may refuse. Nothing is done yet; do cleanup in `archived`. A `note` is said with it, as `archived`'s. */
  archiving?(thread: ThreadInfo): ArchiveNote | void | Promise<ArchiveNote | void>
  /**
   * Being archived, past refusing: clean up (remove a worktree, say). Done before clients see it archived. Not a
   * transaction: a throw is logged and archiving goes on, and archiving may be tried again (a restart between), so make
   * cleanup idempotent, and safe to find half done. A `note` says
   * what it did, in a line ("Removed its worktree; branch x kept"): `thread.archive` answers with each extension's.
   */
  archived?(thread: ThreadInfo): ArchiveNote | void | Promise<ArchiveNote | void>
  /** About to be brought back: may refuse, or put back what `archived` took away (a worktree). */
  unarchiving?(thread: ThreadInfo): void | Promise<void>
  /**
   * The unarchiving its `unarchiving` took part in isn't happening after all: a later hook refused, or bringing it back
   * failed. Undo what `unarchiving` put back. Told in reverse order; the thread stays archived.
   */
  unarchiveAbandoned?(thread: ThreadInfo): void | Promise<void>
  /** Brought back, taking messages again. */
  unarchived?(thread: ThreadInfo): void | Promise<void>
  /** A pane beside it closed: closed by someone, or gone as the thread was cleared. What the pane held can go. */
  paneClosed?(thread: ThreadInfo, pane: Pane): void | Promise<void>
}
/** What a thread's stop withdrew of others' messages, as `stopped` hears it. */
export type ThreadStop = { withdrawn: MessageOrigin[] }
/** What a `starting` hook gives a new thread: the folder it works in instead, and this extension's state with it. */
export type ThreadStarting<S extends Json = Json> = { cwd?: string; state?: S }
/** What archiving a thread did, in a line, from an extension's `archiving` or `archived`. */
export type ArchiveNote = { note?: string }
/** What archiving a thread did: each extension's note, by its name. */
export type ArchiveNotes = Record<string, string>

/** An extension's state kept with each thread: in its document, so it persists, forks and archives with it. */
export type ThreadState<T extends Json> = {
  get(thread: string): Promise<T | undefined>
  /** `undefined` forgets it. */
  set(thread: string, next: T | undefined): Promise<void>
  update(thread: string, edit: (current: T | undefined) => T | undefined): Promise<void>
}

/**
 * A thread's agent, as an extension chooses it. Unset parts are as they would be: the thread's own model and
 * thinking win over these, these over its profile's, and those over this machine's settings.
 */
export type AgentChoice = {
  model?: string
  thinking?: string
  /** Instead of its profile's prompt. */
  instructions?: string
  /** Agent parts to add: the extension's own, given with `agent(part, { always: false })`. */
  extensions?: Extension[]
  /** Optional extensions it goes without besides (its tools, panes, UI): `['coding-tools']`. */
  without?: string[]
  /**
   * An agent that sets this machine up (Ego): other extensions' `agentParts` see `setup` on its threads, and may add
   * their own setup tools there.
   */
  setup?: boolean
}

/**
 * An agent part an extension gave (`agent(part)`), to change or take away before teardown. Called, it's taken away, as
 * `remove()` does: a setup that returns it (`setup: (s) => s.agent(part)`) returns its cleanup.
 */
export type AgentPart = (() => void) & {
  /**
   * Put `next` in its place, under the same name: threads that have it get the new one from their next request to the
   * model, a run that's going too (its tools, prompt sections and hooks as they are then), with nothing configured again.
   * Throws for another name, or once it's removed.
   */
  replace(next: Extension): void
  /** Take it away now, as teardown would. Again does nothing. */
  remove(): void
}

/** A thread as an `agentParts` sees it, at each send. */
export type AgentPartsThread = {
  id: string
  /** An extension's own thread, in no list (`threads.start({ hidden })`): Ego's, say. */
  hidden: boolean
  /** The extension whose thread it is, for a hidden one. */
  owner?: string
  /** Its profile, as loaded now (`extends` merged): an edit to it shows from the next turn. */
  profile?: { ref: ProfileRef; spec: LoadedSpec }
  /** Its agent sets this machine up: an `agentFor` chose it with `setup` (Ego's). */
  setup: boolean
  /** Its own model and thinking, as it was started with them (`NewThread.model`: another kind's `<kind>/<model>` too). */
  model?: string
  thinking?: string
}

/**
 * A kind of agent of an extension's (`agentKind`): the task that runs its threads' turns, and what the model menus
 * offer of it.
 */
export type AgentKind = {
  name: string
  runner: AnyTask
  /**
   * Its group in the model menus (`ModelCatalog.agents`), as it is now (asked each time the models are listed, and
   * left out of that list when it takes over 3s: keep it quick), or, while it isn't offered, why not (`{ unavailable }`:
   * "Claude Code isn't installed here") or nothing. Its models are named `<name>/<model>`. Offered with a `profile`
   * only. A model of it made the machine's default runs new threads only while its menu lists it, available: else
   * they're refused with its `unavailable`.
   */
  menu?(): AgentKindOffer | Promise<AgentKindOffer>
  /**
   * The profile a thread started on one of its models runs with when it's given none of this kind (`name`), and what
   * makes it when it isn't there yet (`make`). Without it, such a thread needs a profile of this kind named.
   */
  profile?: { name: string; make(): Promise<void> }
  /**
   * What a thread of this kind runs on, where its model shows (the title bar's model card, its card in the sidebar):
   * asked as its info is made, so quick, from what's at hand (the thread's own choice, its profile's, this extension's
   * state with it). Nothing: it shows no model.
   */
  describe?(thread: AgentKindThread): AgentKindDescription | undefined
  /**
   * How its agent is asked to compact its conversation (`thread.compact`): the message that asks it, sent as the user's
   * (Claude Code's `/compact <instructions>`). Without it, its threads can't be compacted.
   */
  compact?(instructions: string | undefined): string
}

/** What an agent kind's `menu` says: its group in the model menus, or why it isn't offered here, if it says. */
export type AgentKindOffer = Omit<AgentKindMenu, 'kind' | 'profile'> | { unavailable: string } | undefined

/** A thread of an agent kind, as its `describe` sees it. */
export type AgentKindThread = {
  id: string
  /** Its own model and thinking, as picked (`<kind>/<model>`). */
  model?: string
  thinking?: string
  /** Its profile's spec, once loaded. */
  profile?: Record<string, unknown>
  /** This extension's state with it. */
  state?: Json
}

/** What a thread of an agent kind runs on, as said: see `AgentKind.describe`. */
export type AgentKindDescription = {
  /** The model, as said ("Claude Opus"). */
  model: string
  /** Whose it is: a pi-ai provider id (`anthropic`), for its mark. */
  provider?: string
  /** How hard it thinks (`high`). */
  thinking?: string
  /** What the kind says of itself there, in a few words ("runs your Claude Code"). */
  about?: string
  /** How full its context is: the tokens in it, of how many fit. */
  context?: { tokens: number; max: number }
}

/** An extension of the app's here (the core's, a bundled one or a window's; not a profile's), as `extensions()` lists it. */
export type ExtensionEntry = {
  name: string; title?: string; description?: string; version?: string
  /** It has a switch in Settings → Extensions, and a profile can go without it. */
  optional: boolean
  /** Not switched off on this machine. */
  on: boolean
  /** Its files in the data folder that hold keys (`about.secrets`). */
  secrets?: string[]
}

/** What an `agentParts` answers: parts its extension gave with `agent(part, { always: false })`, or nothing. */
export type AgentPartsAnswer = Extension[] | undefined | void

/** What a daemon half's `setup` gets (`superego`): this machine, and ways to add to it, for as long as the extension is set up. */
export type DaemonApi = {
  /** The app this daemon belongs to: its name and id. */
  app: AppConfig
  /** This machine's data folder (`~/.superego`): where the app keeps its own files. */
  dataDir: string
  /**
   * This extension's own folder on this machine, `<dataDir>/extensions/<name>`: made (0700, only the user's) the first
   * time it's read. For what it keeps that isn't a setting nor a thread's: JSON files, a `node:sqlite` database, a
   * cache. It stays when the extension is torn down (its profile reloaded or gone, switched off, the daemon stopping),
   * so the next set-up finds it; `superego extensions` lists those whose extension isn't here, for the user to delete.
   * The name's, not the profile's: two profiles' extensions of one name share it. Ego lists it but never reads what's in
   * it, so credentials of the extension's own (an OAuth refresh token) may go there; one the user gives is a `secret`.
   */
  readonly dir: string
  /**
   * This extension's secrets: the values of its `secret` settings (`settings.register({ settings: [{ key: '<name>.token',
   * title, type: { type: 'secret' } }] })`), which only the user sets (in Settings, or `superego secrets set`) and no
   * client reads. Kept in the OS keychain where there is one, else encrypted in the data folder.
   */
  secrets: {
    /** A secret's value, by its key (`<name>.<key>`, this extension's only); undefined while it isn't set. */
    get(key: string): Promise<string | undefined>
    /** Hear `key` (`<name>.<key>`) set, replaced or cleared: reconnect with the new one. Settings' `onChange` hears it too. */
    onChange(key: string, listener: () => void): void
  }
  /** The folder agents share on this machine (`~/.agents`, or `<APPID>_AGENTS`): skills, `AGENTS.md`. */
  agentsDir: string
  /**
   * (API ^5.11) The environment of the user's login, interactive shell (`zsh -ilc`): the keys their `~/.zshrc` exports,
   * the PATH where mise, Homebrew and npm put their programs, which a daemon started from the Dock doesn't have.
   * `{ env }` (empty where there's no shell to ask), or `{ error }`: why it couldn't be read (the shell didn't answer
   * within 5s). Read once by the daemon, for everyone: what it found is kept; a read that failed is tried again by the
   * next to ask.
   */
  loginEnv(): Promise<LoginEnv>
  /**
   * (API ^5.12) Fit an image (base64) within `limits`, as the core fits every image it sends a model: as it is when it
   * fits, else scaled down and encoded again (PNG, then JPEG at falling qualities, whichever fits `maxBytes` first).
   * Undefined when it can't be made to fit, or isn't an image it can read. On a worker: call it freely from a hook.
   */
  images: { fit(image: { data: string; mimeType: string }, limits?: Partial<ImageFit>): Promise<FittedImage | undefined> }
  /**
   * Aborted when this extension is torn down, before its registrations go: for its own timers, watchers and fetches
   * (`fetch(url, { signal })`, `watch(path, { signal })`, `signal.addEventListener('abort', …)`; one that throws is logged, not fatal).
   * (API ^5.18) Its `reason` then says why: a `Teardown` (an `AbortError`) whose `why` is `'stopping'` (the daemon stops or
   * restarts: leave running what the next daemon takes back), `'reload'` (its profile changed or went) or `'failed'`
   * (its setup failed or took too long). Switching an extension off in Settings doesn't tear it down: its threads go
   * without it (`settings.onChange`, `extensions()` say so).
   */
  signal: AbortSignal & { readonly reason: Teardown | undefined }
  /**
   * Give the agents tools, system prompt sections, hooks or tasks. `always: false`: to no thread but those an
   * `agentFor` or `agentParts` of this extension gives it to. Its handle replaces it (as its tools change, say) or takes
   * it away.
   */
  agent(extension: Extension, options?: { always?: boolean }): AgentPart
  /**
   * A kind of agent of this extension's: threads whose profile picks it (`agent: '<name>'`, this extension's name or
   * `<name>.<kind>`) have every turn run by `runner` instead of a model. The runner is a pi-durable task (pi-durable's
   * agent `runner`): it reads the thread's conversation, appends the turn's entries (assistant messages, tool results),
   * may publish its answer as it streams (`pi.live.generation.message`), and completes with its answer's entry
   * (`{ entryId }`), or fails with what went wrong. The thread's run, its status, Stop and messages sent meanwhile stay
   * the daemon's. A thread of a kind that isn't here (its extension off, or done without) can't be sent to. Its `menu`
   * offers it in the model menus, where picking one of its models starts a thread on it, with its `profile`.
   */
  agentKind(kind: AgentKind): void
  /**
   * Add to a thread's agent, whatever chose it: asked at every send (before the turn starts), and answering with parts
   * this extension gave with `agent(part, { always: false })` (others are left out, with a warning). They come after the
   * parts an `agentFor` chose, and before its profile's. Every extension's is asked at once; each may take up to 5s (a
   * server it has to start, say), and one that takes longer, or throws, adds nothing to that turn. Not for threads that
   * go without this extension; a profile's only for its own threads.
   */
  agentParts(add: (thread: AgentPartsThread) => AgentPartsAnswer | Promise<AgentPartsAnswer>): void
  /** Sign-in flows of this extension's own, carried as a provider's are. */
  auth: {
    /**
     * Run a sign-in flow for the client an action runs for (`to`: its context): the client hears it as `auth.event`
     * (and draws it with `SignInFlow`, from 'superego/ui'), answers its prompts with `auth.respond`, and stops it with
     * `auth.cancel`. It ends `done` when `run` resolves, `failed` with its error when it throws; cancelled, or this
     * extension torn down, `run`'s `flow.signal` aborts. Answers at once, with what the action answers (`{ flow }`).
     */
    flow(to: Pick<DaemonContext, 'notify'>, run: (flow: AuthFlow) => Promise<void>): { flow: string }
  }
  /**
   * This machine's settings, as an extension sees them: it reads any, and registers sections of its own. A section's
   * id is the extension's name (or `<name>.<more>`) and its keys are `<name>.<key>`.
   */
  settings: {
    register(section: SectionSpec): void
    get<T extends Json>(key: string): T
    /**
     * Every section with its settings and values, as clients see them; a section drawn from a live value (`value`) with
     * that value, as it is now, as its `data`.
     */
    snapshot(): Promise<SettingsSnapshot>
    /** Something in the settings changed. */
    onChange(listener: () => void): void
  }
  /**
   * An action of this extension, named `<name>.<action>`: an intent clients dispatch by id, logged, offered in the
   * palette, and to the command line by its exposure. Define it with `defineAction`. Throw an `RpcError` for a clean error.
   */
  action(action: ActionDef<any, unknown, DaemonContext>): void
  /**
   * Run any action on this machine by id, as this extension (`settings.set`, another extension's): params checked first.
   * The user's consent isn't an extension's to give: a consent action (`secrets.set`, `profile.allow`, …), or setting
   * one that records consent, is refused (`consent`).
   */
  dispatch(id: string, params?: unknown): Promise<unknown>
  /** The actions on this machine, as data; `exposure`: only those offered to it (`cli`: what `superego do` runs). */
  actions(exposure?: Exposure): ActionInfo[]
  /**
   * Read a method on this machine by id, another extension's (`skills.list`), as a client calls it: params checked first.
   * Rejects when no extension set up here has it (one switched off, say).
   */
  call(id: string, params?: unknown): Promise<Json>
  /**
   * A read, named `<name>.<method>` (given whole, as actions are): a plain request clients `call`, for data a pane or list shows. Not logged, not in
   * the palette, not run from the command line. `params`, when given, is checked (and coerced) first.
   */
  method<S extends JsonSchema | undefined = undefined, R extends Json = Json>(
    name: string, run: (params: S extends JsonSchema ? Static<S> : Record<string, unknown>) => R | Promise<R>, options?: { params?: S },
  ): void
  /** A live value named `<name>.<key>`, starting at `initial`. Every watcher hears every change. */
  value<T extends Json>(key: string, initial: T): LiveValue<T>
  /**
   * A live value named `<name>.<key>` kept in scopes (a thread's id, say), each `initial` until set: a watcher of one
   * scope hears only its changes. For anything per thread, rather than a value holding every thread's by its id.
   * A `thread` data view (`view`) reading it shows each thread its own scope.
   */
  scopedValue<T extends Json>(key: string, initial: T): ScopedValue<T>
  /**
   * A key of this extension's own in profiles (`mcpServers`, say: a word in camelCase, not one of the core's), its
   * value any JSON: checked as a profile loads (`check`; a problem fails the load), merged over `extends` (`merge`), and
   * told where profiles are listed (`brings`: `ProfileInfo.brings`, by `title`). The extension reads it from a
   * thread's profile (`agentParts`' `profile.spec[key]`, a `starting` hook's `draft.profile`). A bundled extension's
   * only; for profiles loaded while it's set up.
   */
  profileKey(key: string, spec: ProfileKey): void
  /** Say a thread needs the user (it shows as blocked) while `contribute` returns something for it. */
  status(contribute: (threadId: string) => StatusContribution | undefined): void
  /** Something `status` depends on changed: recompute and tell clients. */
  invalidate(): void
  /**
   * Add to (or change) what each message sent to a thread gives its agent, before the turn starts: the instructions of a
   * skill it names, say. Transforms run in the order they were registered, each given what the one before returned;
   * not for threads that go without this extension, and a profile's only for that profile's threads. Every message is
   * a user's or another thread's (thread tools); tool results aren't. A transform that throws fails the send.
   */
  beforeSend(transform: SendTransform): void
  /**
   * (API ^5.16) Say what a mention of `kind` names (`@<kind>:<id>`, as its UI half's `composer.mention` offers them):
   * the Mentions extension asks `resolve` for each one a message sends, and tells the agent what it said in the block
   * that goes with the message, a line each (`@canvas:x is a canvas: <what resolve said>`); the window draws those as
   * links. Answering nothing leaves the mention as written. Asked for threads that don't go without this extension (a
   * profile's: its own threads), and given 2s: a slower answer, or a throw, counts as nothing (logged). `kind` is
   * lowercase letters, digits and dashes; one resolver of each among the app's extensions and each profile's, and not
   * `thread`, `file` or `folder`.
   */
  mention(kind: string, resolve: MentionResolve): void
  /**
   * (API ^5.16) The resolver of `kind` that `thread` has (its profile's first, else the app's): undefined where there's
   * none. Asked, it answers within 2s, a late or failing answer as undefined (logged). For an extension that reads
   * mentions (the Mentions extension's).
   */
  mentionResolver(kind: string, thread: ThreadInfo): ((mention: Omit<MentionTarget, 'kind' | 'thread'>) => Promise<string | undefined>) | undefined
  /**
   * Byte streams of kind `<name>.<kind>` that clients open (the protocol's channels: base64 chunks within credit the
   * receiver grants, behind every control message): a terminal's output and keystrokes, say. `accept` gets each one and
   * the params it was opened with, and throws (an `RpcError`) to refuse it; read with `channel.onData` (set before it
   * returns), write with `channel.write`. A channel ends with its connection. The window opens one with `channel` from
   * 'superego/unstable'.
   */
  channel(kind: string, accept: ChannelAcceptor): void
  /**
   * A view drawn from data, named `<name>.<view>`: the window draws its blocks (`Block[]`, the schema agents draw with:
   * text, a list, a table, inputs, buttons that run this extension's actions on this machine) with its own components,
   * so no UI code ships, and a remote machine's or a project profile's needs no allowing. Its blocks come from a live
   * value of this extension's or a method of its (see `DataView`); every window checks them as they land and draws a
   * view that fails the check as its first error (`blockErrors(blocks, { by: 'extension', extension, thread })` says
   * what, for a test). A profile's fit only the places that show a thread, and only its own threads; but a `window` view
   * of the user's own profile's (not a project's) is the window's, a sidebar too, while the profile is loaded.
   */
  view(id: string, view: DataView): void
  /** Take part in threads' lives: see ThreadHooks. `S`: the state its `starting` gives a thread (`state<S>()`). */
  thread<S extends Json = Json>(hooks: ThreadHooks<S>): void
  /**
   * This extension's state with each thread, kept under its name (`starting` can give a new thread its first).
   * `publish`: also a scoped live value named `key` (`<name>.<something>`), each thread's state in its scope, for the UI
   * to watch (`useValue(machine, key, { scope: thread.id })`): read from the thread when a scope is first watched, told
   * every change made through this state, and let go of once nobody watches it. Asked for once. What a scope reads:
   * - null: not read yet, or nobody publishes it there (this extension is off on that machine, or isn't there; ask
   *   `has(machine, 'ext:<name>')` to tell);
   * - `empty`: read, and the thread has no state of this extension's (none yet, or it was set to undefined), or isn't
   *   a thread there;
   * - else the thread's state.
   * A read that fails is logged under the key, and the scope stays unread.
   */
  state<T extends Json = Json>(options?: { publish?: { key: string; empty: T } }): ThreadState<T>
  /**
   * What clients are told about each thread, as `ThreadInfo.facts[<name>]`: small, and worked out from the thread's
   * state (this extension's) whenever its info is (`invalidate()` when something else it reads changed). Not for
   * threads that go without this extension, as for hooks. Nothing for undefined; a throw is logged and counts as nothing.
   */
  facts<T extends Json = Json>(describe: (thread: { id: string; state: T | undefined }) => Json | undefined): void
  /**
   * Say a thread is quiet (`ThreadInfo.quiet`): how its runs end isn't the user's to look at, as someone else hears it
   * (thread-reports' child working for its parent). Its finishing or failing isn't unread then, nor notified; its
   * needing the user still is. Worked out from the thread's state (this extension's) whenever its info is, as `facts`
   * are (`invalidate()` when something else it reads changed). Not for threads that go without this extension. A throw
   * is logged and counts as not quiet.
   */
  quiet<T extends Json = Json>(describe: (thread: { id: string; state: T | undefined }) => boolean): void
  /**
   * Say in a line what a thread's run did, once it ends: its `done` status carries it (`msg`), and a notification says
   * it. Given the run's tool calls and its answer (see `RunRecord`); answer nothing to leave it to others. The first to
   * answer wins, in the order extensions were set up, as plain text cut to about 100 characters; with none, the answer's
   * first sentence. Not for threads that go without this extension. Quick, without side effects.
   */
  recap(describe: (run: RunRecord) => string | undefined): void
  /**
   * Hear each tool call a thread's agent makes, once it ends (errors too: a refused or interrupted call). Read-only:
   * the run doesn't wait for it, and it can't change the result. A throw (or a rejection) is logged. Not for threads
   * that go without this extension; a profile's only for its own threads.
   */
  toolCalls(watch: (record: ToolCallRecord) => void | Promise<void>): void
  /**
   * An agent kind's (`agentKind`): tell `toolCalls` of a call its own agent made, once it ended, for the calls its runner
   * doesn't run through Superego's tool round (Claude Code's own Bash, Read…), so they're heard as a Superego thread's
   * are. Name and arguments as its transcript has them: Superego's own where the tool is the same (`bash` with its
   * `command`, `read` with its `path`). Throws for a thread that isn't of one of this extension's kinds.
   */
  reportToolCall(record: ToolCallRecord): void
  /**
   * Choose a thread's agent, from this extension's state with it (no `id` yet while it's made; the state its `starting`
   * gave). Its instructions hold only while it answers. The first chooser to answer wins, in the order extensions were
   * set up; a profile's only for its own threads. Called often, so quick and without side effects; a throw is logged
   * (once) and counts as no answer.
   */
  agentFor<T extends Json = Json>(choose: (thread: { id?: string; state: T | undefined; profile?: ProfileRef }) => AgentChoice | undefined): void
  /** The app's extensions on this machine (not profiles'), as Settings → Extensions has them: switched on or off, now. */
  extensions(): ExtensionEntry[]
  threads: {
    /** The threads in use, newest first; `archived`: those put away instead; `hidden`: those no list shows instead. */
    list(options?: { archived?: boolean; hidden?: boolean }): Promise<ThreadInfo[]>
    /** One thread (archived ones too); `not_found` when there's none. */
    get(id: string): Promise<ThreadInfo>
    /** The thread's conversation, to submit, write entries, or watch. */
    conversation(id: string): Promise<Conversation>
    /** The thread a conversation belongs to: subagent conversations map to their top thread. */
    of(conversationId: number): string | undefined
    /**
     * The folder on this machine where a thread keeps its files (what was attached to its messages, images it showed):
     * every client reads a file in it with `file.read`, as it does one in the thread's own folder.
     */
    attachments(id: string): string
    /**
     * Start a thread, as `thread.start` does (its `starting` hooks too): `parent`, a thread's own child (a hidden
     * one's shows top-level, as no list has its parent); `hidden`, in no list, and this extension's (`owner`). A hidden
     * thread has no profile, and takes no messages while the extension that made it is off, or goes without it. Find
     * it again by its `owner` in `list({ hidden: true })`: its facts aren't there while the extension is off.
     */
    start(params: NewThread & { hidden?: boolean }): Promise<ThreadInfo>
    /**
     * Send a thread a message, as a user would; when it's working, `whenBusy` says how (default: after this run).
     * `exposure`: whom for, when an action of this extension's sends it on a client's behalf (its context's `exposure`).
     * `from`: the thread it's from, when one thread writes another. Both are kept with the message (`answering`), and
     * send transforms see them.
     */
    send(id: string, text: string, options?: { whenBusy?: 'steer' | 'followUp'; exposure?: Exposure; from?: string }): Promise<void>
    /**
     * (API ^5.17) Tell the user something in a thread without starting a run (`ThreadNotice`): an entry in its transcript
     * from this extension (the window names it), which makes the thread unread and notifies as a finished run does, its
     * `text` saying why. Its agent is told it with the next turn (as context, not as the user's words): at once when
     * the thread is idle, else where its run can next take it, which is when the entry shows. `archived` for an
     * archived thread. To wake the agent too, `send` it a message as well.
     */
    notice(id: string, notice: ThreadNotice): Promise<void>
    /**
     * How the message a tool call answers came (`MessageOrigin`: `{}` for a window's user's), by the call's
     * conversation and id, as a tool's `execute` has them: the input before the model's message that made the call,
     * not whichever is newest (the user may write while another's turn runs). A user-role message nobody sent (a
     * compaction's summary, a reset's handoff, a continuation) is passed over. Undefined when the call or an input
     * before it isn't found in the thread's newest few hundred entries, or the conversation isn't a thread's own (a
     * subagent's): a guard refuses then.
     */
    answering(conversationId: number, callId: string): Promise<MessageOrigin | undefined>
    /**
     * `reader` read a thread as `read` says it stood (thread_read's info, taken before it read the answer): not looked
     * up again, so a run the thread finished since isn't counted read. Kept, in memory, only when `reader` is its
     * parent and it wasn't working: see `parentRead`.
     */
    noteRead(reader: string, read: Pick<ThreadInfo, 'id' | 'activeAt' | 'status'>): Promise<void>
    /** Whether its parent has read it (`noteRead`) as it stood at `thread.activeAt`, or later: a report of it can go unsaid. */
    parentRead(thread: Pick<ThreadInfo, 'id' | 'activeAt'>): boolean
    /** Its last answer, as text, if it has one. */
    lastAnswer(id: string): Promise<string | undefined>
    /**
     * Wait until it isn't working: its run ended, or it needs the user (`blocked`), whatever extensions it goes without.
     * At once if it isn't working now. Its info then; with `signal` aborted, as it is then.
     */
    idle(id: string, options?: { signal?: AbortSignal }): Promise<ThreadInfo>
    /**
     * Its newest transcript entries, newest first (`limit`, default 20), none from before it was cleared: what it's doing
     * now, say. pi-durable's `EntryRecord`, which isn't part of the stable API: its shape may change with pi-durable.
     */
    entries(id: string, limit?: number): Promise<readonly EntryRecord[]>
    /**
     * Put it away (its `archiving` hooks may refuse); `whenIdle`: once its run ends, kept across restarts (a thread
     * archiving itself), its notes then said in the thread as Superego's own note (`superego.note`).
     */
    archive(id: string, options?: { whenIdle?: boolean }): Promise<{ notes: ArchiveNotes }>
    /** Bring it back from the archive (its `unarchiving` hooks may refuse). */
    unarchive(id: string): Promise<void>
    /**
     * Start it over: its run stopped and a new context, its transcript starting after this (clients watching it watch
     * again), its panes closed. The thread, its title and its state stay.
     */
    clear(id: string): Promise<void>
  }
  /**
   * The other machines this daemon reaches (its `machines.json`, the list the app and `superego machines` keep), a call
   * to one of them (its methods and actions as a client calls them: `thread.list`, `thread.start`, …), and the list
   * itself to change. None when the daemon reaches no others; changing the list then is refused.
   */
  machines: {
    /** The machines it reaches, by id. */
    list(): MachineEntry[]
    /** Call a method or dispatch an action on `machine`, by its id. */
    call(machine: string, method: string, params?: unknown): Promise<unknown>
    /**
     * Add one: reached with ssh (`target`, `user@host` or a Host of `~/.ssh/config`; `command`, what runs there instead
     * of Superego's own), or `via` any command piping stdio to it. The daemon and the app link to it on their own.
     * With `via` or `command` it's refused (`consent`): running a command to reach one is the user's to allow.
     */
    add(machine: MachineDraft): Promise<MachineEntry>
    /** Change one, by id: its name (`label`), whether it's linked to (`enabled`), or how it's reached. */
    update(id: string, patch: MachinePatch): Promise<MachineEntry>
    /** Take one off the list, by id. */
    remove(id: string): Promise<void>
  }
}

/** How an image is fitted (`images.fit`): at most this wide and tall, its base64 at most `maxBytes`, JPEG at `jpegQuality`. Unset: 2000×2000, 4.5 MB, 80. */
export type ImageFit = { maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }
/** An image fitted (`images.fit`): its base64 and type, and the size it was scaled from and to, when it was. */
export type FittedImage = { data: string; mimeType: string; resized?: { from: { width: number; height: number }; to: { width: number; height: number } } }
