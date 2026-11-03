// The contract between the main process and the renderer, exposed as `window.mu` by the preload.

export type MachineId = string
export type ConnectionState = 'connecting' | 'connected' | 'disconnected'
/**
 * A machine the app connects to besides this computer: reached with `ssh <target> <command>`, or with `via`, any shell
 * command whose stdin and stdout reach a mu daemon (`docker exec -i box mu connect --start`, `fly ssh console ...`).
 */
export type MachineConfig = {
  id: MachineId; label: string; target: string; command?: string; via?: string; enabled: boolean
  /** The identity of the daemon first reached at `target`; a different one answering there is refused. */
  daemonId?: string
}
export type MachineEntry = {
  id: MachineId; label: string; state: ConnectionState | 'disabled'; error?: string; errorKind?: string
  /** Who answered, from the last hello: the daemon's identity and hostname, and what it offers. */
  machine?: { id: string; hostname: string }
  features?: string[]
  /** Absent for this computer, which can't be removed. */
  remote?: { route: string; enabled: boolean }
}

/** What `ssh <target>` runs when a machine doesn't say. */
export const DEFAULT_REMOTE_COMMAND = 'mu connect --start'

/** A notification from a machine's daemon, `$connection` when a link's state changes, or `$machines` with the whole list. */
export type MuEvent = { machine: MachineId; method: string; params: unknown }

export type CallResult = { ok: true; result: unknown } | { ok: false; error: { kind: string; message: string } }

export type MuBridge = {
  call(machine: MachineId, method: string, params: unknown): Promise<unknown>
  machines(): Promise<MachineEntry[]>
  onEvent(listener: (event: MuEvent) => void): () => void
}

export const CHANNEL = { call: 'mu:call', machines: 'mu:machines', event: 'mu:event' } as const
