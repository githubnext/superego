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
  /** Set in a browser (the daemon's Web access), where there is no desktop: no machines to add, no folders to pick. */
  web?: boolean
  /** Where an artifact (an HTML file in a thread's folder) is served from, sandboxed, with its relative files beside it. */
  artifactUrl?(machine: MachineId, thread: string, path: string): string
}

/** An artifact's address on the desktop: mu-artifact://<machine>/<thread>/<path>, served by the main process. */
export const artifactUrl = (machine: MachineId, thread: string, path: string) =>
  `mu-artifact://${encodeURIComponent(machine)}/${encodeURIComponent(thread)}/${path.split('/').map(encodeURIComponent).join('/')}`

/** What an artifact may do: run its own scripts and forms, nothing of the app's (an opaque origin). */
export const ARTIFACT_POLICY = "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: 'unsafe-inline' 'unsafe-eval'"

export const ARTIFACT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
}

export const CHANNEL = { call: 'mu:call', machines: 'mu:machines', event: 'mu:event' } as const
