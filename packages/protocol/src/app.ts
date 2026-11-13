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
  /** macOS bundle identifier, reverse-DNS (`com.githubnext.superego`). Running from source it gets `.dev` added. */
  bundleId?: string
}

export function defineApp(config: AppConfig): AppConfig {
  if (!/^[a-z][a-z0-9-]*$/.test(config.id)) throw new Error(`App id "${config.id}" must be lowercase letters, digits and dashes`)
  return config
}

/** The environment variable for `key` in this app: `SUPEREGO_HOME` for Superego, `MY_AGENT_HOME` for my-agent. */
export const envName = (app: AppConfig, key: string) => `${app.id.toUpperCase().replace(/-/g, '_')}_${key}`

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
  /** Lowercase, unique in the app: `ask-user`, `files`. Everything it registers is named `<name>.<something>`. */
  name: string
  /** How Settings names it, and what it does there; the name, and nothing, when unset. */
  title?: string
  description?: string
  required?: boolean
}
