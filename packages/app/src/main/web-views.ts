// Web views: a pane's web page (Preview's, an artifact) as a page of its own, laid over the pane in its window: a
// top-level page, as a browser tab has it, so its cookies are first-party (a sign-in through another port, or another
// site, holds), and a page that refuses to be framed loads. Each is a WebContentsView in the window, held for its page
// (AppWindow.views) and closed as that page loads again or the window closes. The page places it (renderer/web-view.tsx):
// it draws above the window's page, so the page hides it, and shows a still of it instead, while something of its own is
// over it.
//
// What a page in one may do: what a browser tab may, short of the app's powers (no Node, no preload, sandboxed,
// isolated). It asks for nothing it's given: the camera, notifications and the rest are refused, and its pane says so.
// A link that opens a window opens in the user's browser; a file it saves goes to the Downloads folder. Preview's pages
// share cookies and storage, kept between launches (`persist:preview`); an artifact's are its own, gone as the app quits.
import { existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import { app, ipcMain, session, shell, WebContentsView, type Input, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import { CHANNEL, type WebViewEvent, type WebViewPartition, type WebViewRect, type WebViewState } from '../shared/bridge.ts'
import type { AppWindow } from './app-windows.ts'
import { attachContextMenu } from './context-menu.ts'
import { SCHEME as ARTIFACT_SCHEME, serveArtifacts } from './artifacts.ts'
import type { Link } from '@superego/client'

/** The sessions' partitions: Preview's kept on disk, an artifact's in memory. */
export const PARTITIONS: Record<WebViewPartition, string> = { preview: 'persist:preview', artifact: 'superego-artifact' }

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

type Held = { window: AppWindow; id: string; partition: WebViewPartition; view: WebContentsView; error?: WebViewState['error']; stillFailed?: boolean }

export type WebViewsOptions = {
  /** The open window whose page this is. */
  windowOf(contents: WebContents): AppWindow | undefined
  linkOf(machine: string): Link | undefined
}

/** Answer the windows' web views (shared/bridge.ts's `webView`; the preload is the other half). Once the app is ready. */
export function serveWebViews({ windowOf, linkOf }: WebViewsOptions) {
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
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      ...(view.error ? { error: view.error } : {}),
    }
  }

  for (const [partition, name] of Object.entries(PARTITIONS) as [WebViewPartition, string][]) {
    const ses = session.fromPartition(name)
    setUpSession(ses, partition)
    if (partition === 'artifact') serveArtifacts(ses, linkOf)
  }

  function setUpSession(ses: Session, partition: WebViewPartition) {
    ses.setPermissionRequestHandler((contents, permission, callback) => {
      const granted = GRANTED.has(permission)
      callback(granted)
      const view = held.get(contents.id)
      if (!granted && view) tell(view, { type: 'denied', permission })
    })
    ses.setPermissionCheckHandler((_contents, permission) => GRANTED.has(permission))
    ses.setDevicePermissionHandler(() => false)
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
    const entry: Held = { window, id, partition, view }
    view.setVisible(false)
    view.setBackgroundColor('#ffffff')
    window.browser.contentView.addChildView(view)
    held.set(contents.id, entry)
    window.views.set(id, {
      close() {
        window.views.delete(id)
        held.delete(contents.id)
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
    const changed = () => tell(entry, { type: 'state', state: stateOf(entry) })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      entry.error = undefined
      changed()
    })
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) contents.on(name as 'did-start-loading', changed)
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
          native.setVisible(true)
          break
        }
        case 'load': load(view, args[0] as string); break
        case 'go': go(view, args[0] === -1 ? -1 : 1); break
        case 'reload': reload(view); break
        case 'focus':
          if (args[0]) contents.focus()
          else if (contents.isFocused()) window.contents.focus()
          break
        case 'reveal': if (saved.has(args[0] as string)) shell.showItemInFolder(args[0] as string); break
        case 'close': window.views.get(id)?.close(); break
        default: console.error(`Web view: no ${op}`)
      }
    } catch (error) { console.error(`Web view ${op}:`, error) }
  })
  ipcMain.handle(CHANNEL.viewSnapshot, async (event, id: string) => {
    const view = viewOf(event, id)
    if (!view || view.view.webContents.isDestroyed()) return null
    try {
      const image = await view.view.webContents.capturePage()
      return image.isEmpty() ? null : new Uint8Array(image.toPNG())
    } catch (error) {
      // A window that's never been on the screen (headless) has nothing to capture: the pane goes without a still.
      // Said once for each view, not with each try.
      if (!view.stillFailed) console.error(`A still of ${view.view.webContents.getURL()}:`, error)
      view.stillFailed = true
      return null
    }
  })
}
