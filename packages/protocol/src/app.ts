// An app built on Superego: its identity. Everything that names the app on disk, on the command line or on screen comes
// from here, so two apps (and two copies of one, in tests) never share a data dir, socket or lock.

export type AppConfig = {
  /** The display name: window titles, menus, notifications. */
  name: string
  /**
   * A lowercase slug: the data dir (`~/.<id>`), its socket and database, the command (`<id>`), the command a remote
   * machine runs (`<id> connect --start`), and the prefix of environment variables (`<ID>_HOME`, `<ID>_MODEL`, …).
   */
  id: string
  /** What the menu bar shows; a character or two. */
  glyph?: string
  /** What the app's own agent, the one that helps set the app up (`ego.ask`), is called. Else it's the app's own. */
  agent?: string
  /** Where the app lives; sent to model providers as attribution. */
  url?: string
  /** macOS bundle identifier, reverse-DNS (`com.githubnext.superego`). Running from source it gets `.dev.<checkout hash>` added. */
  bundleId?: string
  /**
   * The loopback port sign-in pages send the browser back to, `http://127.0.0.1:<port>/…`: MCP servers' OAuth
   * (`/mcp/callback`). Fixed per app, since an authorization server registers the address. Unset: 1456.
   */
  callbackPort?: number
}

export function defineApp(config: AppConfig): AppConfig {
  if (!/^[a-z][a-z0-9-]*$/.test(config.id)) throw new Error(`App id "${config.id}" must be lowercase letters, digits and dashes`)
  return config
}

/** The environment variable for `key` in this app: `SUPEREGO_HOME` for Superego, `MY_AGENT_HOME` for my-agent. */
export const envName = (app: AppConfig, key: string) => `${app.id.toUpperCase().replace(/-/g, '_')}_${key}`

/**
 * What tells a command it runs in a thread's shell, and whose (`SUPEREGO_THREAD=<thread id>`): set in the shell of every
 * agent's command, so the command line says so in `hello` (`from`) and the user's consent isn't an agent's to give.
 * It marks; it doesn't wall off: an agent runs as the user, and could run anything the user can.
 */
export const threadEnv = (app: AppConfig) => envName(app, 'THREAD')

/** The name of the app's own agent. */
export const agentName = (app: AppConfig) => app.agent ?? app.name

/** What `ssh <host>` runs to reach this app's daemon there, unless a machine says otherwise. */
export const remoteCommand = (app: AppConfig) => `${app.id} connect --start`

/**
 * What an extension is, as both its halves declare it (spread into `defineDaemonExtension` and `defineUiExtension`).
 * `required`: part of what the app is. It can't be turned off on a machine (Settings → Extensions lists only the
 * others), a profile can't do without it, and nothing else decides that. Unset: optional.
 */
export type ExtensionAbout = {
  /** Lowercase, unique in the app: `agent-ui`, `files`. Everything it registers is named `<name>.<something>`. */
  name: string
  /** How Settings names it, and what it does there; the name, and nothing, when unset. */
  title?: string
  description?: string
  required?: boolean
  /**
   * Its own version, semver: a major for a change its other half, a profile or a script relying on its methods,
   * actions, values or data can't follow; a minor for something added. Machines announce it. The window draws a UI
   * half for a machine's threads only where that machine runs it at the same major; a minor it relies on, the UI half
   * checks with `has(machine, 'ext:<name>@^1.2')`. Unset: 0.0.0.
   */
  version?: string
  /** The extension API it needs of the host, a semver range (`^1`, `^1.2`): a host it doesn't satisfy refuses it. Unset: any. */
  api?: string
  /**
   * The kinds of pane its UI half draws (`superego.pane(kind, …)` there), each with what it shows and the params it
   * takes: told to the agent, so pane_open can open them. Declared here, the window tells each machine, so an
   * extension whose work is all in the window needs no daemon half for its panes. A profile's are for its threads.
   */
  panes?: Record<string, string>
  /**
   * Files of its own in the data folder that hold keys, or values that may be (`mcp-auth.json`), by name: an agent that
   * reads the data folder (Ego) never reads them.
   */
  secrets?: string[]
}
