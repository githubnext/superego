// How the app sits on the desktop: the menu bar item, the Dock icon (and, run from source, its image) and the app menu.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import type { AppConfig } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { HIDE_DOCK, MENU_BAR } from '../shared/app-settings.ts'
import type { Windows } from './app-windows.ts'
import type { Machines } from './machines.ts'
import { MenuBar } from './menu-bar.ts'
import type { Service } from './service.ts'
import type { AppUpdates } from './app-updates.ts'

/** Its callbacks are never called while it's being made. */
export type DesktopOptions = {
  app: AppConfig
  headless: boolean
  settings: SettingsRegistry
  machines: Pick<Machines, 'entries' | 'threads'>
  service: Pick<Service, 'state' | 'act' | 'quitAndStop'>
  updates: Pick<AppUpdates, 'on' | 'checkFromMenu'>
  windows: Pick<Windows, 'all' | 'show' | 'focused' | 'recent' | 'reopen' | 'putAway'>
  /** Count the app icon's threads again. */
  refreshBadge(): void
}

export type Desktop = ReturnType<typeof createDesktop>

export function createDesktop({ app: appConfig, headless, settings, machines, service, updates, windows, refreshBadge }: DesktopOptions) {
  const mac = process.platform === 'darwin'
  const menuBarOn = () => settings.get<boolean>(MENU_BAR)
  const dockHidden = () => menuBarOn() && settings.get<boolean>(HIDE_DOCK)

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
    machines: () => machines.entries(),
    threads: (machine) => machines.threads(machine),
    open: () => windows.show(),
    openThread: (machine, thread) => windows.show({ open: { machine, thread } }),
    openSettings: () => windows.show({ settings: true }),
    quit: () => app.quit(),
    quitAndStop: () => void service.quitAndStop(),
    service: () => service.state,
    restart: () => void service.act('restart'),
  }, headless, join(resources, 'trayTemplate.png'))

  /** The Dock icon shows while a window is open, unless hidden in Settings; with no window it goes, if the menu bar has Superego. */
  function refresh() {
    // Settings announce changes from the start; the menu bar and the Dock exist only once the app is ready.
    if (!app.isReady()) return
    refreshBadge()
    menuBar.update(menuBarOn())
    if (!mac || headless) return
    const open = windows.all().length > 0
    const visible = !(dockHidden() || (!open && menuBarOn()))
    // Only on a change: Electron's dock.show() briefly activates the Dock to redraw the menu bar, which flashes the app.
    if (!app.dock || app.dock.isVisible() === visible) return
    if (visible) void app.dock.show()
    else app.dock.hide()
  }
  settings.onChange(refresh)

  // Every quit quits: the menu bar's Quit, SIGTERM (Electron turns it into app.quit), logout. Only the ⌘Q menu item
  // is softer: with the menu bar on, it closes the windows and leaves the app there, put away to come back as they were.
  const quitKey = () => {
    if (!menuBarOn() || headless) return app.quit()
    windows.putAway()
  }
  /** File → New Window: the window in front runs its own action (it starts the new one as a copy of itself). */
  const newWindow = () => {
    const front = windows.focused() ?? windows.recent()
    if (front) front.sendApp('app.action', { action: 'app.newWindow' })
    else windows.reopen()
  }
  const setMenu = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{
      label: appConfig.name,
      submenu: [
        { role: 'about' },
        ...(updates.on ? [{ label: 'Check for Updates…', click: () => void updates.checkFromMenu().catch((error: unknown) => console.error('Check for updates:', error)) }] : []),
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: `Quit ${appConfig.name}`, accelerator: 'CommandOrControl+Q', click: quitKey },
      ],
    } satisfies MenuItemConstructorOptions] : []),
    // The window's own action has the shortcut (Settings → Hotkeys): the menu shows it without taking it first.
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CommandOrControl+Shift+N', registerAccelerator: false, click: newWindow },
        ...(mac ? [] : [{ type: 'separator' as const }, { label: 'Quit', accelerator: 'CommandOrControl+Q', click: quitKey }]),
      ],
    },
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

  return {
    refresh,
    /** Once the app is ready: the app menu, the Dock's image run from source, the menu bar item. */
    start() {
      // From source on the stock Electron.app (tests), the Dock needs telling; the app's own dev bundle has the icon.
      if (!headless && !app.isPackaged && process.execPath.includes('/Electron.app/')) dockIcon()
      setMenu()
      refresh()
    },
    /** With the menu bar on, Superego stays there without windows; without it, closing the last window quits (except on macOS). */
    allClosed() {
      refresh()
      if (!mac && !menuBarOn()) app.quit()
    },
    /** How the app sits on the desktop now: for the smoke test. */
    state: () => ({ menuBar: menuBar.shown, dockHidden: mac && dockHidden() }),
  }
}
