// What the daemon's parts share: the extension host (extension-host.ts), the profile host (profile-host.ts), the threads
// (threads.ts), the core's actions (actions.ts) and each connection's methods (handlers.ts). openDaemon (daemon.ts)
// makes one `Host` and hands it to each; what one part needs of another it's given by name.
import { homedir } from 'node:os'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { type Conversation, type createRegistry, defineDoc, type LiveState } from '@earendil-works/pi-durable'
import type { Exposure, Json, Pane, Router } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import type { AgentSettings } from './agent-settings.ts'
import type { AuthFlows } from './auth-flows.ts'
import type { DaemonOptions } from './daemon.ts'
import type { Allowances, ProfileRef } from './profiles.ts'
import type { Values } from './values.ts'

/** The context the daemon's own work runs in: none of it is cancelled from outside. */
export const context = BACKGROUND_CONTEXT

/**
 * What a daemon action gets besides its params: who called, and a way to tell that connection something; `exposure`,
 * when a client ran it as the command line or an outside agent (`action.run`).
 */
export type DaemonContext = { source: string; notify(event: string, params: unknown): void; exposure?: Exposure }

/** Which conversations are threads, oldest first; child conversations (subagents) aren't. */
export const Catalog = defineDoc<{ ids: number[] }>({
  kind: 'superego.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true,
})

/** A thread's own metadata, next to its transcript. */
export type ThreadMeta = {
  title: string; cwd: string; createdAt: number; seen?: { entryId?: number; failureTaskId?: number }
  /** The thread's own model and thinking; unset follows its profile, else this machine's settings. */
  model?: string; thinking?: string
  /** The profile it started with (see profiles.ts); unset runs plain Superego. */
  profile?: ProfileRef
  /** Put away: left out of the thread list (and the sidebar) until unarchived. */
  archived?: boolean
  /** To be archived once its run ends: asked by the thread itself (thread_archive), mid-turn. */
  archiveWhenDone?: boolean
  /** The panes open beside it, and the one in front. */
  panes?: Pane[]
  pane?: string
  /** Its project: the folder it belongs to (a repository's main checkout, or where it started). */
  root?: string
  /** In no list: an extension's own thread, opened by id. */
  hidden?: boolean
  /** The extension that made it, for a hidden thread: it takes no messages while that one is off. */
  owner?: string
  /** Extensions' state with it, by extension name (see `superego.state`). */
  ext?: Record<string, Json>
  /** Where its transcript starts now: the entry after the reset that last cleared it (`threads.clear`). */
  cleared?: number
  /** The thread that started it (by thread_start, or thread.start's `parent`). */
  parent?: string
}
export const ThreadDoc = defineDoc<ThreadMeta>({
  kind: 'superego.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current',
  initial: () => ({ title: '', cwd: '', createdAt: 0 }), checkpointWhen: () => true,
})

/** An extension's state with a thread. */
export const stateOf = (meta: ThreadMeta, name: string): Json | undefined =>
  meta.ext && Object.hasOwn(meta.ext, name) ? meta.ext[name] : undefined

/** One mounted thread: its conversation and a small watch that keeps its status current. */
export type Mounted = {
  conversation: Conversation; meta: ThreadMeta; live?: LiveState; lastEntryId?: number
  /** What the thread runs with (and whose model it is) and has spent, and when anything last happened in it. */
  model?: string; provider?: string; cost?: number; activeAt?: number
  /** The task of the last failed run it heard of (null: none), so each failure is looked at once. */
  failure?: number | null
  /** The credentials (a hash) its provider had as its run started: a rejection is for those, not any stored since. */
  ranWith?: string
  /** What its last run did, in a line (see recap.ts): its done status says it. */
  recap?: string
  stop(): Promise<unknown>
}

/** A plain copy of JSON. */
export const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T

/** A path as told to the user: under their home folder, from `~`. */
export const shortPath = (path: string) => path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path

export type Host = {
  options: DaemonOptions
  settings: SettingsRegistry
  /** Every intent this daemon answers, its own and its extensions'. Reads and watches are plain methods. */
  router: Router<DaemonContext>
  /** The agent parts installed, which each turn selects from. */
  registry: ReturnType<typeof createRegistry>
  agent: AgentSettings
  flows: AuthFlows
  values: Values
  /** The threads mounted now, by id (see threads.ts). */
  mounted: Map<string, Mounted>
  /** Something clients see of the threads changed: those watching hear it once it settles. */
  changed(): void
  /** Hear `changed`, until the returned stop. */
  onChanged(listener: () => void): () => void
  /** Set once a restart is accepted (no new work starts), and as it closes. */
  state: { restarting: boolean; closing: boolean }
  /** Where threads work when created without a cwd, and a folder as a client gives it (`~` its home), or that one. */
  defaultCwd: string
  folderOf(cwd: string | undefined): string
  /** The folder agents share: skills, `AGENTS.md`. */
  agentsDir: string
  /** The user's own profiles, and which projects' may run. */
  userProfiles: string
  allowances: Allowances
  /** How long an extension's setup (or a profile's modules loading) may take, in ms, and that said in words. */
  setupTimeout: number
  inTime: string
}
