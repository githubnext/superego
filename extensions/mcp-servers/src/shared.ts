// What both halves agree on (and the command line, and Ego's tool): what the extension is, a server's config as
// `<dataDir>/mcp-servers.json` keeps it, what Settings → MCP servers draws (the live value `mcp-servers.servers`, the
// section's data), what a thread says of its servers (`thread.facts['mcp-servers']`), and the actions
// with their params. See docs/mcp.md.
import { arr, bool, lit, map, num, obj, oneOf, opt, str, union, type Static } from '@earendil-works/pi-schema'
import type { ExtensionAbout, Json } from '@superego/protocol'

/** The machine's servers, in the data folder. */
export const CONFIG_FILE = 'mcp-servers.json'
/** Their secrets (keys, OAuth tokens), in the data folder. */
export const SECRETS_FILE = 'mcp-auth.json'

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = {
  name: 'mcp-servers', version: '1.0.0', api: '^5', title: 'MCP servers', group: 'agent',
  description: "Give agents other people's tools: the MCP servers this machine runs or reaches, signed in to once.",
  // The servers' secrets, and their configs, whose env and header values may hold keys too.
  secrets: [SECRETS_FILE, CONFIG_FILE],
} satisfies ExtensionAbout

// ── Config ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A server's name: its tools' prefix (`mcp__<name>__<tool>`), and what a profile's `mcpServers` names it by. */
export const SERVER_NAME = /^[a-z][a-z0-9-]{0,23}$/

/**
 * An MCP server a profile defines (in `mcpServers`, as an object of servers by name): a command (stdio) or a URL
 * (Streamable HTTP), and how it signs in. Field names as Claude Code's and Cursor's `mcpServers`.
 */
export type ProfileServer = {
  title?: string
  command?: string
  args?: string[]
  /** Where a command runs: the project's root (the folder holding the profile's `.superego`) unless this says. */
  cwd?: string
  /** Plain values only: a secret goes in `auth: { type: 'env', names }`, its value entered in Settings. */
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  auth?: ServerAuth
  /** One process (or session) for every thread that has it, or one per thread. Default `machine`. */
  lifetime?: 'machine' | 'thread'
  /** How its tools reach the model: as they are, found by search, or decided by how many (`auto`, the default). */
  tools?: 'auto' | 'all' | 'search'
  /** Seconds a call may take, reset by its progress. */
  timeout?: number
}

/** How a server signs in: OAuth, an API key, or a command's secret environment variables. */
export type ServerAuth =
  | { type: 'oauth'; scopes?: string[]; clientId?: string }
  /** Sent as `<header>: <scheme> <key>`; by default `Authorization: Bearer <key>`. */
  | { type: 'api-key'; header?: string; scheme?: string }
  /** Secret environment variables of a command, by name. */
  | { type: 'env'; names: string[] }

/**
 * A profile's `mcpServers` (its key in profiles: see `profileKey`): the machine's servers its threads use, by name, and
 * servers of its own, as objects of servers by name: `['linear', { docs: { command: 'node', args: ['docs.js'] } }]`.
 * With `extends`, both profiles' together, a server of its own by name the profile's winning.
 */
export type ProfileServers = (string | Record<string, ProfileServer>)[]

/** This extension's key in profiles. */
export const PROFILE_KEY = 'mcpServers'

/**
 * A server of the machine's (`mcp-servers.json`), or one a profile defines (in `mcpServers`, without the last three): a
 * command (stdio) or a URL (Streamable HTTP; SSE is tried when the URL answers as SSE). Field names as Claude Code's
 * and Cursor's `mcpServers`. It holds no secrets: those are in `mcp-auth.json`, set with `mcp-servers.set-secret`.
 */
export type ServerConfig = ProfileServer & {
  /** Used by threads without a profile ("Use in threads without a profile"). Default false. */
  unprofiled?: boolean
  /** Default true. Off, no thread has it, and it doesn't run. */
  enabled?: boolean
  /** A command someone other than the user added (Ego): it doesn't run until the user allows it (`mcp-servers.allow`). */
  allowed?: false
}

/** `<dataDir>/mcp-servers.json`. */
export type ServersFile = { servers: Record<string, ServerConfig> }

/** Defaults, where a config leaves them out. */
export const DEFAULTS = { lifetime: 'machine', tools: 'auto', timeout: 300 } as const

const AUTH = union([
  obj({ type: lit('oauth'), scopes: opt(arr(str())), clientId: opt(str()) }),
  obj({ type: lit('api-key'), header: opt(str()), scheme: opt(str()) }),
  obj({ type: lit('env'), names: arr(str({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' })) }),
])

/** A server's config as the actions take it (`allowed` is the extension's to set: see `mcp-servers.allow`). */
export const SERVER_CONFIG = obj({
  title: opt(str()),
  command: opt(str()), args: opt(arr(str())), cwd: opt(str()), env: opt(map(str())),
  url: opt(str()), headers: opt(map(str())),
  auth: opt(AUTH),
  lifetime: opt(oneOf(['machine', 'thread'])),
  tools: opt(oneOf(['auto', 'all', 'search'])),
  timeout: opt(num({ minimum: 1 })),
  unprofiled: opt(bool()),
  enabled: opt(bool()),
})

// ── What Settings draws ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How a server stands:
 * - `off`: switched off (`enabled: false`)
 * - `waiting`: a command waiting for the user's Allow
 * - `stopped`: not running now (its tools are still offered, from the cache); started when a thread needs it
 * - `starting`, `running`
 * - `needs-sign-in`: no key or secret value set yet, not signed in (OAuth), or its key or sign-in was refused
 * - `failed`: crashed three times within a minute, or couldn't start; until Restart or a change to its config
 */
export type ServerState = 'off' | 'waiting' | 'stopped' | 'starting' | 'running' | 'needs-sign-in' | 'failed'

/** Where a server is from: the machine's own list, or a profile's `mcpServers`. */
export type ServerSource =
  | { type: 'machine' }
  /** `dir`: the profile's folder; `project`: the folder holding its `.superego` (where its commands run). */
  | { type: 'profile'; profile: string; scope: 'user' | 'project'; dir: string; project: string }

/** A secret a server needs, and whether it's set (the value never leaves the machine). */
export type SecretInfo = {
  /** `key` for an API key; the variable's name for `auth: { type: 'env' }`. */
  name: string
  set: boolean
  /** It may be set, and needn't be: `client-secret`, for an OAuth client registered by hand. */
  optional?: true
}

/** The secret of an OAuth client registered by hand (`auth.clientId`), when it has one: set with `set-secret`. */
export const CLIENT_SECRET = 'client-secret'

/** How an OAuth server's sign-in stands (never its tokens). */
export type SignInInfo = {
  signedIn: boolean
  /** When it was signed in (ms). */
  since?: number
  /** When its access token runs out (ms), when the server said; it's refreshed before then when `refreshes`. */
  expires?: number
  refreshes?: true
  /** The scope it was granted, as the server said. */
  scope?: string
}

/** A server, as Settings → MCP servers draws it. */
export type ServerInfo = {
  /** Its id: the name for the machine's own, `<profile dir>#<name>` for a profile's. Actions take it as `server`. */
  id: string
  name: string
  title?: string
  from: ServerSource
  /**
   * A profile's server: whether its profile has loaded (so was allowed) since the daemon started. Until it has (a turn of
   * one of its threads), it doesn't run: its tools are offered from the cache, and its calls fail saying so.
   */
  profileAllowed?: boolean
  /** What it runs, in a line: `npx -y @sentry/mcp-server`, or `mcp.linear.app`. */
  runs: string
  /** Its config: the machine's as in the file, a profile's as the profile says. */
  config: ServerConfig
  state: ServerState
  /** Why it's failed or needs sign-in, or the last error, in a line. */
  error?: string
  /** How many tools it offers (from its last listing), and whether they're found by search rather than offered. */
  tools?: number
  deferred?: boolean
  /** Tools it lists that can't be offered (a schema that won't go), and why. */
  skipped?: { tool: string; why: string }[]
  /** The secrets its `auth` needs (API key or env), each set or not; and `client-secret`, which it may have. */
  secrets: SecretInfo[]
  /** For `auth: { type: 'oauth' }`: whether it's signed in, since when, until when. */
  oauth?: SignInInfo
  /** What it says it is (`initialize`), once it ran. */
  server?: { name: string; version?: string }
  /** When its tools were last listed (ms). */
  listedAt?: number
  /** For `lifetime: 'thread'`: how many threads have a process of it running now. */
  running?: number
}

/**
 * The section's `data` (`settings.watch`'s section `mcp-servers`, `ui: 'mcp-servers'`), and the live value
 * `mcp-servers.servers`, which is the same, kept current as servers start, stop and fail: draw from the value.
 * `servers`: the machine's, in the file's order; `profiles`: those of profiles seen on this machine (each once its
 * profile was allowed and a thread of it took a turn).
 */
export type SectionData = {
  servers: ServerInfo[]; profiles: ServerInfo[]
  /** Why `mcp-servers.json` doesn't read, if it doesn't. */
  problem?: string
}

/** The section's id and its `ui`, and the live value it draws from. */
export const SECTION = 'mcp-servers'
export const SERVERS_VALUE = 'mcp-servers.servers'

// ── What a thread says ──────────────────────────────────────────────────────────────────────────────────────────────

/** Why a server a thread would have isn't in it. */
export type LeftOutReason = 'missing' | 'off' | 'waiting'
export const LEFT_OUT: Record<LeftOutReason, string> = {
  missing: 'no such server here',
  off: 'switched off',
  waiting: 'waiting for Allow',
}

/**
 * `thread.facts['mcp-servers']`: the servers the thread's last turn had, each as it stands now, and those it would have
 * had and why not. Absent for threads with none and none left out (and hidden threads, which never have any).
 */
export type ThreadServers = {
  servers: { id: string; name: string; title?: string; from: 'machine' | 'profile'; state: ServerState; tools: number; deferred?: boolean; error?: string }[]
  left?: { name: string; why: LeftOutReason }[]
}

// ── Tools ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every MCP tool's name starts so: the window's rows match `mcp__*`. */
export const TOOL_PREFIX = 'mcp__'

/**
 * An MCP tool's name read back (`mcp__linear__create_issue`): its server, and its tool as the name has it (`toolName`
 * may have changed it to fit; a call's `details` say it exactly). None for a name that isn't one.
 */
export function splitToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(TOOL_PREFIX)) return undefined
  const rest = name.slice(TOOL_PREFIX.length)
  const at = rest.indexOf('__')
  return at > 0 ? { server: rest.slice(0, at), tool: rest.slice(at + 2) } : undefined
}

/**
 * What an MCP tool call's result carries for the window (`details`): the server and the tool by their own names, its
 * title, and its annotations as the server gave them (hints, not to be trusted).
 */
export type CallDetails = {
  server: string
  tool: string
  title?: string
  serverTitle?: string
  annotations?: { [key: string]: Json }
  /** Files the result's blobs were saved to, and the full text when it was cut. */
  files?: string[]
  /** It was running when Superego stopped, and isn't run again: it may or may not have taken effect. */
  interrupted?: true
}

/**
 * The diagnostic code of a call that was in flight when the daemon stopped: never run again, and the model is told it
 * may or may not have taken effect. Its `details` say so (`interrupted`), and the window draws it as "Interrupted: may
 * have run".
 */
export const INTERRUPTED = 'interrupted'

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// None is exposed to outside agents (`outside`): only the window and the command line. Allow is the window's alone: it's
// the user's consent to run a command (`consent`), and a command an agent adds or edits, through Ego's tool
// (`allowed: false`) or from a thread's shell, waits for it.

export const ACTIONS = {
  add: 'mcp-servers.add',
  edit: 'mcp-servers.edit',
  remove: 'mcp-servers.remove',
  /** Switch `unprofiled` or `enabled`, without sending the whole config. */
  set: 'mcp-servers.set',
  allow: 'mcp-servers.allow',
  setSecret: 'mcp-servers.set-secret',
  /** Forget its stored secrets, and its OAuth tokens. */
  signOut: 'mcp-servers.signOut',
  restart: 'mcp-servers.restart',
  log: 'mcp-servers.log',
  /**
   * Sign in with OAuth (`{ server }`), in the browser: answers `{ flow }` at once, which says how it goes (`auth.event`;
   * draw it with `SignInFlow`). Done once it's signed in and connected.
   */
  signIn: 'mcp-servers.signIn',
} as const

export const ADD_PARAMS = obj({
  name: str({ pattern: SERVER_NAME.source }),
  server: SERVER_CONFIG,
  /** `false`: a command an agent adds (Ego's tool): it waits for the user's Allow. One from a thread's shell always does. */
  allowed: opt(lit(false)),
})
/** Replaces a machine server's config whole; `rename` gives it a new name. `allowed: false` as for add. */
export const EDIT_PARAMS = obj({
  name: str(),
  server: SERVER_CONFIG,
  rename: opt(str({ pattern: SERVER_NAME.source })),
  allowed: opt(lit(false)),
})
export const NAME_PARAMS = obj({ name: str() })
export const SET_PARAMS = obj({ name: str(), unprofiled: opt(bool()), enabled: opt(bool()) })
/** A server by id: a machine's by name, a profile's as `<profile dir>#<name>`. */
export const SERVER_PARAMS = obj({ server: str() })
/**
 * Its secrets by name (`key` for an API key; each of `auth.names` for env), a value to set or `null` to forget. Only
 * names its `auth` asks for.
 */
export const SET_SECRET_PARAMS = obj({ server: str(), values: map(union([str(), lit(null)])) })
export const LOG_PARAMS = obj({ server: str(), lines: opt(num({ minimum: 1 })) })

export type AddParams = Static<typeof ADD_PARAMS>
export type EditParams = Static<typeof EDIT_PARAMS>
export type SetParams = Static<typeof SET_PARAMS>
export type SetSecretParams = Static<typeof SET_SECRET_PARAMS>
export type LogParams = Static<typeof LOG_PARAMS>

/**
 * What add, edit, allow, set-secret and restart answer: the server once it was started to check it (up to about 30s;
 * still `starting` after that, and the live value says how it went).
 */
export type CheckResult = { server: ServerInfo }

/** What `mcp-servers.log` answers: the last lines of its log, secrets replaced with `***`. */
export type LogResult = { path: string; text: string }
