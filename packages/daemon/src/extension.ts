// The daemon half of an extension. An extension is a package with up to two halves, imported by the app at build time:
// `<pkg>/daemon` runs here, next to the agents; `<pkg>/ui` runs in the app's window. This half can give the agents
// tools, prompt sections and hooks (pi-durable extensions), register settings, define actions (intents) and methods
// (reads), publish live values for the UI to watch, describe pane kinds to the agent, add to a thread's status, add to
// what a message is sent with, take part in a thread's life (creating, turns, archiving), keep state with each thread
// and say things about it to clients, and choose a thread's agent.
//
// Everything it registers is its own, named `<name>.<something>`, and undone when it's torn down: when the daemon
// stops, or (a profile's) when the profile's files change.
import type { Conversation, Extension, Harness } from '@earendil-works/pi-durable'
import type { ActionDef, AppConfig, Attachment, BlockedKind, ExtensionAbout, Json, JsonSchema, NewThread, Static, ThreadInfo } from '@superego/protocol'
import type { SectionSpec } from '@superego/settings'
import type { DaemonContext } from './daemon.ts'
import type { ProfileRef, ProfileSpec } from './profiles.ts'

/**
 * A daemon half: what the extension is (`ExtensionAbout`: its name, title, description, and whether it's required),
 * and its setup. An extension whose work is all in the window has none: the window declares it to the machine
 * (`extensions.declare`), which then lists it in Settings and lets a profile do without it.
 */
export type DaemonExtension = ExtensionAbout & {
  /** Called once when it's set up (the daemon starting, before interrupted work resumes; a profile loading). May return a cleanup. */
  setup?(superego: DaemonApi): void | (() => void) | Promise<void | (() => void)>
}

/** Identity for type inference: `export default defineDaemonExtension({ name, setup(superego) { … } })`. */
export const defineDaemonExtension = (extension: DaemonExtension) => extension

/** A value an extension publishes; clients watch it with `value.watch` and get every change. Kept in memory only. */
export type LiveValue<T extends Json> = { get(): T; set(next: T): void; update(edit: (current: T) => T): void }

export type StatusContribution = { kind: BlockedKind; msg?: string }

/** A block of what a message gives the model: text, or an image (base64). */
export type MessageBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/**
 * A message on its way to a thread's agent, as submit transforms see it: what was typed, the files sent with it, and
 * the blocks the model will be given so far (the text first, then each file as the core names it).
 */
export type OutgoingMessage = { thread: ThreadInfo; text: string; attachments: Attachment[]; content: MessageBlock[] }

/** Changes what a message gives the model: returns the blocks to send instead, or nothing to leave them. */
export type SubmitTransform = (message: OutgoingMessage) => MessageBlock[] | void | Promise<MessageBlock[] | void>

/** A thread about to be made, as `creating` hooks see it: where it would work, and what was asked for. */
export type ThreadDraft = {
  /** The folder it would work in: as asked, or as a hook before this one changed it. */
  cwd: string
  /** Its session: the project it belongs to (a repository's main checkout, or the folder). */
  root: string
  /** The repository the asked-for folder is in: its checkout's top, and the main checkout. */
  checkout?: { top: string; root: string }
  title: string
  prompt?: string
  /** The thread starting it. */
  parent?: string
  /** The profile it starts with, as loaded. */
  profile?: { ref: ProfileRef; spec: ProfileSpec }
  /** What extensions were asked for, by name (`NewThread.options`; `worktree` is `options.worktrees`). */
  options: Record<string, Json>
}

/**
 * Taking part in a thread's life. Hooks run in the order extensions were set up (the core's first, then the bundled,
 * then profiles'), one after another; not for threads that go without the extension, and a profile's only for its own
 * threads. The `-ing` hooks come first and may refuse by throwing (an `RpcError` for a clean message): the thread isn't
 * made, archived or unarchived, and the hooks after it don't run. The others are told after, and a throw there is only
 * logged: one extension's mistake never wedges a thread.
 */
export type ThreadHooks = {
  /**
   * Before a thread exists: may move where it works (`cwd`: a worktree, say) and give it this extension's state.
   * Each hook sees the draft as the ones before it left it.
   */
  creating?(draft: ThreadDraft): ThreadCreating | void | Promise<ThreadCreating | void>
  /** It exists, before its first message is sent. */
  created?(thread: ThreadInfo): void | Promise<void>
  /**
   * A run started: the thread went busy. Per run, not per message: one steered or queued into a run that's going is
   * part of it. Not for a run resumed after a restart (that one ends with a `turnEnd` alone).
   */
  turnStart?(thread: ThreadInfo): void | Promise<void>
  /** Its run ended: answered, failed or stopped. Not for one that ended while the daemon was down. */
  turnEnd?(thread: ThreadInfo): void | Promise<void>
  /** About to be archived: may refuse. Nothing is done yet; do cleanup in `archived`. */
  archiving?(thread: ThreadInfo): void | Promise<void>
  /** Being archived, past refusing: clean up (remove a worktree, say). Done before clients see it archived. */
  archived?(thread: ThreadInfo): void | Promise<void>
  /** About to be brought back: may refuse, or put back what `archived` took away (a worktree). */
  unarchiving?(thread: ThreadInfo): void | Promise<void>
  /** Brought back, taking messages again. */
  unarchived?(thread: ThreadInfo): void | Promise<void>
}
export type ThreadCreating = { cwd?: string; state?: Json }

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
}

export type DaemonApi = {
  app: AppConfig
  /** The folder agents share on this machine (`~/.agents`, or `<APPID>_AGENTS`): skills, `AGENTS.md`. */
  agentsDir: string
  /** The pi-durable harness, for anything the API below doesn't cover. Unstable: it's pi-durable's, not Superego's. */
  harness: Harness
  /**
   * Give the agents tools, system prompt sections, hooks or tasks. `always: false`: to no thread but those an
   * `agentFor` of this extension chooses it for.
   */
  agent(extension: Extension, options?: { always?: boolean }): void
  /**
   * This machine's settings, as an extension sees them: it reads any, and registers sections of its own. A section's
   * id is the extension's name (or `<name>.<more>`) and its keys are `<name>.<key>`.
   */
  settings: {
    register(section: SectionSpec): void
    get<T extends Json>(key: string): T
    /** Something in the settings changed. */
    onChange(listener: () => void): void
  }
  /**
   * An action of this extension, named `<name>.<action>`: an intent clients dispatch by id, logged, offered in the
   * palette, and to the command line by its exposure. Define it with `defineAction`. Throw an `RpcError` for a clean error.
   */
  action(action: ActionDef<any, unknown, DaemonContext>): void
  /**
   * A read, named `<name>.<method>` (given whole, as actions are): a plain request clients `call`, for data a pane or list shows. Not logged, not in
   * the palette, not run from the command line. `params`, when given, is checked (and coerced) first.
   */
  method<S extends JsonSchema | undefined = undefined, R extends Json = Json>(
    name: string, run: (params: S extends JsonSchema ? Static<S> : Record<string, unknown>) => R | Promise<R>, options?: { params?: S },
  ): void
  /** A live value named `<name>.<key>`, starting at `initial`. */
  value<T extends Json>(key: string, initial: T): LiveValue<T>
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
  submit(transform: SubmitTransform): void
  /**
   * Tell the agent about a kind of pane its UI half draws (`superego.pane(kind, …)` there), and the params it takes:
   * open_pane can open it from then on. A profile's extension's are for that profile's threads.
   */
  pane(kind: string, about: string): void
  /** Take part in threads' lives: see ThreadHooks. */
  thread(hooks: ThreadHooks): void
  /** This extension's state with each thread, kept under its name (`creating` can give a new thread its first). */
  state<T extends Json = Json>(): ThreadState<T>
  /**
   * What clients are told about each thread, as `ThreadInfo.ext[<name>]`: small, and worked out from the thread's
   * state (this extension's) whenever its info is (`invalidate()` when something else it reads changed). Not for
   * threads that go without this extension, as for hooks. Nothing for undefined; a throw is logged and counts as nothing.
   */
  facts<T extends Json = Json>(describe: (thread: { id: string; state: T | undefined }) => Json | undefined): void
  /**
   * Choose a thread's agent, from this extension's state with it (no `id` yet while it's made; the state its `creating`
   * gave). Its instructions hold only while it answers. The first chooser to answer wins, in the order extensions were
   * set up; a profile's only for its own threads. Called often, so quick and without side effects; a throw is logged
   * (once) and counts as no answer.
   */
  agentFor<T extends Json = Json>(choose: (thread: { id?: string; state: T | undefined; profile?: ProfileRef }) => AgentChoice | undefined): void
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
     * Start a thread, as `thread.create` does (its `creating` hooks too): `parent`, a thread's own child; `hidden`, in
     * no list (a hidden parent's children are top-level).
     */
    create(params: NewThread & { hidden?: boolean }): Promise<ThreadInfo>
    /** Send a thread a message, as a user would; when it's working, `whenBusy` says how (default: after this run). */
    submit(id: string, text: string, options?: { whenBusy?: 'steer' | 'followUp' }): Promise<void>
    /** Its last answer, as text, if it has one. */
    lastAnswer(id: string): Promise<string | undefined>
    /** Put it away (its `archiving` hooks may refuse); `whenIdle`: once its run ends, kept across restarts (a thread archiving itself). */
    archive(id: string, options?: { whenIdle?: boolean }): Promise<void>
    unarchive(id: string): Promise<void>
  }
}
