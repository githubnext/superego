// An app built on mu: its identity. Everything that names the app on disk, on the command line or on screen comes
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
  /** Where the app lives; sent to model providers as attribution. */
  url?: string
  /** macOS bundle identifier, reverse-DNS (`com.githubnext.mu`). Running from source it gets `.dev` added. */
  bundleId?: string
}

export function defineApp(config: AppConfig): AppConfig {
  if (!/^[a-z][a-z0-9-]*$/.test(config.id)) throw new Error(`App id "${config.id}" must be lowercase letters, digits and dashes`)
  return config
}

/** The environment variable for `key` in this app: `MU_HOME` for mu, `MY_AGENT_HOME` for my-agent. */
export const envName = (app: AppConfig, key: string) => `${app.id.toUpperCase().replace(/-/g, '_')}_${key}`

/** What `ssh <host>` runs to reach this app's daemon there, unless a machine says otherwise. */
export const remoteCommand = (app: AppConfig) => `${app.id} connect --start`
