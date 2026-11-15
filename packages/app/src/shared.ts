// The contract between the main process and the renderer, exposed as `window.superego` by the preload.
import type { ConnectionState, MachineConfig, MachineEntry as Base, MachineId } from '@superego/client/shared'
import type { SettingsStore } from '@superego/settings'
import { MIGRATIONS, waitingForSignIn, type ProviderRejection, type ThreadInfo, type VersionDrift } from '@superego/protocol'

export type { ConnectionState, MachineConfig, MachineId }

/** A machine as the window shows it: what its link says (see @superego/client), and what this computer adds. */
export type MachineEntry = Base & {
  /** A remote machine's Superego next to this computer's; absent when this computer can't tell. */
  drift?: VersionDrift
  /** Its Superego being updated (Update), or how that last went: the script's output so far. */
  update?: MachineUpdate
}

export type MachineUpdate = { state: 'running' | 'done' | 'failed'; log: string; error?: string }

/** The app's command on the PATH, as Settings → Command line shows it (see main/command-line.ts). */
export type CommandLineInfo = {
  /** Where it goes. */
  path: string
  /** Packaged, a script is installed; from a checkout, the bin is linked. Null: neither is there to offer. */
  kind: 'script' | 'link' | null
  /** Whether `path` is this app's (`installed`), something else's (`other`), or not there. */
  state: 'installed' | 'other' | 'missing'
  /** What a login shell runs for `<id>`, when it's installed but the shell finds something else, or nothing. */
  shadowed?: string | null
}


/**
 * What a notification says of a thread that wants a look now (it finished, failed or needs you); nothing for any other
 * state. `app.notify` shows one: in the desktop app once however many windows ask, in a browser with Web Notifications.
 */
export type ThreadNotice = { machine: MachineId; thread: string; title: string; body: string }
export function threadNotice(machine: MachineId, thread: ThreadInfo): ThreadNotice | undefined {
  const { state, msg } = thread.status
  // Waiting for sign-in: one notice for the machine says so (signInNotice), not one per thread.
  if (waitingForSignIn(thread.status)) return undefined
  const body = state === 'done' ? 'Finished' : state === 'error' ? `Failed${msg ? `: ${msg}` : ''}` : state === 'blocked' ? 'Needs you' : undefined
  return body ? { machine, thread: thread.id, title: thread.title, body } : undefined
}

/** How many threads wait for sign-in, as the notice says it. */
export const waitingPhrase = (count: number) =>
  count === 0 ? 'New turns wait until you sign in again.' : `${count} thread${count === 1 ? ' is' : 's are'} waiting.`

/**
 * The one notification for a provider rejecting a machine's credentials, however many threads it stops: clicking it
 * shows the first of them (where the notice says what to do). Nothing while none waits.
 */
export function signInNotice(machine: MachineId, rejection: Pick<ProviderRejection, 'summary' | 'threads'>): ThreadNotice | undefined {
  const first = rejection.threads[0]
  return first ? { machine, thread: first, title: rejection.summary, body: `${waitingPhrase(rejection.threads.length)} Sign in again to go on.` } : undefined
}

/** The notifications extension's setting: whether to notify at all (the desktop app reads it with no window open too). */
export const NOTIFY = 'notifications.enabled'

/**
 * The app's settings kept under another key now: a value stored under the old one is read as the new one's (and saved
 * so), by the desktop app and a browser alike.
 */
export const APP_MOVED: Record<string, string> = MIGRATIONS['app-settings'].renames

/** Actions known by another id now: a shortcut set for the old one (in `app.keys`) is the new one's. */
export const ACTIONS_MOVED: Record<string, string> = MIGRATIONS['action-keys'].renames

/**
 * Where the window's views go (see renderer/layout.ts): edited as text (layout.json, see main/layout-file.ts; in a
 * browser, in the window) and from the views' own menus. In Settings, the way to both and back to the defaults, which
 * no layout can take away.
 */
export const LAYOUT_SETTING = {
  key: 'app.layout', title: 'Layout', default: {}, description: 'Where views go. Each view\'s menu moves it too.', type: { type: 'layout' },
} as const

/**
 * `store` with the placement settings there were before views were placed by `app.layout` read into it (and saved so,
 * with the next change): `threads.details` on is the threads' details in the aside. A migration of stored settings
 * (MIGRATIONS' `layout`), not of the wire.
 */
export function withMovedLayout(store: SettingsStore): SettingsStore {
  return {
    load() {
      const values = store.load()
      if (!('threads.details' in values)) return values
      const { 'threads.details': details, ...rest } = values
      const layout = rest['app.layout']
      const kept = layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : {}
      const place = kept.place && typeof kept.place === 'object' && !Array.isArray(kept.place) ? kept.place : {}
      if (details !== true || 'threads.details' in place) return rest
      return { ...rest, 'app.layout': { ...kept, place: { ...place, 'threads.details': 'aside' } } }
    },
    save: (values) => store.save(values),
  }
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
