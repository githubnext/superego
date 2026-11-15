// The contract between the main process and the renderer, exposed as `window.superego` by the preload.
import type { ConnectionState, MachineConfig, MachineEntry as Base, MachineId } from '@superego/client/shared'
import type { SettingSpec, SettingsStore } from '@superego/settings'
import { firstLine, lastParagraph, MIGRATIONS, shorten, waitingForSignIn, type Channel, type ProviderRejection, type ThreadInfo, type VersionDrift } from '@superego/protocol'

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


/** What happened to a thread, as its notification says first: the desktop's subtitle, the start of a browser's body. */
export type NoticeStatus = 'Finished' | 'Needs you' | 'Failed'

/**
 * What a notification says of a thread that wants a look now (it finished, failed or needs you); nothing for any other
 * state. `title` is the thread's; `status` what happened; `text`, in a line, what it did (its recap), what it asks, or
 * why it failed, when that's known. `app.notify` shows one, each place laying it out its own way (`desktopNotice`,
 * `browserNotice`): in the desktop app once however many windows ask, in a browser with Web Notifications.
 */
export type ThreadNotice = { machine: MachineId; thread: string; title: string; status?: NoticeStatus; text?: string }
export function threadNotice(machine: MachineId, thread: ThreadInfo): ThreadNotice | undefined {
  const { state, msg } = thread.status
  // Waiting for sign-in: one notice for the machine says so (signInNotice), not one per thread.
  if (waitingForSignIn(thread.status)) return undefined
  // A child working for its parent: the parent hears it finish or fail. It still says when it needs you.
  if (state !== 'blocked' && reportsToParent(thread)) return undefined
  const status = state === 'done' ? 'Finished' : state === 'error' ? 'Failed' : state === 'blocked' ? 'Needs you' : undefined
  if (!status) return undefined
  // Done, the daemon's recap; blocked, the question (its last paragraph, after any context); error, its first line.
  const text = msg ? state === 'done' ? shorten(msg) : state === 'error' ? firstLine(msg) : lastParagraph(msg) : undefined
  return { machine, thread: thread.id, title: thread.title, status, ...(text ? { text } : {}) }
}

/** Whether a thread works for its parent, which hears how its runs end (the thread-reports extension says so). */
export const reportsToParent = (thread: ThreadInfo) => {
  const fact = thread.ext?.['thread-reports']
  return Boolean(fact && typeof fact === 'object' && !Array.isArray(fact) && fact.toParent === true)
}

/**
 * A notice as the desktop shows it: what happened under the title, with the machine's name when several are connected,
 * and the text below. One without a status (sign-in's) names the machine there, whatever.
 */
export function desktopNotice(notice: ThreadNotice, machine: { label: string; several: boolean }) {
  const subtitle = notice.status ? (machine.several ? `${notice.status} · ${machine.label}` : notice.status) : machine.label
  return { title: notice.title, subtitle, body: notice.text ?? '' }
}

/** A notice as a browser shows it, with no subtitle: "Finished: <text>", or just what happened when there's no text. */
export function browserNotice(notice: ThreadNotice) {
  const body = notice.status ? (notice.text ? `${notice.status}: ${notice.text}` : notice.status) : notice.text ?? ''
  return { title: notice.title, body }
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
  return first ? { machine, thread: first, title: rejection.summary, text: `${waitingPhrase(rejection.threads.length)} Sign in again to go on.` } : undefined
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
 * How a thread's panes are laid out beside it (see renderer/panes.tsx): `scroll`, a column each, the row scrolling past
 * the window's edge; `stack`, one column they share, one shown at a time. The pane strip's switch and an action change it.
 */
export const PANE_LAYOUT = 'app.panes.layout'
export type PaneLayout = 'scroll' | 'stack'
export const PANE_LAYOUT_SETTING: SettingSpec = {
  key: PANE_LAYOUT, title: 'Panes', default: 'scroll', description: 'Stacked, they share one column, as tabs.',
  type: { type: 'choice', options: [{ value: 'scroll', label: 'Scroll' }, { value: 'stack', label: 'Stack' }] },
}

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
  /**
   * Open a channel of `kind` on a machine's daemon: a byte stream both ways (a terminal's). Absent from a bridge
   * that can't; in a browser, only to the daemon that served the page.
   */
  channel?(machine: MachineId, kind: string, params: unknown): Promise<BridgeChannel>
}

/**
 * One of the protocol's channels (its channels.ts), as the window holds it. What the daemon sends comes to `onData` a
 * chunk at a time, the next once the listener's promise settles, so a slow reader slows the sender; `write` sends,
 * `close` gives up. `onClose` hears it end: closed from either side, or with the link (a reason then).
 */
export type BridgeChannel = {
  write(bytes: Uint8Array): void
  onData(listener: (bytes: Uint8Array) => void | Promise<void>): void
  onClose(listener: (reason?: string) => void): void
  close(): void
}

/** A protocol channel as a bridge hands it to the window. */
export function bridgeChannel(channel: Channel): BridgeChannel {
  const listeners = new Set<(reason?: string) => void>()
  let closed: { reason?: string } | undefined
  const end = (reason?: string) => {
    if (closed) return
    closed = reason ? { reason } : {}
    // Its own half too, once the other side ended: nothing more will be written.
    channel.end()
    for (const listener of listeners) listener(reason)
  }
  channel.ended.then(() => end(), (error: Error) => end(error.message))
  return {
    write: (bytes) => { channel.write(bytes).catch(() => {}) },
    onData: (listener) => channel.onData(listener),
    onClose: (listener) => { if (closed) listener(closed.reason); else listeners.add(listener) },
    close: () => channel.abort('Closed'),
  }
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

export const CHANNEL = {
  call: 'superego:call', machines: 'superego:machines', event: 'superego:event',
  // A window's protocol channels, held for it by the main process: opened, ready for data (once the window knows its
  // id), their data, written, read, closed, and all of a window's dropped as its page (re)loads.
  open: 'superego:ch-open', start: 'superego:ch-start', data: 'superego:ch-data', write: 'superego:ch-write', ack: 'superego:ch-ack', close: 'superego:ch-close', reset: 'superego:ch-reset',
} as const
/** What the main process tells a window of one of its channels: a chunk, or that it closed (and why, when it failed). */
export type ChannelEvent = { id: string; data: Uint8Array } | { id: string; closed: true; reason?: string }

/** Text sizes (Settings → Appearance), smallest first: each a step of 1px on the interface's 13px. */
export const TEXT_SIZES = ['xs', 'sm', 'base', 'lg', 'xl'] as const
/** How much a text size scales every size of text (--superego-text-scale); 1 for an unknown one. */
export const textScale = (size: unknown) => {
  const step = TEXT_SIZES.indexOf(size as (typeof TEXT_SIZES)[number])
  return step < 0 ? 1 : (11 + step) / 13
}
