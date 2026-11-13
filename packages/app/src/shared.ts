// The contract between the main process and the renderer, exposed as `window.superego` by the preload.

export type MachineId = string
export type ConnectionState = 'connecting' | 'connected' | 'disconnected'
import type { MachineConfig } from '@superego/client/shared'
import type { SettingsStore } from '@superego/settings'
import type { MachineVersion, VersionDrift } from '@superego/protocol'

export type { MachineConfig }

export type MachineEntry = {
  id: MachineId; label: string; state: ConnectionState | 'disabled'; error?: string; errorKind?: string
  /** Who answered, from the last hello: the daemon's identity and hostname, and what it offers. */
  machine?: { id: string; hostname: string }
  features?: string[]
  /** Absent for this computer, which can't be removed. */
  remote?: { route: string; enabled: boolean }
  /** Which Superego it runs, from the last hello. */
  version?: MachineVersion
  /** A remote machine's Superego next to this computer's; absent when this computer can't tell. */
  drift?: VersionDrift
  /** Its Superego being updated (Update), or how that last went: the script's output so far. */
  update?: MachineUpdate
}

export type MachineUpdate = { state: 'running' | 'done' | 'failed'; log: string; error?: string }


/**
 * The app's settings kept under another key now: a value stored under the old one is read as the new one's (and saved
 * so), by the desktop app and a browser alike.
 */
export const APP_MOVED: Record<string, string> = {
  // The order sessions and threads go in is the window's own (the navigator and ⌘⇧[ ] walk it), not the sidebar's.
  'threads.sort': 'app.sort',
  // Where ⌘. looks is the unread extension's.
  'app.unread': 'unread.scope',
}

/** Actions known by another id now: a shortcut set for the old one (in `app.keys`) is the new one's. */
export const ACTIONS_MOVED: Record<string, string> = {
  // Changes moved into the git extension.
  'panes.changes': 'git.changes',
  // ⌘. moved into the unread extension.
  'thread.unread': 'unread.next',
}

/** `store` with what `app.keys` holds for an action's old id read as its new one's (and saved so). */
export function withMovedActions(store: SettingsStore): SettingsStore {
  return {
    load() {
      const values = store.load()
      const keys = values['app.keys']
      if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return values
      const moved = { ...keys }
      for (const [old, now] of Object.entries(ACTIONS_MOVED)) {
        if (old in moved && !(now in moved)) moved[now] = moved[old]!
        delete moved[old]
      }
      return { ...values, 'app.keys': moved }
    },
    save: (values) => store.save(values),
  }
}

/** A notification from a machine's daemon, `$connection` when a link's state changes, or `$machines` with the whole list. */
export type SuperegoEvent = { machine: MachineId; method: string; params: unknown }

export type CallResult = { ok: true; result: unknown } | { ok: false; error: { kind: string; message: string } }

export type SuperegoBridge = {
  call(machine: MachineId, method: string, params: unknown): Promise<unknown>
  machines(): Promise<MachineEntry[]>
  onEvent(listener: (event: SuperegoEvent) => void): () => void
  /** Set in a browser (the daemon's Web access), where there is no desktop: no machines to add, no folders to pick. */
  web?: boolean
  /** Where an artifact (an HTML file in a thread's folder) is served from, sandboxed, with its relative files beside it. */
  artifactUrl?(machine: MachineId, thread: string, path: string): string
}

/** An artifact's address on the desktop: superego-artifact://<machine>/<thread>/<path>, served by the main process. */
export const artifactUrl = (machine: MachineId, thread: string, path: string) =>
  `superego-artifact://${encodeURIComponent(machine)}/${encodeURIComponent(thread)}/${path.split('/').map(encodeURIComponent).join('/')}`

/** What an artifact may do: run its own scripts and forms, nothing of the app's (an opaque origin). */
export const ARTIFACT_POLICY = "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: 'unsafe-inline' 'unsafe-eval'"

export const ARTIFACT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
}

export const CHANNEL = { call: 'superego:call', machines: 'superego:machines', event: 'superego:event' } as const

/** Text sizes (Settings → Appearance), smallest first: each a step of 1px on the interface's 13px. */
export const TEXT_SIZES = ['xs', 'sm', 'base', 'lg', 'xl'] as const
/** How much a text size scales every size of text (--superego-text-scale); 1 for an unknown one. */
export const textScale = (size: unknown) => {
  const step = TEXT_SIZES.indexOf(size as (typeof TEXT_SIZES)[number])
  return step < 0 ? 1 : (11 + step) / 13
}
