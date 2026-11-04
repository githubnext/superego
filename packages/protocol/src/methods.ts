// The daemon's public method table. One place names every method, its params and its result; the daemon's dispatch,
// the typed client and (later) the CLI and schema are derived from it.
import type { ConversationView } from '@earendil-works/pi-durable'
import type { AuthEvent, Json, SettingsSnapshot } from './settings.ts'
import type { Status } from './status.ts'

/**
 * The protocol's generation. It changes only for a break no feature flag can bridge; a daemon and client of different
 * generations refuse each other. Everything else is additive and announced in `FEATURES`.
 */
export const PROTOCOL_VERSION = 2

/**
 * What a daemon of this build offers, announced in `hello`. Clients check a feature before using it, so an older
 * daemon on another machine keeps working with a newer app (and the other way round) for whatever both know.
 */
export const FEATURES = ['sessions', 'settings', 'auth', 'restart'] as const
export type Feature = (typeof FEATURES)[number]

export type SessionId = string

export type SessionInfo = {
  id: SessionId
  title: string
  cwd: string
  createdAt: number
  /** When anything last happened in it: a message, or work going on. Absent from older daemons. */
  activeAt: number
  /** The model its next turn runs with. */
  model?: string
  /** What it has spent so far, in dollars, as the providers price it. */
  cost?: number
  status: Status
}

/** `id` is the machine's identity: stable across restarts and routes, so a client can tell it is the same machine. */
export type MachineInfo = {
  id: string; hostname: string; platform: string; pid: number; dataDir: string
  /** The build of the code this daemon runs (see `readBuild`); clients compare it with what is on disk now. */
  build: string
}

export type Hello = { version: number; features: string[]; machine: MachineInfo; methods: string[] }

export type Methods = {
  hello: { params: { client: string; version: number; features?: string[] }; result: Hello }
  'session.list': { params: {}; result: SessionInfo[] }
  'session.create': { params: { cwd?: string; title?: string }; result: SessionInfo }
  'session.rename': { params: { id: SessionId; title: string }; result: null }
  'session.submit': { params: { id: SessionId; text: string; requestId?: string; whenBusy?: 'steer' | 'followUp' }; result: { submission: string } }
  'session.abort': { params: { id: SessionId }; result: null }
  /** The user looked at the session: its done/error status clears. */
  'session.seen': { params: { id: SessionId }; result: null }
  /** Snapshot of the conversation view, then `watch.ops` notifications with Chord delta ops against it. */
  'session.watch': { params: { id: SessionId }; result: { sub: string; value: ConversationView } }
  /** Snapshot of the session list, then `sessions.changed` notifications with the whole list. */
  'sessions.watch': { params: {}; result: { sub: string; value: SessionInfo[] } }
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
   * session is working, unless `interrupt`; interrupted runs resume after the restart. `build` must be the running
   * build, so a client never restarts a daemon it didn't inspect.
   */
  /** Snapshot of an extension's live value, then `value.changed` with each new one. */
  'value.watch': { params: { key: string }; result: { sub: string; value: Json } }
  'daemon.restart': { params: { build: string; interrupt?: boolean }; result: { restarted: boolean; busy: boolean } }
}

export type Notifications = {
  'watch.ops': { sub: string; ops: unknown[] }
  'watch.end': { sub: string; reason: string }
  'sessions.changed': { sub: string; value: SessionInfo[] }
  'settings.changed': { sub: string; value: SettingsSnapshot }
  'auth.event': { flow: string; event: AuthEvent }
  'value.changed': { sub: string; key: string; value: Json }
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
