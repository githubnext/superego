// Machine types and constants with no Node imports, so a browser renderer can use them too.

/**
 * A machine a client connects to besides this computer: reached with `ssh <target> <command>`, or with `via`, any shell
 * command whose stdin and stdout reach a mu daemon (`docker exec -i box mu connect --start`, `fly ssh console ...`).
 */
export type MachineConfig = {
  id: string; label: string; target: string; command?: string; via?: string; enabled: boolean
  /** The identity of the daemon first reached there; a different one answering is refused. */
  daemonId?: string
}

/** What `ssh <target>` runs when a machine doesn't say. */
export const DEFAULT_REMOTE_COMMAND = 'mu connect --start'

/** How a machine is reached, as the user would type it. */
export const routeOf = (config: MachineConfig) => config.via ?? `ssh ${config.target} ${config.command ?? DEFAULT_REMOTE_COMMAND}`
