// The app's windows on the desktop: each an AppWindow, the one record of everything the main process keeps for it
// (its subscriptions, shortcuts, the thread it shows, what waits to be shown in it, its channels), torn down in one
// place as it closes. Kept between launches by WindowList (windows.ts), and reopened as they were left.
import { join } from 'node:path'
import { app, BrowserWindow, screen, session, shell, type WebContents } from 'electron'
import type { AppConfig, Channel } from '@superego/protocol'
import { CHANNEL, type AppHandlers, type SuperegoEvent, type ThreadRef } from '../shared/bridge.ts'
import { APP } from '../shared/app-settings.ts'
import { shortcutOf } from '../shared/shortcuts.ts'
import { attachContextMenu } from './context-menu.ts'
import { placeOn, WindowList, type Bounds } from './windows.ts'

/** What a window should show: a thread, or Settings. */
export type Show = { open?: ThreadRef; settings?: boolean }

/** One of a window's protocol channels, held for it on its machine's link: read there a chunk at a time. */
export type HeldChannel = { channel: Channel; reads: (() => void)[]; start(): void }

/** An open window, and everything the main process keeps for it. */
export class AppWindow {
  /** Its own id, kept between launches (its storage is kept by it, see local-state.ts). */
  readonly id: string
  readonly browser: BrowserWindow
  readonly contents: WebContents
  /** Its subscriptions on the app's endpoint (`settings.watch`), by sub. */
  readonly subs = new Map<string, () => unknown>()
  /** The shortcuts that run its actions now, as it last said (`app.boundKeys`). */
  boundKeys = new Set<string>()
  /** The thread it shows now, as it last said (`app.shown`). */
  shown: ThreadRef | undefined
  /** Whether its page listens for app events (`app.ready`): until then, what to show waits in `pending`. */
  ready = false
  pending: Show | undefined
  /** Whether it told the layout file its views (`app.layout.views`). */
  declaredViews = false
  /** Its protocol channels (a terminal's bytes, say), by id. */
  readonly channels = new Map<string, HeldChannel>()
  /** Its methods on the app's endpoint. */
  readonly methods: AppHandlers

  constructor(id: string, browser: BrowserWindow, methods: (window: AppWindow) => AppHandlers) {
    this.id = id
    this.browser = browser
    this.contents = browser.webContents
    this.methods = methods(this)
  }

  /** Tell its page of `event`, unless it's gone. */
  send(event: SuperegoEvent) { if (!this.contents.isDestroyed()) this.contents.send(CHANNEL.event, event) }
  /** Tell its page of one of the app's own events. */
  sendApp(method: string, params: unknown) { this.send({ machine: APP, method, params }) }
  /** Abort its channels: its page loaded again, or it closed. */
  dropChannels(reason = 'The window closed') { for (const held of this.channels.values()) held.channel.abort(reason) }

  /** Show what it was asked to, now if its page listens, else once it does. */
  show(what: Show) {
    if (!this.ready) { this.pending = what; return }
    if (what.open) this.sendApp('app.select', what.open)
    if (what.settings) this.sendApp('app.settings', null)
  }
}

/** A window's state as another passes it on (`app.newWindow`): its storage's keys and their values, as text. */
export function windowState(state: unknown): Record<string, string> | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined
  const entries = Object.entries(state).filter(([key, value]) => key.length <= 200 && typeof value === 'string')
  // It travels in the new window's address: a copy too big to be a window's state isn't one.
  return entries.reduce((size, [key, value]) => size + key.length + (value as string).length, 0) > 200_000 ? undefined : Object.fromEntries(entries) as Record<string, string>
}

export type WindowsOptions = {
  app: AppConfig
  dataDir: string
  headless: boolean
  /** A new window's methods on the app's endpoint. */
  methods(window: AppWindow): AppHandlers
  /** One opened or closed. */
  changed(): void
  /** One came to the front or left it. */
  focusChanged(): void
  /** One closed: what's kept for it elsewhere goes. */
  closed(window: AppWindow): void
}

export type Windows = ReturnType<typeof createWindows>

/** The app's windows: opened, reopened, brought forward, and asked to show a thread or Settings. */
export function createWindows({ app: appConfig, dataDir, headless, methods, changed, focusChanged, closed }: WindowsOptions) {
  /** Every window, open or put away, kept between launches (see windows.ts). */
  const list = new WindowList(join(dataDir, 'windows.json'))
  /** The open ones, by their id. */
  const byId = new Map<string, AppWindow>()

  const all = () => [...byId.values()]
  /** The open window whose page this is. */
  const of = (contents: WebContents) => all().find((window) => window.contents === contents)
  const focused = () => { const browser = BrowserWindow.getFocusedWindow(); return browser ? all().find((window) => window.browser === browser) : undefined }
  /** The open window last in front. */
  const recent = () => list.recent().map((id) => byId.get(id)).find((window) => window && !window.browser.isDestroyed())

  /**
   * The windows put away (the last one closed, or every one open as the app quit), reopened where they were, the one
   * last in front on top; none, a new one. Answers the one in front.
   */
  function reopen(): AppWindow {
    const open = recent()
    if (open) return open
    const closedOnes = list.closed()
    if (!closedOnes.length) return create()
    // The one last in front opens first (the app's first window), the others behind it.
    const [front, ...others] = closedOnes.map((entry) => create({ id: entry.id, ...(entry.bounds ? { bounds: entry.bounds } : {}) }))
    if (others.length && !headless) front!.browser.focus()
    return front!
  }

  /**
   * A window: one put away (`id`, at its `bounds`), or a new one, beside `near` (down and right of it, as the system
   * cascades) at its size, when given, starting with `seed` as its state.
   */
  function create({ id, bounds, near, seed }: { id?: string; bounds?: Bounds; near?: AppWindow; seed?: Record<string, string> } = {}): AppWindow {
    const beside = near && !near.browser.isDestroyed() ? near.browser.getBounds() : undefined
    const at: Partial<Bounds> = bounds ? placeOn(bounds, screen.getAllDisplays().map((d) => d.workArea))
      : beside ? { x: beside.x + 24, y: beside.y + 24, width: beside.width, height: beside.height } : {}
    const opened = list.open(id)
    const browser = new BrowserWindow({
      width: at.width ?? 1100, height: at.height ?? 760, minWidth: 600, minHeight: 400,
      ...(at.x !== undefined && at.y !== undefined ? { x: at.x, y: at.y } : {}),
      title: appConfig.name,
      titleBarStyle: 'hiddenInset',
      // Centred in the 48pt title bar (see --superego-titlebar).
      trafficLightPosition: { x: 18, y: 18 },
      backgroundColor: '#09090b',
      show: !headless,
      webPreferences: { preload: join(import.meta.dirname, '../preload/preload.cjs'), sandbox: true, contextIsolation: true },
    })
    const window = new AppWindow(opened.id, browser, methods)
    const contents = browser.webContents
    attachContextMenu(contents, { dev: !app.isPackaged })
    // Links (sign-in pages, docs) open in the browser, never in the app.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // App-wide shortcuts work wherever the keyboard is. A page in a pane (Preview, an artifact) is a frame of its own,
    // and its key presses never reach the window's page; so while one has the keyboard, a press that's one of the
    // window's shortcuts is taken here, before any frame, and sent to the window to run.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.meta || input.control || input.alt)) return
      const frame = contents.focusedFrame
      if (!frame || frame === contents.mainFrame) return
      const keys = shortcutOf({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift })
      if (!keys || !window.boundKeys.has(keys)) return
      event.preventDefault()
      window.sendApp('app.key', { keys })
    })
    // Back and forward from outside the page: a mouse's buttons (Windows, Linux) and a swipe (macOS, as its trackpad
    // setting lets one through). The window goes along its own history.
    const go = (by: -1 | 1) => window.sendApp('app.go', { by })
    browser.on('app-command', (_event, command) => {
      if (command === 'browser-backward') go(-1)
      if (command === 'browser-forward') go(1)
    })
    browser.on('swipe', (_event, direction) => {
      if (direction === 'left') go(-1)
      if (direction === 'right') go(1)
    })
    byId.set(opened.id, window)
    const moved = () => { if (!browser.isDestroyed()) list.moved(opened.id, browser.getNormalBounds()) }
    browser.on('moved', moved)
    browser.on('resized', moved)
    browser.on('closed', () => {
      byId.delete(opened.id)
      for (const stop of window.subs.values()) stop()
      window.subs.clear()
      window.dropChannels()
      list.close(opened.id)
      closed(window)
      changed()
    })
    browser.on('focus', () => { list.focused(opened.id); focusChanged() })
    browser.on('blur', () => focusChanged())
    // The page learns which window it is (its storage is kept by that, see local-state.ts) from its address, which
    // a reload keeps; whether it's the app's first; and once, what it starts with.
    const query: Record<string, string> = { window: opened.id, ...(opened.first ? { first: '1' } : {}), ...(seed ? { seed: JSON.stringify(seed) } : {}) }
    if (process.env.ELECTRON_RENDERER_URL) void browser.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query)}`)
    else void browser.loadFile(join(import.meta.dirname, '../renderer/index.html'), { query })
    if (!bounds) moved()
    if (!headless && near) browser.focus()
    changed()
    return window
  }

  /** The window that goes in front: the one with the focus, else the one last in front, else those put away, reopened. */
  function show(what: Show = {}) {
    const window = focused() ?? recent() ?? reopen()
    // Headless (tests), the window never comes forward: nothing on the screen, no focus taken from anyone.
    if (!headless) {
      if (window.browser.isMinimized()) window.browser.restore()
      window.browser.show()
      window.browser.focus()
      app.focus({ steal: true })
    }
    if (what.open || what.settings) window.show(what)
  }

  return {
    all, of, focused, recent, reopen, create, show,
    /** Every window's id, open or kept to reopen. */
    ids: () => list.ids(),
    /** Tell every window's page of `event`. */
    broadcast(event: SuperegoEvent) { for (const window of all()) window.send(event) },
    /** Put every window away, to come back as they were. */
    putAway() {
      list.keep(list.recent())
      for (const window of all()) window.browser.close()
    },
    /** The app is quitting: every window open comes back at the next launch. */
    quitting: () => list.quitting(),
  }
}

/**
 * What the windows' pages may do: list the installed fonts (font pickers, the Local Font Access API), and nothing else
 * asked for; and show a site in a Preview pane, which most sites refuse (X-Frame-Options, CSP frame-ancestors), there to
 * stop other sites wrapping them. Here the frame is the user's own pane, so for frames only, those refusals are
 * dropped; the frame stays sandboxed (no top navigation), and top-level loads are untouched.
 */
export function setUpSession() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'local-fonts'))
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'local-fonts')
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (details.resourceType !== 'subFrame' || !details.responseHeaders) return callback({})
    const headers: Record<string, string[]> = {}
    for (const [name, values] of Object.entries(details.responseHeaders)) {
      const key = name.toLowerCase()
      if (key === 'x-frame-options') continue
      if (key === 'content-security-policy') {
        const kept = values.map((policy) => policy.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';')).filter((p) => p.trim())
        if (kept.length) headers[name] = kept
        continue
      }
      headers[name] = values
    }
    callback({ responseHeaders: headers })
  })
}
