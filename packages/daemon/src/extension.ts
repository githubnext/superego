// The daemon half of an extension. An extension is a package with up to two halves, imported by an app at build time:
// `<pkg>/daemon` runs here, next to the agents; `<pkg>/ui` runs in the app's window. This half can give the agents
// tools, prompt sections and hooks (pi-durable extensions), register settings, answer methods, publish live values
// for the UI to watch, and add to a session's status.
import type { Conversation, Extension, Harness } from '@earendil-works/pi-durable'
import type { AppConfig, BlockedKind, Json, SessionInfo } from '@mu/protocol'
import type { SettingsRegistry } from '@mu/settings'

export type DaemonExtension = {
  /** Lowercase, unique in the app: `ask-user`, `git`. Its methods and values are named `<name>.<something>`. */
  name: string
  /** Called once when the daemon starts, before interrupted work resumes. May return a cleanup. */
  setup(mu: DaemonApi): void | (() => void) | Promise<void | (() => void)>
}

/** Identity for type inference: `export default defineDaemonExtension({ name, setup(mu) { … } })`. */
export const defineDaemonExtension = (extension: DaemonExtension) => extension

/** A value an extension publishes; clients watch it with `value.watch` and get every change. Kept in memory only. */
export type LiveValue<T extends Json> = { get(): T; set(next: T): void; update(edit: (current: T) => T): void }

export type StatusContribution = { kind: BlockedKind; msg?: string }

export type DaemonApi = {
  app: AppConfig
  /** The pi-durable harness, for anything the API below doesn't cover. */
  harness: Harness
  /** Give the agents tools, system prompt sections, hooks or tasks. */
  agent(extension: Extension): void
  settings: SettingsRegistry
  /** Answer `<name>.<method>` for clients. Throw an `RpcError` for a clean error. */
  method<P = any, R = unknown>(method: string, handler: (params: P) => R | Promise<R>): void
  /** A live value named `<name>.<key>`, starting at `initial`. */
  value<T extends Json>(key: string, initial: T): LiveValue<T>
  /** Say a session needs the user (it shows as blocked) while `contribute` returns something for it. */
  status(contribute: (sessionId: string) => StatusContribution | undefined): void
  /** Something `status` depends on changed: recompute and tell clients. */
  invalidate(): void
  sessions: {
    list(): Promise<SessionInfo[]>
    /** The session's conversation, to submit, write entries, or watch. */
    conversation(id: string): Promise<Conversation>
    /** The session a conversation belongs to: subagent conversations map to their top session. */
    of(conversationId: number): string | undefined
  }
}
