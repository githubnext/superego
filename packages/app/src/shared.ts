// The contract between the main process and the renderer, exposed as `window.mu` by the preload.

export type MachineId = string
export type ConnectionState = 'connecting' | 'connected' | 'disconnected'
import type { MachineConfig } from '@mu/client/shared'

export type { MachineConfig }

export type MachineEntry = {
  id: MachineId; label: string; state: ConnectionState | 'disabled'; error?: string; errorKind?: string
  /** Who answered, from the last hello: the daemon's identity and hostname, and what it offers. */
  machine?: { id: string; hostname: string }
  features?: string[]
  /** Absent for this computer, which can't be removed. */
  remote?: { route: string; enabled: boolean }
}


/** A notification from a machine's daemon, `$connection` when a link's state changes, or `$machines` with the whole list. */
export type MuEvent = { machine: MachineId; method: string; params: unknown }

export type CallResult = { ok: true; result: unknown } | { ok: false; error: { kind: string; message: string } }

export type MuBridge = {
  call(machine: MachineId, method: string, params: unknown): Promise<unknown>
  machines(): Promise<MachineEntry[]>
  onEvent(listener: (event: MuEvent) => void): () => void
}

export const CHANNEL = { call: 'mu:call', machines: 'mu:machines', event: 'mu:event' } as const
