// The contract between the main process and the renderer, exposed as `window.superego` by the preload.
import type { ConnectionState, MachineConfig, MachineEntry as Base, MachineId } from '@superego/client/shared'
import type { AllowedUi } from '@superego/client'
import type { ActionInfo, ActionLogEntry, DeclaredSection, Methods, VersionDrift } from '@superego/protocol'
import type { ServiceState } from './service.ts'

export type { ConnectionState, MachineConfig, MachineId }

/** A machine as the window shows it: what its link to it says, and what this computer adds. */
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
   * Where a web page on `machine` loads from on this computer: a `localhost` address on another machine is forwarded
   * from there (main/forwards.ts), at the same port when it's free here; anything else is as it is. Absent where it
   * can't (a browser).
   */
  forward?(machine: MachineId, url: string): Promise<string>
  /**
   * A web page in a view of its own laid over the window (main/web-views.ts): a top-level page, as a browser tab has it,
   * so its cookies are first-party and a page that refuses to be framed loads. Absent in a browser, where a pane frames it.
   */
  webView?(options: { url: string; partition: WebViewPartition }): BridgeWebView
  /**
   * Open a channel of `kind` on a machine's daemon: a byte stream both ways (a terminal's). Absent from a bridge
   * that can't; in a browser, only to the daemon that served the page.
   */
  channel?(machine: MachineId, kind: string, params: unknown): Promise<BridgeChannel>
}

/**
 * One of the protocol's channels (a byte stream), as the window holds it. What the daemon sends comes to `onData` a
 * chunk at a time, the next once the listener's promise settles, so a slow reader slows the sender; `write` sends,
 * `close` gives up. `onClose` hears it end: closed from either side, or with the link (a reason then).
 */
export type BridgeChannel = {
  write(bytes: Uint8Array): void
  onData(listener: (bytes: Uint8Array) => void | Promise<void>): void
  onClose(listener: (reason?: string) => void): void
  close(): void
}

/**
 * Whose cookies and storage a web view has: web pages share theirs, kept between launches (`persist:browser`), as a
 * browser keeps a profile's; an artifact's (an HTML file of a thread's) are its own, gone as the app quits.
 */
export type WebViewPartition = 'browser' | 'artifact'

/** A box in the window's page, in its CSS pixels. */
export type WebViewRect = { x: number; y: number; width: number; height: number }

/** Where a web view's page is, as its window's main process tells it. */
export type WebViewState = {
  url: string
  title: string
  loading: boolean
  /**
   * How far its load has come while `loading`, 0–1, from the milestones Chromium tells of (the navigation started, its
   * response came, the document parsed); none when it's not loading. A page doesn't say more than that.
   */
  progress?: number
  canGoBack: boolean
  canGoForward: boolean
  /** Why the page last asked for didn't load (it isn't there, a certificate refused), or that it crashed. */
  error?: { code: number; description: string; url: string }
  /** What the page asks the user for now (a web page's), until they answer (`BridgeWebView.answer`). */
  ask?: PermissionAsk
}

/**
 * What a web page in a Browser pane may ask the user for: to reach apps on this computer (its loopback addresses) or devices on
 * its network, the camera, the microphone, to show notifications. Anything else is refused.
 */
export type SitePermission = 'loopback-network' | 'local-network' | 'camera' | 'microphone' | 'notifications'
/** A site asking for one or more permissions at once (the camera and the microphone, say). */
export type PermissionAsk = { origin: string; kinds: SitePermission[] }
export type SiteAnswer = 'granted' | 'denied'
/** What the user said, by site (origin) and permission. */
export type SitePermissions = Record<string, Partial<Record<SitePermission, SiteAnswer>>>

/**
 * What a web view tells its pane: where it is now; that it took the keyboard (Return, a click into it); a file it saved (to the
 * Downloads folder, as a browser does); something it asked for that was refused (geolocation, or anything an artifact
 * asks for), or that the system keeps from the app.
 */
export type WebViewEvent =
  | { type: 'state'; state: WebViewState }
  | { type: 'focus' }
  | { type: 'download'; name: string; path: string; state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' }
  | { type: 'denied'; permission: string }
  /** The user allowed the site the camera or microphone, but the system doesn't let the app use it. */
  | { type: 'blocked'; permission: 'camera' | 'microphone' }

/**
 * A web page over a pane, held by the main process (main/web-views.ts). It draws above the window's page, wherever it's
 * placed: `place` puts it at `rect`, or (not `shown`) keeps it that size out of sight, for a still of it (`snapshot`)
 * to show in its place while something of the window's is over it (see renderer/web-view.tsx); null hides it.
 */
export type BridgeWebView = {
  place(rect: WebViewRect | null, shown: boolean): void
  load(url: string): void
  go(by: -1 | 1): void
  reload(): void
  /** Stop loading what it's loading. */
  stop(): void
  /** Give it the keyboard (`true`), or, if it has it, give it back to the window. */
  focus(on: boolean): void
  /** A still of the page as it is now, as an image's bytes (PNG); none while it has nothing drawn. */
  snapshot(): Promise<Uint8Array | null>
  /** Show a file it saved in the Finder (or the system's file manager). */
  reveal(path: string): void
  /** The user's answer to what the page asks now (its state's `ask`). */
  answer(allow: boolean): void
  onEvent(listener: (event: WebViewEvent) => void): void
  close(): void
}

/** An artifact's address on the desktop: superego-artifact://<machine>/<thread>/<path>, served by the main process. */
export const artifactUrl = (machine: MachineId, thread: string, path: string) =>
  `superego-artifact://${encodeURIComponent(machine)}/${encodeURIComponent(thread)}/${path.split('/').map(encodeURIComponent).join('/')}`

export const CHANNEL = {
  call: 'superego:call', machines: 'superego:machines', event: 'superego:event', forward: 'superego:forward',
  // A window's web views (main/web-views.ts): opened, told what to do, a still of one, and what they tell their pane.
  viewOpen: 'superego:view-open', view: 'superego:view', viewSnapshot: 'superego:view-snapshot', viewEvent: 'superego:view-event',
  // A window's protocol channels, held for it by the main process: opened, ready for data (once the window knows its
  // id), their data, written, read and closed; the main process drops all of a window's as its page (re)loads.
  open: 'superego:ch-open', start: 'superego:ch-start', data: 'superego:ch-data', write: 'superego:ch-write', ack: 'superego:ch-ack', close: 'superego:ch-close',
} as const
/** What the main process tells a window of one of its channels: a chunk, or that it closed (and why, when it failed). */
export type ChannelEvent = { id: string; data: Uint8Array } | { id: string; closed: true; reason?: string }

/** A thread in a window: the one it shows, or one to show. */
export type ThreadRef = { machine: MachineId; thread: string }

/**
 * The methods the app answers as the machine `APP` (shared/app-settings.ts), besides its actions (`action.list`): the
 * desktop's main process answers all of them (main/app-endpoint.ts), a browser's page those it can (web-bridge.ts).
 */
export type AppHandlers = {
  'settings.watch'(params: Methods['settings.watch']['params']): Promise<Methods['settings.watch']['result']>
  unwatch(params: { sub: string }): Promise<null>
  /** A window's UI halves declare their settings; the app keeps them with its own. */
  'settings.register'(params: { section: DeclaredSection }): Promise<null>
  'action.list'(): Promise<ActionInfo[]>
  'action.log'(): Promise<ActionLogEntry[]>
  /** How Superego sits on the desktop now. */
  'service.get'(): Promise<ServiceState>
  /** The page is listening for app events: answer with what it was asked to show before it was. */
  'app.ready'(): Promise<{ open?: ThreadRef; settings?: boolean }>
  /**
   * Whether the window's build (the hash of the main process's sources as the window was loaded) differs from the one
   * the main process runs: then the window calls what the main process may not know, until the app restarts.
   */
  'app.build'(params: { build?: string }): Promise<{ differs: boolean }>
  /** The profile UIs from other machines allowed to run in this computer's windows (see profile-ui.ts). */
  'profileUi.allowed'(): Promise<AllowedUi[]>
  /** The ones put off ("Not now"), for the sources they were then: the window doesn't ask about those again. */
  'profileUi.declined'(): Promise<AllowedUi[]>
  /** A folder on this computer, chosen in the system's dialog; null when cancelled. */
  'app.pickFolder'(params: { defaultPath?: string }): Promise<string | null>
  /**
   * Another window, beside the one asking, starting as a copy of it: `state` is its own state, as its storage keeps it
   * (see local-state.ts), which the new one takes as its own.
   */
  'app.newWindow'(params: { state?: unknown }): Promise<null>
  /** Every window's id, open or kept to reopen: a window's storage keeps the state of these alone. */
  'app.windows'(): Promise<string[]>
  /**
   * The shortcuts that run actions in this window now. While a page in one of its panes has the keyboard, the page gets
   * key presses and the window never sees them: these are taken first and sent on (`app.key`).
   */
  'app.boundKeys'(params: { keys: string[] }): Promise<null>
  /**
   * The thread the window shows now (none: null): while the window has the focus, the app icon's count leaves it out.
   * A browser's page counts for itself (renderer/notifications.tsx).
   */
  'app.shown'(params: { selection: ThreadRef | null }): Promise<null>
  /** Update another machine's Superego (the window's `machine.update` action): its output shows on the machine's row in Settings. */
  'app.updateMachine'(params: { machine: string }): Promise<{ updated: boolean }>
  /** How the app sits on the desktop now: for the smoke test. */
  'app.desktop'(): Promise<{ menuBar: boolean; dockHidden: boolean }>
}
/**
 * The ones a page in a browser answers too (web-bridge.ts): the rest are the desktop's alone (its windows, folders,
 * shortcuts over a pane's page, the Dock), and answer `unsupported` there.
 */
export type BrowserAppHandlers = Pick<AppHandlers,
  'settings.watch' | 'unwatch' | 'settings.register' | 'action.list' | 'action.log' | 'service.get' | 'app.ready' |
  'profileUi.allowed' | 'profileUi.declined'>
