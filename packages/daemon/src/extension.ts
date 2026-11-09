// The daemon half of an extension. An extension is a package with up to two halves, imported by an app at build time:
// `<pkg>/daemon` runs here, next to the agents; `<pkg>/ui` runs in the app's window. This half can give the agents
// tools, prompt sections and hooks (pi-durable extensions), register settings, define actions, publish live values
// for the UI to watch, and add to a thread's status.
import type { Conversation, Extension, Harness } from '@earendil-works/pi-durable'
import type { ActionDef, AppConfig, BlockedKind, Json, ThreadInfo } from '@mu/protocol'
import type { DaemonContext } from './daemon.ts'
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
  /**
   * An action of this extension, named `<name>.<action>`: clients dispatch it by id, the command line and (later) MCP
   * by its exposure. Define it with `defineAction` and a params schema. Throw an `RpcError` for a clean error.
   */
  action(action: ActionDef<any, unknown, DaemonContext>): void
  /** A live value named `<name>.<key>`, starting at `initial`. */
  value<T extends Json>(key: string, initial: T): LiveValue<T>
  /** Say a thread needs the user (it shows as blocked) while `contribute` returns something for it. */
  status(contribute: (threadId: string) => StatusContribution | undefined): void
  /** Something `status` depends on changed: recompute and tell clients. */
  invalidate(): void
  threads: {
    list(): Promise<ThreadInfo[]>
    /** The thread's conversation, to submit, write entries, or watch. */
    conversation(id: string): Promise<Conversation>
    /** The thread a conversation belongs to: subagent conversations map to their top thread. */
    of(conversationId: number): string | undefined
  }
}
