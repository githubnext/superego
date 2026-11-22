// The app's windows on the desktop: each an AppWindow, the one record of everything the main process keeps for it
// (its subscriptions, shortcuts, the thread it shows, what waits to be shown in it, its channels), torn down in one
// place as its page loads again or it closes. Kept between launches by WindowList (windows.ts), and reopened as they were left.
import { join } from 'node:path'
import { app, BrowserWindow, screen, session, shell, type Input, type WebContents } from 'electron'
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
  /**
   * Which page it has: one more each time a page starts loading in it, and as it closes. What its page starts and
   * finishes later (opening a channel) belongs to it only while this is unchanged.
   */
  get page() { return this.#page }
  #page = 0
  /** Its page's subscriptions on the app's endpoint (`settings.watch`), by sub. */
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
  /** The web views over its panes (main/web-views.ts), by id: each closes itself. */
  readonly views = new Map<string, { close(): void }>()
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

  /**
   * A page starts loading in it (the first, or a reload), or it closed (`reason`): what the last page had goes. Its
   * subscriptions stop, its channels are aborted, its web views close, and what it said (its shortcuts, the thread it shows) is forgotten;
   * what's to show waits for the new page to listen, and `pending` is kept for it.
   */
  pageLoaded(reason = 'The page loaded again') {
    this.#page++
    for (const stop of this.subs.values()) stop()
    this.subs.clear()
    this.ready = false
    this.boundKeys = new Set()
    this.shown = undefined
    for (const held of this.channels.values()) held.channel.abort(reason)
    for (const view of [...this.views.values()]) view.close()
  }

  /**
   * A key pressed where its page can't hear it (a frame in it, a web view over it): sent to the page to run, when it's
   * one of its shortcuts. Whether it was.
   */
  takeKey(input: Input): boolean {
    if (input.type !== 'keyDown' || !(input.meta || input.control || input.alt)) return false
    const keys = shortcutOf({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift })
    if (!keys || !this.boundKeys.has(keys)) return false
    this.sendApp('app.key', { keys })
    return true
  }

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

/** Its callbacks are never called while it's being made: what they reach may be made after it. */
export type WindowsOptions = {
  app: AppConfig
  dataDir: string
  headless: boolean
  /** A new window's methods on the app's endpoint. */
  methods(window: AppWindow): AppHandlers
  /** One opened or closed. */
  changed(): void
  /** What the window in front shows may have changed: one came to the front or left it, or its page loaded again. */
  lookedAtChanged(): void
  /** One closed: what's kept for it elsewhere goes. */
  closed(window: AppWindow): void
}

export type Windows = ReturnType<typeof createWindows>

/** The app's windows: opened, reopened, brought forward, and asked to show a thread or Settings. */
export function createWindows({ app: appConfig, dataDir, headless, methods, changed, lookedAtChanged, closed }: WindowsOptions) {
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
    // App-wide shortcuts work wherever the keyboard is. A frame in the page (an agent's HTML block) is a page of its
    // own, and its key presses never reach the window's; so while one has the keyboard, a press that's one of the
    // window's shortcuts is taken here, before any frame, and sent to the window to run. A web view's are taken as
    // well (web-views.ts).
    contents.on('before-input-event', (event, input) => {
      const frame = contents.focusedFrame
      if (!frame || frame === contents.mainFrame) return
      if (window.takeKey(input)) event.preventDefault()
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
    // Full screen, the window's buttons are gone from the title bar: the page stops keeping room for them.
    browser.on('enter-full-screen', () => window.sendApp('app.fullScreen', { on: true }))
    browser.on('leave-full-screen', () => window.sendApp('app.fullScreen', { on: false }))
    byId.set(opened.id, window)
    const moved = () => { if (!browser.isDestroyed()) list.moved(opened.id, browser.getNormalBounds()) }
    browser.on('moved', moved)
    browser.on('resized', moved)
    // A page starting to load in it (not a move within it, nor a frame's): the last one's state goes. Here, not on word
    // from the new page, which may say nothing.
    contents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
      if (!isMainFrame || isSameDocument) return
      window.pageLoaded()
      lookedAtChanged()
    })
    browser.on('closed', () => {
      byId.delete(opened.id)
      window.pageLoaded('The window closed')
      list.close(opened.id)
      closed(window)
      changed()
    })
    browser.on('focus', () => { list.focused(opened.id); lookedAtChanged() })
    browser.on('blur', () => lookedAtChanged())
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

/** What the windows' pages may do: list the installed fonts (font pickers, the Local Font Access API), and nothing else asked for. */
export function setUpSession() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'local-fonts'))
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'local-fonts')
}
