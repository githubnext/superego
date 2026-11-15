import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, session, shell, type MenuItemConstructorOptions } from 'electron'
import { appEnv, daemonStarting, defaultDataDir, readBuild, socketPath } from '@superego/daemon/client'
import {
  arr, bool, compareVersions, defineAction, int, lit, nullable, obj, opt, Router, RpcError, str, union, unknown, waitingForSignIn,
  type AppConfig, type DeclaredSection, type Json, type Notifications, type ProfileRef, type ThreadInfo, type SettingType,
} from '@superego/protocol'
import { serveSettings } from '@superego/settings'
import { ARTIFACT_POLICY, ARTIFACT_TYPES, CHANNEL, NOTIFY, signInNotice, threadNotice, type CallResult, type MachineConfig, type MachineEntry, type MachineUpdate, type SuperegoEvent, type ThreadNotice } from '../shared.ts'
import { APP, APP_KEYS, createAppSettings } from './app-settings.ts'
import { LayoutFile, type LayoutView } from './layout-file.ts'
import { Link, loginInTerminal, MachineLinks, MachineStore, openLocal as openLocalSocket, runUpdate, UiAllowStore } from '@superego/client'
import { MenuBar } from './tray.ts'
import { commandLine } from './command-line.ts'
import { ServiceRestart, type ServiceAction } from './restart.ts'
import { shortcutOf } from '../renderer/shortcuts.ts'

/**
 * Run an app's main process: its window, the links to every machine (starting this computer's daemon, which outlives
 * the app), the app's own settings, the menu bar item and Dock, notifications, and restarting the daemon onto new code.
 * The app's `src/main.ts` calls this with its config; the build puts `daemon.js`, the preload and the renderer next to it.
 */
export function startApp(appConfig: AppConfig) {
  /** Headless (tests): no window, Dock icon, notification or focus; nothing that reaches the screen. */
  const headless = Boolean(appEnv(appConfig)('HEADLESS'))
  // Before it finishes launching, so the Dock never shows it.
  if (headless) app.dock?.hide()
  const dataDir = defaultDataDir(appConfig)
  const socket = socketPath(appConfig, dataDir)

  /** Start the local daemon, detached: quitting the app leaves agents running. */
  function startDaemon() {
    if (daemonStarting(dataDir)) return
    mkdirSync(dataDir, { recursive: true })
    const log = openSync(join(dataDir, 'daemon.log'), 'a')
    spawn(process.execPath, [join(import.meta.dirname, 'daemon.js')], {
      detached: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref()
  }
  const openLocal = () => openLocalSocket(socket, startDaemon)

  const broadcast = (event: SuperegoEvent) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(CHANNEL.event, event)
  }

  const appSettings = createAppSettings(dataDir, appConfig)
  // The layout as text: layout.json, read in as it's saved, and what's wrong with it told to the windows.
  const layoutFile = new LayoutFile(dataDir, appSettings, () => appSettings.invalidate())
  appSettings.register({
    id: 'layout', title: 'Layout', order: 1000, settings: [],
    data: async () => ({ file: layoutFile.path, ...(layoutFile.problem ? { problem: layoutFile.problem } : {}), ...(layoutFile.missing ? { missing: layoutFile.missing } : {}) }),
  })
  void layoutFile.start().catch((error) => console.error('layout.json:', error))
  // `<id>` on the PATH, from the app this build is in (out/main → the app, or its app.asar). Headless (tests), no login
  // shell is asked where it finds it.
  const cli = commandLine({
    app: appConfig, appPath: join(import.meta.dirname, '..', '..'), packaged: app.isPackaged, executable: process.execPath,
    ...(headless ? {} : { shell: process.env.SHELL || '/bin/zsh' }),
  })
  appSettings.register({
    id: 'command-line', title: 'Command line', order: 80, ui: 'command-line', settings: [],
    data: () => cli.info(),
  })

  /** The app's own endpoint: its settings, per window so a closed window's subscriptions go with it. */
  const appSubs = new Map<number, Map<string, () => unknown>>()
  /** Each window's bound shortcuts, as it last said (see `app.keys`). */
  const boundKeys = new Map<number, Set<string>>()
  function appEndpoint(contents: Electron.WebContents) {
    let subs = appSubs.get(contents.id)
    if (!subs) {
      const created = subs = new Map()
      appSubs.set(contents.id, created)
      contents.once('destroyed', () => { for (const stop of created.values()) stop(); appSubs.delete(contents.id) })
    }
    const send = (method: string, params: unknown) => { if (!contents.isDestroyed()) contents.send(CHANNEL.event, { machine: APP, method, params }) }
    const handlers: Record<string, (params: any) => Promise<unknown>> = {
      'settings.watch': serveSettings(appSettings, (params) => send('settings.changed', params), subs)['settings.watch'],
      async unwatch({ sub }: { sub: string }) { subs.get(sub)?.(); subs.delete(sub); return null },
      /** A folder on this computer, chosen in the system's dialog; null when cancelled. */
    async 'app.pickFolder'({ defaultPath }: { defaultPath?: string }) {
      const window = BrowserWindow.fromWebContents(contents)
      const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], ...(defaultPath ? { defaultPath } : {}) }
      const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return canceled ? null : filePaths[0] ?? null
    },
    /** How Superego sits on the desktop now. */
      async 'service.get'() { return service.state },
      /** Another window, beside the one asking. */
      async 'app.newWindow'() {
        const window = createWindow(BrowserWindow.fromWebContents(contents) ?? undefined)
        if (!headless) { window.show(); window.focus() }
        return null
      },
      /**
       * The shortcuts that run actions in this window now. While a page in one of its panes has the keyboard, the
       * page gets key presses and the window never sees them: these are taken first (see createWindow) and sent on.
       */
      async 'app.keys'({ keys }: { keys: string[] }) {
        if (!boundKeys.has(contents.id)) contents.once('destroyed', () => boundKeys.delete(contents.id))
        boundKeys.set(contents.id, new Set(keys))
        return null
      },
      /** A window's notifications extension: a thread wants a look. */
      async 'app.notify'(notice: ThreadNotice) { notify(notice); return null },
      async 'app.desktop'() { return { menuBar: menuBar.shown, dockHidden: mac && dockHidden() } },
      /** The page is listening for app events: answer with a thread it was asked to show before it was. */
      async 'app.ready'() {
        ready.add(contents.id)
        contents.once('destroyed', () => ready.delete(contents.id))
        const what = pending.get(contents.id)
        pending.delete(contents.id)
        return what ?? {}
      },
      /** A window's UI extensions declare their settings; the app keeps them in its own settings file. */
    'settings.register': async ({ section }: { section: DeclaredSection }) => {
      if (!section?.id || !Array.isArray(section.settings)) throw new RpcError('invalid', 'A section needs an id and settings')
      appSettings.upsert({ ...section, settings: section.settings.map(({ key, title, description, default: initial, ...type }) => ({
        key, title, default: initial, type: type as SettingType, ...(description ? { description } : {}),
      })) })
      return null
    },
      /** The profile UIs from other machines allowed to run in this computer's windows (see profile-ui.ts). */
      'profileUi.allowed': async () => uiAllowed.list(),
      /** The ones put off ("Not now"), for the sources they were then: the window doesn't ask about those again. */
      'profileUi.declined': async () => uiAllowed.declinedList(),
      'action.list': async () => appRouter.list(),
      'action.log': async () => appRouter.log(),
    }
    // The app's intents, served under their ids like a daemon's.
    for (const action of appRouter.list()) handlers[action.id] = (params) => appRouter.dispatch(action.id, params, { window: contents }, { source: 'window' })
    return handlers
  }

  /** This computer's daemon, and a link to every enabled machine in `machines.json` (see @superego/client's links.ts). */
  let local: Link | undefined
  const machineStore = new MachineStore(dataDir)
  const remotes = new MachineLinks({
    app: appConfig, dataDir, store: machineStore, client: `${appConfig.id}-app`, clientLabel: hostname(),
    onEvent: (machine, method, params) => onMachineEvent(machine, method, params),
    // The local daemon is a machine connected already: a configured one that turns out to be it is refused.
    others: () => local?.state === 'connected' && local.hello ? [{ label: local.label, id: local.hello.machine.id }] : [],
    onChange() {
      broadcast({ machine: APP, method: '$machines', params: machineEntries() })
      refreshDesktop()
    },
  })
  const linkOf = (id: string) => id === 'local' ? local : remotes.get(id)
  const allLinks = () => [...(local ? [local] : []), ...remotes.list()]
  /** Each machine's last Update: running, or how it ended, with what it printed. */
  const updates = new Map<string, MachineUpdate>()

  /** This computer, then every configured machine; disabled ones have no link. */
  function machineEntries(): MachineEntry[] {
    const here = local?.entry()
    return [
      ...(here ? [here] : []),
      ...remotes.entries().map((entry): MachineEntry => {
        // Said of a machine that answered once: one never reached runs nothing we know of.
        const drift = entry.version && compareVersions(here?.version, entry.version)
        const update = updates.get(entry.id)
        return { ...entry, ...(drift ? { drift } : {}), ...(update ? { update } : {}) }
      }),
    ]
  }
  function restartLocal() {
    local?.stop()
    const link: Link = new Link({
      id: 'local', label: 'This computer', client: `${appConfig.id}-app`, clientLabel: hostname(), open: openLocal,
      onEvent: (method, params) => { if (local === link) onMachineEvent('local', method, params) },
    })
    local = link
    link.start()
  }
  /** Reconnect a machine here, and the local daemon's own link there (it reaches the machines too), when it has one. */
  function restartLink(id: string) {
    remotes.restart(id)
    if (local?.state === 'connected' && local.has('relay')) void local.call('machines.reconnect', { id }).catch(() => {})
  }

  /**
   * The profile UIs from other machines this computer lets run in its windows, for the exact sources allowed. The
   * window hashes what a machine serves and asks; a machine has no say. The CLI allows too (`profile allow-ui`).
   */
  const uiAllowed = new UiAllowStore(dataDir)
  uiAllowed.onChange(() => {
    broadcast({ machine: APP, method: 'profileUi.allowed', params: uiAllowed.list() })
    broadcast({ machine: APP, method: 'profileUi.declined', params: uiAllowed.declinedList() })
  })
  uiAllowed.watch()

  /**
   * The app keeps its own subscription to each machine's threads, whatever the windows show: for the menu bar, and to
   * notify when a thread starts wanting a look while no window is open (with one, the window's notifications extension
   * decides, and asks through `app.notify`).
   */
  const lastStatus = new Map<string, ThreadInfo['status']['state']>()
  const watchSubs = new Map<string, string>()
  function onMachineEvent(machine: string, method: string, params: unknown) {
    if (!linkOf(machine)) return
    if (method === '$connection') {
      broadcast({ machine: APP, method: '$machines', params: machineEntries() })
      refreshDesktop()
      if ((params as { state: string }).state === 'connected') {
        if (machine === 'local') setTimeout(pollService)
        void (linkOf(machine)!.call('threads.watch', {}) as Promise<{ sub: string; value: ThreadInfo[] }>).then(({ sub, value }) => {
          watchSubs.set(machine, sub)
          track(machine, value, false)
        }).catch(() => {})
      }
      return
    }
    if (method === 'threads.changed') {
      const { sub, value } = params as Notifications['threads.changed']
      if (watchSubs.get(machine) === sub) track(machine, value, true)
    }
    broadcast({ machine, method, params })
  }
  const threadsOf = new Map<string, ThreadInfo[]>()
  function track(machine: string, threads: ThreadInfo[], announce: boolean) {
    const signingIn = (list: ThreadInfo[] | undefined) => (list ?? []).filter((t) => waitingForSignIn(t.status) && !t.without?.includes('notifications'))
    // A provider rejecting the credentials: one notice when threads start waiting for sign-in, not one each.
    const before = signingIn(threadsOf.get(machine)).length
    const waiting = signingIn(threads)
    threadsOf.set(machine, threads)
    refreshDesktop()
    if (announce && !before && waiting.length && !BrowserWindow.getAllWindows().length && appSettings.get(NOTIFY) === true) {
      const notice = signInNotice(machine, { summary: waiting[0]!.status.msg ?? 'Sign in again', threads: waiting.map((t) => t.id) })
      if (notice) notify(notice)
    }
    for (const thread of threads) {
      const key = `${machine}/${thread.id}`
      const before = lastStatus.get(key)
      const now = thread.status.state
      lastStatus.set(key, now)
      if (!announce || before === now || BrowserWindow.getAllWindows().length) continue
      // Only once a window has declared the setting: an app without the notifications extension never notifies.
      const notice = threadNotice(machine, thread)
      if (notice && appSettings.get(NOTIFY) === true && !thread.without?.includes('notifications')) notify(notice)
    }
  }
  /** When each notice was last shown: every window asks, and the first asking shows it. */
  const noticed = new Map<string, number>()
  /**
   * Show a notification of a thread that wants a look, unless a window has the focus; clicking it shows the thread.
   * Headless (tests), nothing shows: a test may collect them in `globalThis.superegoNotices`.
   */
  function notify(notice: ThreadNotice) {
    const key = JSON.stringify(notice)
    for (const [old, at] of noticed) if (Date.now() - at >= 5_000) noticed.delete(old)
    if (Date.now() - (noticed.get(key) ?? 0) < 5_000) return
    noticed.set(key, Date.now())
    if (headless) return void (globalThis as { superegoNotices?: ThreadNotice[] }).superegoNotices?.push(notice)
    if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return
    const notification = new Notification({ title: notice.title, subtitle: linkOf(notice.machine)?.label ?? notice.machine, body: notice.body })
    notification.on('click', () => show({ open: { machine: notice.machine, thread: notice.thread } }))
    notification.show()
  }

  ipcMain.handle(CHANNEL.machines, () => machineEntries())
  ipcMain.handle(CHANNEL.call, async (event, machine: string, method: string, params: unknown): Promise<CallResult> => {
    try {
      if (machine === APP) {
        const handler = appEndpoint(event.sender)[method]
        if (!handler) throw new RpcError('unknown_method', `Unknown method ${method}`)
        return { ok: true, result: await handler(params ?? {}) }
      }
      const link = linkOf(machine)
      if (!link) throw new RpcError('unknown_machine', `No machine ${machine}`)
      return { ok: true, result: await link.call(method, params) }
    } catch (error) {
      return { ok: false, error: { kind: error instanceof RpcError ? error.kind : 'error', message: error instanceof Error ? error.message : String(error) } }
    }
  })

  /**
   * One app per data dir: its Electron state lives in the data dir, so the lock that keeps a second launch from opening
   * a second app is per data dir too. A second launch (`superego`, `superego open`) hands its arguments over and exits.
   */
  app.setName(appConfig.name)
  app.setPath('userData', join(dataDir, 'app'))
  const primary = app.requestSingleInstanceLock()
  if (!primary) app.quit()

  type Open = { machine: string; thread: string }
  /** `--superego-open=<machine>/<thread>`, as `superego` passes it. */
  function openArgument(argv: string[]): Open | undefined {
    const value = argv.find((arg) => arg.startsWith('--superego-open='))?.slice('--superego-open='.length)
    const slash = value?.lastIndexOf('/') ?? -1
    return value && slash > 0 ? { machine: value.slice(0, slash), thread: value.slice(slash + 1) } : undefined
  }

  /** What a window should show: a thread, or Settings. */
  type Show = { open?: Open; settings?: boolean }
  /** Windows whose page is listening for app events; until then, what to show waits in `pending`. */
  const ready = new Set<number>()
  const pending = new Map<number, Show>()
  function show(what: Show = {}) {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? createWindow()
    // Headless (tests), the window never comes forward: nothing on the screen, no focus taken from anyone.
    if (!headless) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      app.focus({ steal: true })
    }
    if (!what.open && !what.settings) return
    if (!ready.has(window.webContents.id)) return pending.set(window.webContents.id, what)
    if (what.open) window.webContents.send(CHANNEL.event, { machine: APP, method: 'app.select', params: what.open })
    if (what.settings) window.webContents.send(CHANNEL.event, { machine: APP, method: 'app.settings', params: null })
  }

  app.on('second-instance', (_event, argv) => {
    const open = openArgument(argv)
    show(open ? { open } : {})
  })

  // ── On the desktop: the menu bar item and the Dock icon ─────────────────────────────────────────────────────────────

  const mac = process.platform === 'darwin'
  const menuBarOn = () => appSettings.get<boolean>(APP_KEYS.menuBar)
  const dockHidden = () => menuBarOn() && appSettings.get<boolean>(APP_KEYS.hideDock)

  // The app's own files: `resources/` next to its package.json (the build puts main.js in out/main).
  const resources = join(import.meta.dirname, '../../resources')
  /**
   * Run from source there's no bundle to carry the icon, so the Dock takes the app's own images: `icon.png`, and
   * `icon-dark.png` while the system is dark. A packaged app's icon (`superego.icon`) does all of this, and more, itself.
   * They must sit on macOS's icon grid like any app icon: the tile 824px inside a transparent 1024px canvas. Icon
   * Composer exports fill the canvas, so pad them (magick in.png -resize 824 -background none -gravity center
   * -extent 1024x1024 out.png) or the Dock shows them a quarter larger than every other icon.
   */
  function dockIcon() {
    const pick = () => {
      const dark = join(resources, 'icon-dark.png')
      const icon = nativeTheme.shouldUseDarkColors && existsSync(dark) ? dark : join(resources, 'icon.png')
      if (existsSync(icon)) app.dock?.setIcon(icon)
    }
    pick()
    nativeTheme.on('updated', pick)
  }
  const menuBar = new MenuBar(appConfig, {
    machines: () => machineEntries(),
    threads: (machine) => threadsOf.get(machine) ?? [],
    open: () => show(),
    openThread: (machine, thread) => show({ open: { machine, thread } }),
    openSettings: () => show({ settings: true }),
    quit: () => app.quit(),
    quitAndStop: () => void quitAndStop(),
    service: () => service.state,
    restart: () => void service.act('restart'),
  }, headless, join(resources, 'trayTemplate.png'))

  /** The Dock icon shows while a window is open, unless hidden in Settings; with no window it goes, if the menu bar has Superego. */
  function refreshDesktop() {
    // Settings announce changes from the start; the menu bar and the Dock exist only once the app is ready.
    if (!app.isReady()) return
    menuBar.update(menuBarOn())
    if (!mac || headless) return
    const windows = BrowserWindow.getAllWindows().length > 0
    const visible = !(dockHidden() || (!windows && menuBarOn()))
    // Only on a change: Electron's dock.show() briefly activates the Dock to redraw the menu bar, which flashes the app.
    if (!app.dock || app.dock.isVisible() === visible) return
    if (visible) void app.dock.show()
    else app.dock.hide()
  }
  appSettings.onChange(refreshDesktop)

  // ── The app's actions ──────────────────────────────────────────────────────────────────────────────────────────

  /** The app's actions run for a window (its own, from its endpoint), or for none (the CLI's). */
  const appRouter = new Router<{ window?: Electron.WebContents }>()
  appRouter.register(defineAction({
    id: 'app.settings.set', title: 'Change an app setting', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ key: str(), value: unknown() }),
    async run({ key, value }) { await appSettings.set(key, value as Json); return null },
  }))
  appRouter.register(defineAction({
    id: 'machines.add', title: 'Add a machine', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ label: opt(str()), target: opt(str()), command: opt(str()), via: opt(str()) }),
    run: (params) => machineStore.add(params),
  }))
  appRouter.register(defineAction({
    id: 'machines.update', title: 'Change a machine', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ id: str(), label: opt(str()), target: opt(str()), command: opt(str()), via: opt(str()), enabled: opt(bool()) }),
    async run({ id, ...patch }) { await machineStore.update(id, patch as Partial<MachineConfig>); return null },
  }))
  appRouter.register(defineAction({
    id: 'machines.remove', title: 'Remove a machine', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ id: str() }),
    async run({ id }) { await machineStore.remove(id); await uiAllowed.revoke(id); return null },
  }))
  appRouter.register(defineAction({
    id: 'profiles.allowUi', title: "Let a machine's profile UI run in this window", runs: 'app', expose: ['ui'],
    params: obj({
      machine: str(), profile: obj({ scope: union([lit('user'), lit('project')]), name: str(), dir: str() }), hash: str(),
      files: arr(obj({ path: str(), size: int() })),
    }),
    async run({ machine, profile, hash, files }) {
      // This computer's own profiles are its daemon's to allow.
      if (!machineStore.get(machine)) throw new RpcError('not_found', `No machine ${machine}`)
      await uiAllowed.allow({ machine, profile: profile as ProfileRef, hash, files })
      return null
    },
  }))
  appRouter.register(defineAction({
    id: 'profiles.declineUi', title: "Not now: don't ask about a machine's profile UI again until it changes", runs: 'app', expose: ['ui'],
    params: obj({
      machine: str(), profile: obj({ scope: union([lit('user'), lit('project')]), name: str(), dir: str() }), hash: str(),
      files: arr(obj({ path: str(), size: int() })),
    }),
    async run({ machine, profile, hash, files }) {
      if (!machineStore.get(machine)) throw new RpcError('not_found', `No machine ${machine}`)
      await uiAllowed.decline({ machine, profile: profile as ProfileRef, hash, files })
      return null
    },
  }))
  appRouter.register(defineAction({
    id: 'profiles.revokeUi', title: "Revoke a machine's profile UI in this app's windows", runs: 'app', expose: ['ui'],
    params: obj({ machine: str(), dir: str() }),
    async run({ machine, dir }) { await uiAllowed.revoke(machine, dir); return null },
  }))
  appRouter.register(defineAction({
    id: 'machines.trust', title: 'Trust the machine answering now', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ id: str() }),
    async run({ id }) { await machineStore.forgetIdentity(id); restartLink(id); return null },
  }))
  appRouter.register(defineAction({
    id: 'machines.reconnect', title: 'Reconnect a machine', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ id: str() }),
    run({ id }) { if (id === 'local') restartLocal(); else restartLink(id); return null },
  }))
  appRouter.register(defineAction({
    id: 'machines.install', title: `Update ${appConfig.name} on a machine`, runs: 'app', expose: ['ui'],
    params: obj({ id: str() }),
    run: ({ id }) => updateMachine(id),
  }))
  appRouter.register(defineAction({
    id: 'machines.login', title: 'Log in to a machine', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ id: str() }),
    /** Opens a terminal where ssh may ask for what it needs, and reconnects once it has left a login behind. Headless: no terminal. */
    run({ id }) {
      const config = machineStore.get(id)
      if (!config) throw new RpcError('not_found', `No machine ${id}`)
      if (headless) throw new RpcError('headless', 'No terminal is opened in headless mode')
      void loginInTerminal(config, { dataDir }).done.then((up) => { if (up) restartLink(id) })
      return null
    },
  }))
  appRouter.register(defineAction({
    id: 'app.cli.install', title: `Install the ${appConfig.id} command`, runs: 'app', expose: ['ui'],
    params: obj({}),
    run() { cli.install(); appSettings.invalidate(); return null },
  }))
  appRouter.register(defineAction({
    id: 'app.cli.uninstall', title: `Remove the ${appConfig.id} command`, runs: 'app', expose: ['ui'],
    params: obj({}),
    run() { cli.uninstall(); appSettings.invalidate(); return null },
  }))
  appRouter.register(defineAction({
    id: 'service.act', title: 'Restart the background process', runs: 'app', expose: ['ui'],
    params: obj({ action: union([lit('restart'), lit('interrupt'), lit('later'), lit('review')]) }),
    async run({ action }) { await service.act(action as ServiceAction); return service.state },
  }))
  /** Where a view goes, as a window tells the layout file. */
  const placement = nullable(union([str(), arr(str()), lit(false)]))
  const layoutWindows = new Set<number>()
  appRouter.register(defineAction({
    id: 'app.layout.views', title: 'Tell the layout file the views a window has', runs: 'app', expose: ['ui'],
    params: obj({ views: arr(obj({ id: str(), title: str(), fits: arr(str()), default: opt(placement), narrow: opt(placement) })) }),
    async run({ views }, { window }) {
      if (!window) throw new RpcError('invalid', 'Only a window has views')
      // Each window's, until it closes.
      if (!layoutWindows.has(window.id)) {
        layoutWindows.add(window.id)
        window.once('destroyed', () => { layoutWindows.delete(window.id); void layoutFile.setViews(window.id, undefined).catch((error) => console.error('layout.json:', error)) })
      }
      await layoutFile.setViews(window.id, views as LayoutView[])
      return null
    },
  }))
  appRouter.register(defineAction({
    id: 'app.layout.open', title: 'Open the layout file in its own app', runs: 'app', expose: ['ui'],
    async run() { await layoutFile.read(); const error = await shell.openPath(layoutFile.path); if (error) throw new RpcError('failed', error); return null },
  }))
  appRouter.register(defineAction({ id: 'app.quit', title: `Quit ${appConfig.name}`, runs: 'app', run: () => app.quit() }))

  // ── Updating another machine's Superego ─────────────────────────────────────────────────────────────────────────────

  /** Tell windows how updates go, a few times a second at most: the install prints a lot. */
  let updatesQueued = false
  const publishUpdates = () => {
    if (updatesQueued) return
    updatesQueued = true
    setTimeout(() => { updatesQueued = false; broadcast({ machine: APP, method: '$machines', params: machineEntries() }) }, 150)
  }

  /**
   * Run a machine's own install script there (pull, install, build, restart its daemon), its output shown on the
   * machine's row as it goes, then reconnect to the new daemon. The restart interrupts agents at work there: asked first.
   */
  async function updateMachine(id: string): Promise<{ updated: boolean }> {
    const config = machineStore.get(id)
    if (!config) throw new RpcError(id === 'local' ? 'invalid' : 'not_found', id === 'local' ? `This computer's ${appConfig.name} is updated by hand.` : `No machine ${id}`)
    if (updates.get(id)?.state === 'running') throw new RpcError('busy', `${config.label} is updating already.`)
    const working = (threadsOf.get(id) ?? []).filter((t) => t.status.state === 'working')
    if (working.length && !headless) {
      const { response } = await dialog.showMessageBox({
        type: 'warning', buttons: ['Update and Restart', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `${working.length === 1 ? 'An agent is' : `${working.length} agents are`} working on ${config.label}`,
        detail: `Updating restarts ${appConfig.name} there: agents stop mid-turn and pick up again after. Threads and their history are kept.`,
      })
      if (response !== 0) return { updated: false }
    }
    const pid = linkOf(id)?.hello?.machine.pid
    const update: MachineUpdate = { state: 'running', log: '' }
    const set = (patch: Partial<MachineUpdate>) => { updates.set(id, Object.assign(update, patch)); publishUpdates() }
    set({})
    try {
      await runUpdate(config, appConfig, { now: working.length > 0, onOutput: (text) => set({ log: (update.log + text).slice(-20_000) }) })
      // The daemon there restarted: reach the new one now, rather than when the old link notices.
      restartLink(id)
      const deadline = Date.now() + 60_000
      for (;;) {
        const link = linkOf(id)
        if (link?.state === 'connected' && link.hello && link.hello.machine.pid !== pid) break
        if (Date.now() > deadline) throw new RpcError('update_failed', `Updated, but ${config.label} did not answer again.`)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      set({ state: 'done' })
      return { updated: true }
    } catch (error) {
      set({ state: 'failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  // ── Restarting this computer's daemon onto newer code ───────────────────────────────────────────────────────────────

  /** The local link once it is connected with a new daemon (not `pid`), or a timeout. */
  async function reconnected(pid: number | undefined) {
    const deadline = Date.now() + 30_000
    for (;;) {
      const link = local
      if (link?.state === 'connected' && link.hello && link.hello.machine.pid !== pid) return link.hello
      if (Date.now() > deadline) throw new Error('The background process did not come back. See daemon.log in the data dir.')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  const service = new ServiceRestart({
    async inspect() {
      const link = local
      if (!link?.hello || link.state !== 'connected') throw new Error('The background process is not connected.')
      return {
        // The daemon the app would start now is the code next to it on disk.
        installedBuild: readBuild(import.meta.dirname),
        runningBuild: link.hello.machine.build,
        canRestartWhenIdle: link.has('restart'),
        busy: (threadsOf.get('local') ?? []).some((s) => s.status.state === 'working'),
      }
    },
    async restart(snapshot, interrupt) {
      const link = local!
      const pid = link.hello?.machine.pid
      if (link.has('restart')) {
        const result = await link.call('daemon.restart', { build: snapshot.runningBuild, interrupt }) as { restarted: boolean }
        if (!result.restarted) return 'busy'
      } else if (pid) {
        // Too old to restart itself: stop it (consented to), and the link starts the new one.
        process.kill(pid, 'SIGTERM')
      }
      return (await reconnected(pid)).machine.build
    },
    async confirmInterruption(snapshot) {
      if (headless) return true
      const { response } = await dialog.showMessageBox({
        type: 'warning', buttons: ['Restart Now', 'Cancel'], defaultId: 1, cancelId: 1,
        message: snapshot.canRestartWhenIdle ? 'Interrupt working agents?' : 'Restart the background process?',
        detail: 'Agents stop mid-turn and pick up again after the restart. Threads and their history are kept.',
      })
      return response === 0
    },
    changed(state) {
      broadcast({ machine: APP, method: 'service.changed', params: state })
      refreshDesktop()
    },
  })
  const pollService = () => { if (local?.state === 'connected') void service.poll() }
  setInterval(pollService, 3000).unref()

  /** Quit, and stop this computer's daemon and its agents too, asking first while any are working. */
  async function quitAndStop() {
    const working = (threadsOf.get('local') ?? []).filter((s) => s.status.state === 'working')
    if (working.length && !headless) {
      const { response } = await dialog.showMessageBox({
        type: 'warning', buttons: ['Stop Agents and Quit', 'Cancel'], defaultId: 0, cancelId: 1,
        message: `${working.length === 1 ? 'An agent is' : `${working.length} agents are`} still working`,
        detail: 'Stopping the background process ends their work. Quitting superego alone leaves them running.',
      })
      if (response !== 0) return
    }
    const pid = local?.hello?.machine.pid
    for (const link of allLinks()) link.stop()
    if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
    app.quit()
  }

  /** A window; beside `near` (down and right of it, as the system cascades), its size, when given. */
  function createWindow(near?: BrowserWindow) {
    const bounds = near && !near.isDestroyed() ? near.getBounds() : undefined
    const window = new BrowserWindow({
      width: bounds?.width ?? 1100, height: bounds?.height ?? 760, minWidth: 600, minHeight: 400,
      ...(bounds ? { x: bounds.x + 24, y: bounds.y + 24 } : {}),
      title: appConfig.name,
      titleBarStyle: 'hiddenInset',
      // Centred in the 48pt title bar (see --superego-titlebar).
      trafficLightPosition: { x: 18, y: 18 },
      backgroundColor: '#09090b',
      show: !headless,
      webPreferences: { preload: join(import.meta.dirname, '../preload/preload.cjs'), sandbox: true, contextIsolation: true },
    })
    // Links (sign-in pages, docs) open in the browser, never in the app.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // App-wide shortcuts work wherever the keyboard is. A page in a pane (Preview, an artifact) is a frame of its own,
    // and its key presses never reach the window's page; so while one has the keyboard, a press that's one of the
    // window's shortcuts is taken here, before any frame, and sent to the window to run.
    const contents = window.webContents
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.meta || input.control || input.alt)) return
      const frame = contents.focusedFrame
      if (!frame || frame === contents.mainFrame) return
      const keys = shortcutOf({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift })
      if (!keys || !boundKeys.get(contents.id)?.has(keys)) return
      event.preventDefault()
      contents.send(CHANNEL.event, { machine: APP, method: 'app.key', params: { keys } })
    })
    // Back and forward from outside the page: a mouse's buttons (Windows, Linux) and a swipe (macOS, as its trackpad
    // setting lets one through). The window goes along its own history.
    const go = (by: -1 | 1) => contents.send(CHANNEL.event, { machine: APP, method: 'app.go', params: { by } })
    window.on('app-command', (_event, command) => {
      if (command === 'browser-backward') go(-1)
      if (command === 'browser-forward') go(1)
    })
    window.on('swipe', (_event, direction) => {
      if (direction === 'left') go(-1)
      if (direction === 'right') go(1)
    })
    window.on('closed', () => refreshDesktop())
    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
    refreshDesktop()
    return window
  }

  // Artifacts: HTML the agent wrote, served from the thread's machine on a scheme of their own, sandboxed.
  protocol.registerSchemesAsPrivileged([{ scheme: 'superego-artifact', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
  app.whenReady().then(() => {
    protocol.handle('superego-artifact', async (request) => {
      const url = new URL(request.url)
      const [thread, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const link = linkOf(decodeURIComponent(url.hostname))
      if (!link || !thread || !rest.length) return new Response('Not found', { status: 404 })
      try {
        const path = rest.join('/')
        const { content } = await link.call('file.read', { id: thread, path, base64: true }) as { content: string }
        return new Response(Buffer.from(content, 'base64'), { headers: {
          'content-type': ARTIFACT_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream',
          'content-security-policy': ARTIFACT_POLICY,
        } })
      } catch (error) {
        return new Response(error instanceof Error ? error.message : 'Not found', { status: 404 })
      }
    })
    if (!primary) return
    // From source on the stock Electron.app (tests), the Dock needs telling; the app's own dev bundle has the icon.
    if (!headless && !app.isPackaged && process.execPath.includes('/Electron.app/')) dockIcon()
    setMenu()
    refreshDesktop()
    // Font pickers list the installed fonts (the Local Font Access API); nothing else is granted.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'local-fonts'))
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'local-fonts')
    // A page in a Preview pane is a frame in the window, and most sites refuse to be framed (X-Frame-Options, CSP
    // frame-ancestors), there to stop other sites wrapping them. Here the frame is the user's own pane, so for frames
    // only, those refusals are dropped; the frame stays sandboxed (no top navigation), and top-level loads are untouched.
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
    restartLocal()
    remotes.follow()
    const window = createWindow()
    const open = openArgument(process.argv)
    if (open) pending.set(window.webContents.id, { open })
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })

  // With the menu bar on, Superego stays there without windows; without it, closing the last window quits (except on macOS).
  app.on('window-all-closed', () => {
    refreshDesktop()
    if (!mac && !menuBarOn()) app.quit()
  })
  // Every quit quits: the menu bar's Quit, SIGTERM (Electron turns it into app.quit), logout. Only the ⌘Q menu item
  // is softer: with the menu bar on, it closes the windows and leaves the app there.
  app.on('before-quit', () => { for (const link of allLinks()) link.stop() })
  const quitKey = () => {
    if (menuBarOn() && !headless) for (const window of BrowserWindow.getAllWindows()) window.close()
    else app.quit()
  }
  const setMenu = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{
      label: appConfig.name,
      submenu: [
        { role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: `Quit ${appConfig.name}`, accelerator: 'CommandOrControl+Q', click: quitKey },
      ],
    } satisfies MenuItemConstructorOptions] : [{
      label: 'File', submenu: [{ label: 'Quit', accelerator: 'CommandOrControl+Q', click: quitKey }],
    } satisfies MenuItemConstructorOptions]),
    { role: 'editMenu' }, { role: 'viewMenu' },
    // ⌘W is the window's own (it closes the pane with the focus); closing the window is ⌘⇧W, and the app stays.
    {
      role: 'window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' },
        { label: 'Close Window', accelerator: 'CommandOrControl+Shift+W', click: (_item, window) => window?.close() },
        ...(mac ? [{ type: 'separator' as const }, { role: 'front' as const }] : []),
      ],
    },
  ]))
}
