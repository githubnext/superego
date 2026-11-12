// Machine types and helpers with no Node imports, so a browser renderer can use them too.
import { remoteCommand, type AppConfig, type KeepsRunning } from '@superego/protocol'

/**
 * A machine a client connects to besides this computer: reached with `ssh <target> <command>`, or with `via`, any shell
 * command whose stdin and stdout reach the app's daemon (`docker exec -i box superego connect --start`, `fly ssh console ...`).
 */
export type MachineConfig = {
  id: string; label: string; target: string; command?: string; via?: string; enabled: boolean
  /** The identity of the daemon first reached there; a different one answering is refused. */
  daemonId?: string
}

/** How a machine is reached, as the user would type it. `ssh <target>` runs the app's remote command unless it says. */
export const routeOf = (config: MachineConfig, app: AppConfig) => config.via ?? `ssh ${config.target} ${config.command ?? remoteCommand(app)}`

export type MachineId = string
/**
 * `needs-login`: ssh wants a password, a code or a key it doesn't have, so the link waits for a login instead of
 * retrying. `host-key`: the host key is unknown or changed (the error says which), and it waits for that to be put right.
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'needs-login' | 'host-key'

/** A machine as a client shows it: its link's state, and what the last hello said. */
export type MachineEntry = {
  id: MachineId; label: string; state: ConnectionState | 'disabled'; error?: string; errorKind?: string
  /** Who answered, from the last hello: the daemon's identity and hostname, and what it offers. */
  machine?: { id: string; hostname: string }
  /** Whether its daemon will outlive a logout and a reboot, from the last hello. */
  keepsRunning?: KeepsRunning
  features?: string[]
  /** Absent for this computer, which can't be removed. */
  remote?: { route: string; enabled: boolean; /** Reached with ssh, so it can log in and have Superego installed. */ ssh: boolean }
}
