import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { appEnv, defaultDataDir } from '@superego/daemon/client'
import { installTypes } from '@superego/client/author-types'
import { createRouter, envName, type AppConfig } from '@superego/protocol'
import { SettingsRegistry } from '@superego/settings'
import { FileSettingsStore } from '@superego/settings/file'
import { APP, registerAppSettings } from '../shared/app-settings.ts'
import type { ThreadRef } from '../shared/bridge.ts'
import { appMethods, callApp, registerAppActions, type AppActionContext } from './app-endpoint.ts'
import { createWindows, setUpSession } from './app-windows.ts'
import { readMainBuild } from './build.ts'
import { registerArtifactScheme } from './artifacts.ts'
import { commandLine } from './command-line.ts'
import { createDesktop } from './desktop.ts'
import { serveIpc } from './ipc.ts'
import { createForwards } from './forwards.ts'
import { serveWebViews, type AskingView } from './web-views.ts'
import { createSitePermissions, fileStore } from './site-permissions.ts'
import { LayoutFile } from './layout-file.ts'
import { createMachines } from './machines.ts'
import { createNotifier } from './notify.ts'
import { createService } from './service.ts'

/**
 * Run an app's main process: its windows, the links to every machine (starting this computer's daemon, which outlives
 * the app), the app's own settings, the menu bar item and Dock, notifications, and restarting the daemon onto new code.
 * The app's `src/main.ts` calls this with its config; the build puts `daemon.js`, the preload and the renderer next to it.
 */
export function startApp(appConfig: AppConfig) {
  /** Headless (tests): no window, Dock icon, notification or focus; nothing that reaches the screen. */
  const headless = Boolean(appEnv(appConfig)('HEADLESS'))
  // Before it finishes launching, so the Dock never shows it.
  if (headless) app.dock?.hide()
  const dataDir = defaultDataDir(appConfig)
  // Which build this is, for the windows to compare theirs with; none in a packaged app, whose build never changes.
  const build = readMainBuild(import.meta.dirname)
  // Under `pnpm dev` (scripts/dev.ts), restarting is quitting with this code: the dev script builds the main process
  // again and starts it. Not passed on to the daemon this starts, nor its agents.
  const devRestart = Number(appEnv(appConfig)('DEV_RESTART')) || undefined
  delete process.env[envName(appConfig, 'DEV_RESTART')]

  // The app's own settings, kept in its data dir; the windows' extensions declare theirs beside them.
  const settings = new SettingsRegistry(new FileSettingsStore(join(dataDir, 'app-settings.json')))
  registerAppSettings(settings, { app: appConfig, mac: process.platform === 'darwin' })
  // The layout as text: layout.json, read in as it's saved, and what's wrong with it told to the windows.
  const layoutFile = new LayoutFile(dataDir, settings, () => settings.invalidate())
  settings.register({
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
  settings.register({
    id: 'command-line', title: 'Command line', order: 80, ui: 'command-line', settings: [],
    data: () => cli.info(),
  })
  // What sites in Preview may use, as the user said (site-permissions.ts), and Settings' list of them to forget.
  const siteStore = fileStore(join(dataDir, 'preview-sites.json'))
  const sites = createSitePermissions<AskingView>({ store: siteStore, asking: (view, ask) => view.asking(ask), changed: () => settings.invalidate() })
  settings.register({
    id: 'sites', title: 'Site permissions', order: 75, ui: 'sites', settings: [],
    data: () => ({ sites: sites.list(), ...(siteStore.problem ? { problem: siteStore.problem } : {}) }),
  })
  // Types for profile authors, from this build (out/types) to <dataDir>/types, where profiles link to them: an upgrade
  // brings its own without anyone asking. Not for tests.
  const types = join(import.meta.dirname, '..', 'types')
  if (!headless && existsSync(join(types, 'stamp.json'))) setImmediate(() => { installTypes(types, dataDir).catch((error) => console.error('author types:', error)) })

  // The parts below reach each other both ways (the machines tell the windows and the Dock of changes, the windows ask
  // the machines), so each is made from those before it, and its callbacks may name those after it: none calls one
  // while it's being made (each Options type says so), and nothing starts before every part is made (app.whenReady).
  const machines = createMachines({
    app: appConfig, dataDir, headless,
    broadcast: (event) => windows.broadcast(event),
    onEvent(machine, method, params) {
      // Another client asking the app to show something: one window does it, the one in front.
      if (method === 'client.perform') return void (windows.focused() ?? windows.recent())?.send({ machine, method, params })
      windows.broadcast({ machine, method, params })
    },
    changed() {
      windows.broadcast({ machine: APP, method: '$machines', params: machines.entries() })
      desktop.refresh()
    },
    // Restart required, now it's connected again or has refused (another generation)?
    connection(machine) { if (machine === 'local') setTimeout(service.poll) },
    threads(machine, threads) {
      desktop.refresh()
      notifier.track(machine, threads)
    },
    rejected: (machine, rejections) => notifier.rejected(machine, rejections),
  })
  const service = createService({
    app: appConfig, dataDir, headless, machines,
    changed(state) {
      windows.broadcast({ machine: APP, method: 'service.changed', params: state })
      desktop.refresh()
    },
  })
  const notifier = createNotifier({
    headless, settings, machines,
    windowFocused: () => Boolean(windows.focused()),
    lookedAt: () => windows.focused()?.shown,
    open: (open) => windows.show({ open }),
  })

  const router = createRouter<AppActionContext>()
  machines.registerActions(router)
  registerAppActions(router, { app: appConfig, settings, cli, service, layoutFile, sites, quit: () => app.quit(), restart: () => restartApp(devRestart) })
  const windows = createWindows({
    app: appConfig, dataDir, headless,
    methods: (window) => appMethods(window, { settings, router, service, notifier, machines, windows, desktop, build }),
    changed: () => desktop.refresh(),
    lookedAtChanged: () => notifier.refreshBadge(),
    closed(window) {
      if (window.declaredViews) void layoutFile.setViews(window.id, undefined).catch((error) => console.error('layout.json:', error))
    },
  })
  const desktop = createDesktop({ app: appConfig, headless, settings, machines, service, windows, refreshBadge: notifier.refreshBadge })
  const forwards = createForwards({ machines: machines.entries, linkOf: machines.linkOf })
  serveIpc({
    machines: machines.entries, linkOf: machines.linkOf, windowOf: windows.of, callApp: (window, method, params) => callApp(router, window, method, params),
    forwardUrl: forwards.urlFor,
  })

  /**
   * One app per data dir: its Electron state lives in the data dir, so the lock that keeps a second launch from opening
   * a second app is per data dir too. A second launch (`superego`, `superego open`) hands its arguments over and exits.
   */
  app.setName(appConfig.name)
  app.setPath('userData', join(dataDir, 'app'))
  const primary = app.requestSingleInstanceLock()
  if (!primary) app.quit()
  app.on('second-instance', (_event, argv) => {
    const open = openArgument(argv)
    windows.show(open ? { open } : {})
  })

  registerArtifactScheme()
  app.whenReady().then(() => {
    if (!primary) return
    serveWebViews({ windowOf: windows.of, linkOf: machines.linkOf, sites })
    desktop.start()
    setUpSession()
    machines.start()
    const window = windows.reopen()
    const open = openArgument(process.argv)
    if (open) window.pending = { open }
    app.on('activate', () => { if (!windows.all().length) windows.reopen() })
  })

  app.on('window-all-closed', () => desktop.allClosed())
  // Every window open as it quits comes back at the next launch.
  app.on('before-quit', () => { windows.quitting(); layoutFile.stop(); forwards.close(); machines.stop() })
}

/**
 * Quit (the windows open now come back) and start again, onto the build on disk now. Under `pnpm dev`, by
 * quitting with `devRestart`: relaunched here, the app would run the main process it was built with and lose the dev
 * server, so the dev script builds it again and starts it.
 */
function restartApp(devRestart: number | undefined) {
  if (devRestart) app.once('will-quit', (event) => { event.preventDefault(); app.exit(devRestart) })
  else app.relaunch()
  app.quit()
}

/** `--superego-open=<machine>/<thread>`, as `superego` passes it. */
function openArgument(argv: string[]): ThreadRef | undefined {
  const value = argv.find((arg) => arg.startsWith('--superego-open='))?.slice('--superego-open='.length)
  const slash = value?.lastIndexOf('/') ?? -1
  return value && slash > 0 ? { machine: value.slice(0, slash), thread: value.slice(slash + 1) } : undefined
}
