// The daemon half of an extension. An extension is a package with up to two halves, imported by the app at build time:
// `<pkg>/daemon` runs here, next to the agents; `<pkg>/ui` runs in the app's window. This half can give the agents
// tools, prompt sections and hooks (pi-durable extensions), register settings, define actions (intents) and methods
// (reads), publish live values for the UI to watch, describe pane kinds to the agent, add to a thread's status, and
// add to what a message is sent with.
//
// Everything it registers is its own, named `<name>.<something>`, and undone when it's torn down: when the daemon
// stops, or (a profile's) when the profile's files change.
import type { Conversation, Extension, Harness } from '@earendil-works/pi-durable'
import type { ActionDef, AppConfig, Attachment, BlockedKind, ExtensionAbout, Json, JsonSchema, Static, ThreadInfo } from '@superego/protocol'
import type { SectionSpec } from '@superego/settings'
import type { DaemonContext } from './daemon.ts'

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

export type DaemonApi = {
  app: AppConfig
  /** The folder agents share on this machine (`~/.agents`, or `<APPID>_AGENTS`): skills, `AGENTS.md`. */
  agentsDir: string
  /** The pi-durable harness, for anything the API below doesn't cover. Unstable: it's pi-durable's, not Superego's. */
  harness: Harness
  /** Give the agents tools, system prompt sections, hooks or tasks. */
  agent(extension: Extension): void
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
  threads: {
    list(): Promise<ThreadInfo[]>
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
  }
}
