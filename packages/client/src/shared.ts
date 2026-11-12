// Machine types and helpers with no Node imports, so a browser renderer can use them too.
import { remoteCommand, type AppConfig } from '@superego/protocol'

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
