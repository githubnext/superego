import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, session, shell, type MenuItemConstructorOptions } from 'electron'
import { appEnv, daemonStarting, defaultDataDir, readBuild, socketPath } from '@superego/daemon/client'
import {
  bool, defineAction, lit, obj, opt, Router, RpcError, str, union, unknown,
  type AppConfig, type DeclaredSection, type Json, type Notifications, type ThreadInfo, type SettingType,
} from '@superego/protocol'
import { serveSettings } from '@superego/settings'
import { ARTIFACT_POLICY, ARTIFACT_TYPES, CHANNEL, type CallResult, type MachineConfig, type MachineEntry, type SuperegoEvent } from '../shared.ts'
import { APP, APP_KEYS, createAppSettings } from './app-settings.ts'
import { UiTrust } from './ui-trust.ts'
import { checkIdentity, installedCommand, installMachine, Link, loginInTerminal, MachineStore, openLocal as openLocalSocket, openMachine, routeOf, sshRun } from '@superego/client'
import { MenuBar } from './tray.ts'
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
  const uiTrust = new UiTrust(dataDir)

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
      // Which remote profile UIs may run in this window (see ../ui-trust.ts).
      'ui.trust.list': async () => uiTrust.list(),
      'ui.trust.allow': async (params) => { await uiTrust.allow(params); return null },
      'ui.trust.forget': async (params) => { await uiTrust.forget(params); return null },
      'action.list': async () => appRouter.list(),
      'action.log': async () => appRouter.log(),
    }
    // The app's intents, served under their ids like a daemon's.
    for (const action of appRouter.list()) handlers[action.id] = (params) => appRouter.dispatch(action.id, params, {}, { source: 'window' })
    return handlers
  }

  const links = new Map<string, Link>()
  function addLink(link: Link) {
    links.set(link.id, link)
    link.start()
  }

  /** This computer, then every configured machine; disabled ones have no link. */
  const machineStore = new MachineStore(dataDir)
  const linkConfig = new Map<string, string>()
  function machineEntries(): MachineEntry[] {
    const local = links.get('local')
    return [
      ...(local ? [local.entry()] : []),
      ...machineStore.list().map((config): MachineEntry => {
        const remote = { route: routeOf(config, appConfig), enabled: config.enabled, ssh: !config.via }
        const link = links.get(config.id)
        return link ? { ...link.entry(), label: config.label, remote } : { id: config.id, label: config.label, state: 'disabled', remote }
      }),
    ]
  }
  /**
   * A link to a configured machine. Identity is not the route: the first daemon to answer at the target is remembered,
   * and later a different one there is refused until the user trusts it. One machine reached two ways is refused too.
   */
  function sshLink(config: MachineConfig) {
    return new Link({
      id: config.id, label: config.label,
      open: () => openMachine(config, appConfig, dataDir),
      onEvent: (method, params) => onMachineEvent(config.id, method, params),
      verify(hello) {
        const current = machineStore.get(config.id)
        const connected = [...links.values()].filter((other) => other.id !== config.id && other.state === 'connected' && other.hello)
          .map((other) => ({ label: other.label, id: other.hello!.machine.id }))
        checkIdentity(hello, { target: config.via ? 'that command' : config.target, ...(current?.daemonId ? { expected: current.daemonId } : {}) }, connected)
        if (!current?.daemonId) void machineStore.update(config.id, { daemonId: hello.machine.id })
      },
    })
  }
  function restartLocal() {
    links.get('local')?.stop()
    addLink(new Link({ id: 'local', label: 'This computer', open: openLocal, onEvent: (method, params) => onMachineEvent('local', method, params) }))
  }
  function restartLink(id: string) {
    links.get(id)?.stop()
    links.delete(id)
    linkConfig.delete(id)
    syncLinks()
  }

  /** Start, restart or stop links to match the configured machines. */
  function syncLinks() {
    const configs = machineStore.list()
    for (const [id, link] of links) {
      if (id === 'local') continue
      const config = configs.find((c) => c.id === id)
      const key = config && routeOf(config, appConfig)
      if (!config?.enabled || key !== linkConfig.get(id)) { link.stop(); links.delete(id); linkConfig.delete(id) }
    }
    for (const config of configs) {
      if (!config.enabled || links.has(config.id)) continue
      linkConfig.set(config.id, routeOf(config, appConfig))
      addLink(sshLink(config))
    }
    broadcast({ machine: APP, method: '$machines', params: machineEntries() })
    refreshDesktop()
  }
  machineStore.onChange(syncLinks)
  // The CLI edits the same list; pick up its changes.
  machineStore.watch()

  /**
   * Notify when a thread out of sight starts wanting a look: it finished, failed or needs the user. The app keeps its
   * own subscription to each machine's threads for this, whatever the windows show.
   */
  const lastStatus = new Map<string, ThreadInfo['status']['state']>()
  const watchSubs = new Map<string, string>()
  function onMachineEvent(machine: string, method: string, params: unknown) {
    if (!links.has(machine)) return
    if (method === '$connection') {
      broadcast({ machine: APP, method: '$machines', params: machineEntries() })
      refreshDesktop()
      if ((params as { state: string }).state === 'connected') {
        if (machine === 'local') setTimeout(pollService)
        void (links.get(machine)!.call('threads.watch', {}) as Promise<{ sub: string; value: ThreadInfo[] }>).then(({ sub, value }) => {
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
    threadsOf.set(machine, threads)
    refreshDesktop()
    for (const thread of threads) {
      const key = `${machine}/${thread.id}`
      const before = lastStatus.get(key)
      const now = thread.status.state
      lastStatus.set(key, now)
      if (!announce || before === now || !['done', 'error', 'blocked'].includes(now)) continue
      if (headless || BrowserWindow.getFocusedWindow() || !appSettings.get<boolean>(APP_KEYS.notifications) || !Notification.isSupported()) continue
      const label = links.get(machine)?.label ?? machine
      const body = now === 'done' ? 'Finished' : now === 'error' ? `Failed${thread.status.msg ? `: ${thread.status.msg}` : ''}` : 'Needs you'
      const notification = new Notification({ title: thread.title, subtitle: label, body })
      notification.on('click', () => show({ open: { machine, thread: thread.id } }))
      notification.show()
    }
  }

  ipcMain.handle(CHANNEL.machines, () => machineEntries())
  ipcMain.handle(CHANNEL.call, async (event, machine: string, method: string, params: unknown): Promise<CallResult> => {
    try {
      if (machine === APP) {
        const handler = appEndpoint(event.sender)[method]
        if (!handler) throw new RpcError('unknown_method', `Unknown method ${method}`)
        return { ok: true, result: await handler(params ?? {}) }
      }
      const link = links.get(machine)
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

  const appRouter = new Router<Record<string, never>>()
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
    async run({ id }) { await machineStore.remove(id); return null },
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
    id: 'machines.install', title: 'Install or update Superego on a machine', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ id: str(), service: opt(bool()) }),
    async run({ id, service }) {
      const config = machineStore.get(id)
      if (!config) throw new RpcError('not_found', `No machine ${id}`)
      const bundle = appEnv(appConfig)('REMOTE_BUNDLE') ?? join(import.meta.dirname, '../remote', `${appConfig.id}-remote.tgz`)
      const installed = await installMachine(sshRun(config, dataDir), { app: appConfig, label: config.label, bundle, ...(service ? { service } : {}) })
      await machineStore.update(id, { command: installedCommand(appConfig) })
      restartLink(id)
      return installed as unknown as Json
    },
  }))
  appRouter.register(defineAction({
    id: 'service.act', title: 'Restart the background process', runs: 'app', expose: ['ui'],
    params: obj({ action: union([lit('restart'), lit('interrupt'), lit('later'), lit('review')]) }),
    async run({ action }) { await service.act(action as ServiceAction); return service.state },
  }))
  appRouter.register(defineAction({ id: 'app.quit', title: `Quit ${appConfig.name}`, runs: 'app', run: () => app.quit() }))

  // ── Restarting this computer's daemon onto newer code ───────────────────────────────────────────────────────────────

  /** The local link once it is connected with a new daemon (not `pid`), or a timeout. */
  async function reconnected(pid: number | undefined) {
    const deadline = Date.now() + 30_000
    for (;;) {
      const link = links.get('local')
      if (link?.state === 'connected' && link.hello && link.hello.machine.pid !== pid) return link.hello
      if (Date.now() > deadline) throw new Error('The background process did not come back. See daemon.log in the data dir.')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  const service = new ServiceRestart({
    async inspect() {
      const link = links.get('local')
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
      const link = links.get('local')!
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
  const pollService = () => { if (links.get('local')?.state === 'connected') void service.poll() }
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
    const pid = links.get('local')?.hello?.machine.pid
    for (const link of links.values()) link.stop()
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
      const link = links.get(decodeURIComponent(url.hostname))
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
    if (headless) app.dock?.hide()
    // From source on the stock Electron.app (tests), the Dock needs telling; the app's own dev bundle has the icon.
    else if (!app.isPackaged && process.execPath.includes('/Electron.app/')) dockIcon()
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
    syncLinks()
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
  app.on('before-quit', () => { for (const link of links.values()) link.stop() })
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
