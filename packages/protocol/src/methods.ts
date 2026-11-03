// The daemon's public method table. One place names every method, its params and its result; the daemon's dispatch,
// the typed client and (later) the CLI and schema are derived from it.
import type { ConversationView } from '@earendil-works/pi-durable'
import type { AuthEvent, Json, SettingsSnapshot } from './settings.ts'
import type { Status } from './status.ts'

export const PROTOCOL_VERSION = 2

export type SessionId = string

export type SessionInfo = {
  id: SessionId
  title: string
  cwd: string
  createdAt: number
  status: Status
}

export type MachineInfo = { hostname: string; platform: string; pid: number; dataDir: string }

export type Methods = {
  hello: { params: { client: string; version: number }; result: { version: number; machine: MachineInfo; methods: string[] } }
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
}

export type Notifications = {
  'watch.ops': { sub: string; ops: unknown[] }
  'watch.end': { sub: string; reason: string }
  'sessions.changed': { sub: string; value: SessionInfo[] }
  'settings.changed': { sub: string; value: SettingsSnapshot }
  'auth.event': { flow: string; event: AuthEvent }
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
