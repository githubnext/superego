// Web views: a Browser pane's page (a web page, or an artifact: an HTML file of a thread's) as a page of its own, laid over the pane in its window: a
// top-level page, as a browser tab has it, so its cookies are first-party (a sign-in through another port, or another
// site, holds), and a page that refuses to be framed loads. Each is a WebContentsView in the window, held for its page
// (AppWindow.views) and closed as that page loads again or the window closes. The page places it (renderer/web-view.tsx):
// it draws above the window's page, so the page hides it, and shows a still of it instead, while something of its own is
// over it. The page is told when a view has come to rest after changing (`settled`), to keep a still of it on hand.
//
// What a page in one may do: what a browser tab may, short of the app's powers (no Node, no preload, sandboxed,
// isolated). A web page asks the user, in its pane, for the local network, the camera, the microphone and to
// show notifications, as a browser does, and has them once they allow it (site-permissions.ts); anything else is
// refused, and its pane says so. An artifact is the agent's file, not a website: it's refused everything.
// A link that opens a window opens in the user's browser; a file it saves goes to the Downloads folder. Web pages share
// cookies and storage, kept between launches (`persist:browser`); an artifact's are its own, gone as the app quits.
import { existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import { app, ipcMain, session, shell, systemPreferences, WebContentsView, type Input, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import { CHANNEL, type PermissionAsk, type SitePermission, type WebViewEvent, type WebViewPartition, type WebViewRect, type WebViewState } from '../shared/bridge.ts'
import type { AppWindow } from './app-windows.ts'
import { attachContextMenu } from './context-menu.ts'
import { SCHEME as ARTIFACT_SCHEME, serveArtifacts } from './artifacts.ts'
import { asked, checkAsks, originOf, type SitePermissionsHandle } from './site-permissions.ts'
import type { Link } from '@superego/client'

/** The sessions' partitions: web pages' kept on disk, an artifact's in memory. */
export const PARTITIONS: Record<WebViewPartition, string> = { browser: 'persist:browser', artifact: 'superego-artifact' }

/** The world the window's scripts run in, in a page (`BridgeWebView.run`): its own, apart from the page's (0) and Electron's (999). */
const APP_WORLD = 1001

/**
 * How long a page is left alone (loaded, scrolled, typed in) before it's said to have settled: a still taken then is of
 * what it shows, and the user has moved on.
 */
export const SETTLE_MS = 500

/** What a page may have without asking anyone: putting text on the clipboard (a page's Copy button). */
const GRANTED = new Set(['clipboard-sanitized-write'])

/** Where a page in a view of `partition` may go itself: the web; an artifact, its own files too. */
export function mayNavigate(partition: WebViewPartition, url: string): boolean {
  const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
  return scheme === 'http:' || scheme === 'https:' || scheme === 'about:' || (partition === 'artifact' && scheme === `${ARTIFACT_SCHEME}:`)
}

/** Opened outside the app, when a page sends the user there (a link to a new window, `mailto:`): the browser, the mail app. */
export const opensOutside = (url: string) => /^(https?|mailto):/i.test(url)

/** A file saved as `name` in `dir`: the name itself, unless that's taken, then `name (1)`, `name (2)`… as a browser does. */
export function savePath(dir: string, name: string, exists: (path: string) => boolean = existsSync): string {
  const { name: base, ext } = parse(name.replace(/[/\\]/g, '_') || 'download')
  for (let n = 0; ; n++) {
    const path = join(dir, n ? `${base} (${n})${ext}` : `${base}${ext}`)
    if (!exists(path)) return path
  }
}

/** A browser's own keys in a page: ⌘R reloads it, ⌘[ and ⌘] go back and forward (Ctrl elsewhere). */
export function browserKey(input: Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'alt' | 'shift'>, mac: boolean): 'reload' | 'back' | 'forward' | undefined {
  if (input.type !== 'keyDown' || input.alt || input.shift || !(mac ? input.meta && !input.control : input.control && !input.meta)) return undefined
  return ({ r: 'reload', '[': 'back', ']': 'forward' } as const)[input.key.toLowerCase() as 'r' | '[' | ']']
}

/** A view as web pages' permissions know it: told what its page asks the user now. */
export type AskingView = { asking(ask: PermissionAsk | undefined): void }

type Held = AskingView & {
  window: AppWindow; id: string; partition: WebViewPartition; view: WebContentsView; error?: WebViewState['error']; ask?: PermissionAsk; stillFailed?: boolean
  /** How far the load under way has come (`WebViewState.progress`). */
  progress?: number
  /** The device emulation it's under (a page at a set size, `WebViewRect.layout`); none when it isn't. */
  emulated?: Electron.Parameters
  /** Until it's said to have settled, after it last changed. */
  settling?: ReturnType<typeof setTimeout>
}

/** A load's milestones, as its progress: started, its response in (the page committed), its document parsed. */
export const PROGRESS = { started: 0.1, committed: 0.4, parsed: 0.7 } as const

export type WebViewsOptions = {
  /** The open window whose page this is. */
  windowOf(contents: WebContents): AppWindow | undefined
  linkOf(machine: string): Link | undefined
  /** What web pages may use, as the user said. */
  sites: SitePermissionsHandle<AskingView>
}

/** Answer the windows' web views (shared/bridge.ts's `webView`; the preload is the other half). Once the app is ready. */
export function serveWebViews({ windowOf, linkOf, sites }: WebViewsOptions) {
  /** Every view open, by its page's id. */
  const held = new Map<number, Held>()
  /** The files the views saved: the only ones a window may show in the Finder this way. */
  const saved = new Set<string>()

  const tell = (view: Held, event: WebViewEvent) => {
    if (!view.window.contents.isDestroyed()) view.window.contents.send(CHANNEL.viewEvent, { id: view.id, event })
  }
  const stateOf = (view: Held): WebViewState => {
    const contents = view.view.webContents
    return {
      url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
      ...(contents.isLoading() && view.progress !== undefined ? { progress: view.progress } : {}),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      ...(view.error ? { error: view.error } : {}),
      ...(view.ask ? { ask: view.ask } : {}),
    }
  }

  for (const [partition, name] of Object.entries(PARTITIONS) as [WebViewPartition, string][]) {
    const ses = session.fromPartition(name)
    setUpSession(ses, partition)
    if (partition === 'artifact') serveArtifacts(ses, linkOf)
  }

  /**
   * Whether the system lets the app use what the user allowed a site: the camera and microphone need macOS's say too,
   * asked for the first time one is used. Refused, the pane says so.
   */
  async function systemAllows(view: Held, kinds: SitePermission[]): Promise<boolean> {
    if (process.platform !== 'darwin') return true
    for (const kind of kinds) {
      if (kind !== 'camera' && kind !== 'microphone') continue
      let allowed = false
      try {
        const status = systemPreferences.getMediaAccessStatus(kind)
        allowed = status === 'granted' || (status === 'not-determined' && await systemPreferences.askForMediaAccess(kind))
      } catch (error) { console.error(`Asking macOS for the ${kind}:`, error) }
      if (!allowed) {
        tell(view, { type: 'blocked', permission: kind })
        return false
      }
    }
    return true
  }

  function setUpSession(ses: Session, partition: WebViewPartition) {
    ses.setDevicePermissionHandler(() => false)
    if (partition === 'browser') {
      // What the user is asked for (site-permissions.ts), asked in the page's pane; anything else is refused, and said.
      ses.setPermissionRequestHandler((contents, permission, callback, details) => {
        if (GRANTED.has(permission)) return callback(true)
        const view = held.get(contents.id)
        const origin = originOf(('securityOrigin' in details && details.securityOrigin) || details.requestingUrl)
        const kinds = asked(permission, 'mediaTypes' in details ? details.mediaTypes : undefined)
        if (!view || !origin || !kinds?.length) {
          callback(false)
          if (view) tell(view, { type: 'denied', permission })
          return
        }
        sites.request(view, origin, kinds, (granted) => {
          if (!granted) return callback(false)
          void systemAllows(view, kinds).then(callback)
        })
      })
      ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
        if (GRANTED.has(permission)) return true
        const origin = originOf(requestingOrigin || details.requestingUrl)
        const kinds = asked(permission, details.mediaType ? [details.mediaType] : undefined)
        if (!origin || !kinds?.length) return false
        const view = contents ? held.get(contents.id) : undefined
        // The local network, checked by a page in a view: asked for, and the page loaded again once it's allowed.
        return sites.check(origin, kinds, view && checkAsks(permission) ? { view, allowed: () => reload(view) } : undefined)
      })
    } else {
      ses.setPermissionRequestHandler((contents, permission, callback) => {
        const granted = GRANTED.has(permission)
        callback(granted)
        const view = held.get(contents.id)
        if (!granted && view) tell(view, { type: 'denied', permission })
      })
      ses.setPermissionCheckHandler((_contents, permission) => GRANTED.has(permission))
    }
    ses.on('will-download', (_event, item, contents) => {
      const view = contents && held.get(contents.id)
      const path = savePath(app.getPath('downloads'), item.getFilename())
      item.setSavePath(path)
      const name = parse(path).base
      saved.add(path)
      if (view) tell(view, { type: 'download', name, path, state: 'progressing' })
      item.once('done', (_e, state) => {
        if (state === 'completed' && process.platform === 'darwin') app.dock?.downloadFinished(path)
        if (state !== 'completed') console.error(`${partition} download of ${item.getURL()}: ${state}`)
        if (view) tell(view, { type: 'download', name, path, state })
      })
    })
  }

  function open(window: AppWindow, id: string, url: string, partition: WebViewPartition) {
    if (window.views.has(id) || !PARTITIONS[partition] || !mayNavigate(partition, url)) throw new Error(`No web view for ${url}`)
    const view = new WebContentsView({
      webPreferences: { partition: PARTITIONS[partition], sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    })
    const contents = view.webContents
    const entry: Held = {
      window, id, partition, view,
      asking(ask) {
        entry.ask = ask
        changed()
      },
    }
    view.setVisible(false)
    view.setBackgroundColor('#ffffff')
    window.browser.contentView.addChildView(view)
    held.set(contents.id, entry)
    window.views.set(id, {
      close() {
        clearTimeout(entry.settling)
        window.views.delete(id)
        held.delete(contents.id)
        sites.drop(entry, true)
        if (!window.browser.isDestroyed()) window.browser.contentView.removeChildView(view)
        if (!contents.isDestroyed()) contents.close()
      },
    })

    // Inspect Element always: what's previewed is most often what's being made.
    attachContextMenu(contents, { dev: true, window: () => window.browser })
    // A new window (a link to another tab, window.open) opens in the user's browser; an artifact's own file, in its place.
    contents.setWindowOpenHandler(({ url: to }) => {
      if (partition === 'artifact' && to.startsWith(`${ARTIFACT_SCHEME}:`)) void contents.loadURL(to)
      else if (opensOutside(to)) void shell.openExternal(to)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, to) => {
      if (mayNavigate(partition, to)) return
      event.preventDefault()
      if (opensOutside(to)) void shell.openExternal(to)
    })
    contents.on('will-redirect', (event, to) => { if (!mayNavigate(partition, to)) event.preventDefault() })
    // The window's shortcuts first (⌘W closes the pane, from inside it too), then a browser's own.
    contents.on('before-input-event', (event, input) => {
      if (window.takeKey(input)) return event.preventDefault()
      const key = browserKey(input, process.platform === 'darwin')
      if (!key) return
      event.preventDefault()
      if (key === 'reload') reload(entry)
      else go(entry, key === 'back' ? -1 : 1)
    })
    function changed() { tell(entry, { type: 'state', state: stateOf(entry) }) }
    /** It may look different: once it's been left alone a moment, its page is told (for a still of it). */
    const touched = () => {
      clearTimeout(entry.settling)
      entry.settling = setTimeout(() => tell(entry, { type: 'settled' }), SETTLE_MS)
    }
    // What changes it: loading, going elsewhere in it, the user's input (not the pointer passing over it: hovering
    // alone would take a still each time it stops).
    for (const name of ['did-stop-loading', 'did-navigate-in-page'] as const) contents.on(name as 'did-stop-loading', touched)
    contents.on('input-event', (_event, input) => { if (input.type !== 'mouseMove' && input.type !== 'mouseEnter' && input.type !== 'mouseLeave') touched() })
    /** The load under way reached `progress` (a milestone of it: PROGRESS). */
    const reached = (progress: number) => {
      if (contents.isLoading()) entry.progress = Math.max(entry.progress ?? 0, progress)
      changed()
    }
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      entry.error = undefined
      // A new load, in place of any under way.
      entry.progress = PROGRESS.started
      // What the page leaving asked for goes with it, unanswered.
      sites.drop(entry, false)
      changed()
    })
    contents.on('did-start-loading', () => reached(PROGRESS.started))
    contents.on('did-navigate', () => {
      reached(PROGRESS.committed)
      // A new document isn't under the last one's emulation: it's put under it again.
      if (entry.emulated) contents.enableDeviceEmulation(entry.emulated)
    })
    contents.on('dom-ready', () => reached(PROGRESS.parsed))
    contents.on('did-stop-loading', () => {
      entry.progress = undefined
      changed()
    })
    for (const name of ['did-navigate-in-page', 'page-title-updated'] as const) contents.on(name as 'did-navigate-in-page', changed)
    contents.on('did-fail-load', (_event, code, description, failed, isMainFrame) => {
      // -3: aborted, by another load taking its place (a click before the last one finished), not failed.
      if (!isMainFrame || code === -3) return
      entry.error = { code, description, url: failed }
      changed()
    })
    contents.on('render-process-gone', (_event, details) => {
      console.error(`Web view ${contents.getURL()} gone: ${details.reason}`)
      entry.error = { code: details.exitCode, description: `The page ${details.reason === 'oom' ? 'ran out of memory' : 'crashed'}`, url: contents.getURL() }
      changed()
    })
    contents.on('focus', () => tell(entry, { type: 'focus' }))
    load(entry, url)
  }

  function load(view: Held, url: string) {
    if (!mayNavigate(view.partition, url)) throw new Error(`Not a page to show: ${url}`)
    // A load that fails says so through did-fail-load, to the pane; this only repeats it.
    view.view.webContents.loadURL(url).catch(() => {})
  }
  const reload = (view: Held) => view.error ? load(view, view.error.url) : view.view.webContents.reload()
  const go = (view: Held, by: -1 | 1) => {
    const history = view.view.webContents.navigationHistory
    if (by < 0 ? history.canGoBack() : history.canGoForward()) by < 0 ? history.goBack() : history.goForward()
  }

  /** The view `id` of the window whose page this is. */
  const viewOf = (event: IpcMainEvent | IpcMainInvokeEvent, id: string) => {
    const window = windowOf(event.sender)
    return window && [...held.values()].find((v) => v.window === window && v.id === id)
  }

  ipcMain.on(CHANNEL.viewOpen, (event, id: string, url: string, partition: WebViewPartition) => {
    const window = windowOf(event.sender)
    if (!window) return
    try { open(window, id, url, partition) } catch (error) {
      console.error(error)
      event.sender.send(CHANNEL.viewEvent, { id, event: { type: 'state', state: { url, title: '', loading: false, canGoBack: false, canGoForward: false, error: { code: 0, description: (error as Error).message, url } } } })
    }
  })
  ipcMain.on(CHANNEL.view, (event, id: string, op: string, ...args: unknown[]) => {
    const view = viewOf(event, id)
    if (!view) return
    const { window, view: native } = view
    const contents = native.webContents
    try {
      switch (op) {
        case 'place': {
          const [rect, shown] = args as [WebViewRect | null, boolean]
          if (!rect) { native.setVisible(false); break }
          // The page's CSS pixels, at its zoom, in the window's. Not shown, it's put off the window's top left corner at
          // its size, all but its last pixel, which the window's rounded corner hides: a page wholly off the window, or
          // hidden, isn't drawn, and a still of it would be of nothing, or of what it was.
          const zoom = window.contents.getZoomFactor()
          const width = Math.round(rect.width * zoom), height = Math.round(rect.height * zoom)
          native.setBounds(shown ? { x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom), width, height } : { x: 1 - width, y: 1 - height, width, height })
          // A view can't be cut by the page: rounded itself, as its box is.
          native.setBorderRadius(Math.round((rect.radius ?? 0) * zoom))
          emulate(view, rect)
          native.setVisible(true)
          break
        }
        case 'load': load(view, args[0] as string); break
        case 'go': go(view, args[0] === -1 ? -1 : 1); break
        case 'reload': reload(view); break
        case 'stop': contents.stop(); break
        case 'focus':
          if (args[0]) contents.focus()
          else if (contents.isFocused()) window.contents.focus()
          break
        case 'reveal': if (saved.has(args[0] as string)) shell.showItemInFolder(args[0] as string); break
        // The user's click in the pane's ask: only a window's page gets here, never an agent.
        case 'answer': sites.answer(view, args[0] === true); break
        case 'close': window.views.get(id)?.close(); break
        default: console.error(`Web view: no ${op}`)
      }
    } catch (error) { console.error(`Web view ${op}:`, error) }
  })
  /**
   * A page at a set size (`rect.layout`): laid out at that size, so it sees the width it was given, and drawn to fill its
   * bounds (smaller, scaled to fit its pane). Emulated by Chromium as DevTools' device mode does, for this view alone
   * (a zoom factor would be its origin's, in every view of it).
   */
  function emulate(view: Held, rect: WebViewRect) {
    const contents = view.view.webContents
    const bounds = view.view.getBounds()
    const size = rect.layout && { width: Math.round(rect.layout.width), height: Math.round(rect.layout.height) }
    const next = size && { screenPosition: 'desktop' as const, screenSize: size, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: size, scale: bounds.width / size.width }
    if (JSON.stringify(next) === JSON.stringify(view.emulated)) return
    view.emulated = next
    if (next) contents.enableDeviceEmulation(next)
    else contents.disableDeviceEmulation()
  }
  // A script of the window's in the page (a Browser pane's element picker): in a world of the app's own, so the page's
  // scripts neither see its globals nor change what it calls.
  ipcMain.handle(CHANNEL.viewRun, async (event, id: string, code: string) => {
    const view = viewOf(event, id)
    if (!view || view.view.webContents.isDestroyed()) throw new Error('The page is gone')
    return view.view.webContents.executeJavaScriptInIsolatedWorld(APP_WORLD, [{ code }], true)
  })
  // A part of the page as it's drawn now. Its CSS pixels are the view's, but for a page at a set size, drawn scaled.
  ipcMain.handle(CHANNEL.viewCapture, async (event, id: string, rect: { x: number; y: number; width: number; height: number }) => {
    const view = viewOf(event, id)
    if (!view || view.view.webContents.isDestroyed()) return null
    const contents = view.view.webContents
    const scale = view.emulated?.scale ?? 1
    const area = { x: Math.floor(rect.x * scale), y: Math.floor(rect.y * scale), width: Math.ceil(rect.width * scale), height: Math.ceil(rect.height * scale) }
    if (area.width < 1 || area.height < 1) return null
    try {
      const image = await contents.capturePage(area)
      if (!image.isEmpty()) return new Uint8Array(image.toPNG())
    } catch {
      // A window never on the screen (the app's own checks) has nothing drawn to capture: expected there, and the way
      // below says why if it fails too.
    }
    // Nothing drawn to capture: DevTools' screenshot of it, which draws the page anew.
    const debug = contents.debugger
    const attached = debug.isAttached()
    try {
      if (!attached) debug.attach()
      const { data } = await debug.sendCommand('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } }) as { data: string }
      return new Uint8Array(Buffer.from(data, 'base64'))
    } catch (error) {
      console.error(`A part of ${contents.getURL()}, by DevTools' screenshot:`, error)
      return null
    } finally { if (!attached && debug.isAttached()) debug.detach() }
  })
  // A still of the whole page, to show in its place: a JPEG, as a PNG of a large pane with pictures in it takes a fifth
  // of a second to make.
  ipcMain.handle(CHANNEL.viewSnapshot, async (event, id: string) => {
    const view = viewOf(event, id)
    if (!view || view.view.webContents.isDestroyed()) return null
    try {
      const image = await view.view.webContents.capturePage()
      return image.isEmpty() ? null : new Uint8Array(image.toJPEG(90))
    } catch (error) {
      // A window that's never been on the screen (headless) has nothing to capture: the pane goes without a still.
      // Said once for each view, not with each try.
      if (!view.stillFailed) console.error(`A still of ${view.view.webContents.getURL()}:`, error)
      view.stillFailed = true
      return null
    }
  })
}
