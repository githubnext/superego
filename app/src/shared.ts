// The contract between the main process and the renderer, exposed as `window.mu` by the preload.

export type MachineId = string
export type ConnectionState = 'connecting' | 'connected' | 'disconnected'
/** A machine the app connects to: this computer, or one reached with `ssh <target> <command>`. */
export type MachineConfig = { id: MachineId; label: string; target: string; command?: string; enabled: boolean }
export type MachineEntry = {
  id: MachineId; label: string; state: ConnectionState | 'disabled'; error?: string
  /** Absent for this computer, which can't be removed. */
  ssh?: { target: string; command: string; enabled: boolean }
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
