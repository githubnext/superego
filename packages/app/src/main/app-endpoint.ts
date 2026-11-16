// The app's own endpoint, answered for each window as the machine `APP`: its settings (and those the windows'
// extensions declare), the desktop's methods (shared/bridge.ts's AppHandlers), and the app's actions, served under
// their ids like a daemon's.
import { dialog, shell } from 'electron'
import { arr, defineAction, lit, nullable, obj, opt, RpcError, str, union, unknown, type AppConfig, type Json, type Router } from '@superego/protocol'
import { declaredSpec, serveSettings, type SettingsRegistry } from '@superego/settings'
import type { AppHandlers } from '../shared/bridge.ts'
import type { LayoutView } from '../shared/layout.ts'
import type { ServiceAction } from '../shared/service.ts'
import { windowState, type AppWindow, type Windows } from './app-windows.ts'
import type { commandLine } from './command-line.ts'
import type { Desktop } from './desktop.ts'
import type { LayoutFile } from './layout-file.ts'
import type { Machines } from './machines.ts'
import type { Notifier } from './notify.ts'
import type { Service } from './service.ts'

/** What the app's actions run for: a window (its own, from its endpoint), or none (the CLI's). */
export type AppActionContext = { window?: AppWindow }

export type EndpointOptions = {
  settings: SettingsRegistry
  router: Router<AppActionContext>
  service: Pick<Service, 'state'>
  notifier: Pick<Notifier, 'refreshBadge'>
  machines: Pick<Machines, 'update' | 'uiAllowed'>
  windows: Pick<Windows, 'create' | 'ids'>
  desktop: Pick<Desktop, 'state'>
}

/** A window's methods on the app's endpoint. */
export function appMethods(window: AppWindow, { settings, router, service, notifier, machines, windows, desktop }: EndpointOptions): AppHandlers {
  return {
    'settings.watch': serveSettings(settings, (params) => window.sendApp('settings.changed', params), window.subs)['settings.watch'],
    async unwatch({ sub }) { window.subs.get(sub)?.(); window.subs.delete(sub); return null },
    async 'settings.register'({ section }) {
      if (!section?.id || !Array.isArray(section.settings)) throw new RpcError('invalid', 'A section needs an id and settings')
      settings.upsert(declaredSpec(section))
      return null
    },
    'action.list': async () => router.list(),
    'action.log': async () => router.log(),
    async 'service.get'() { return service.state },
    async 'app.ready'() {
      window.ready = true
      const what = window.pending
      window.pending = undefined
      return what ?? {}
    },
    'profileUi.allowed': async () => machines.uiAllowed.list(),
    'profileUi.declined': async () => machines.uiAllowed.declinedList(),
    async 'app.pickFolder'({ defaultPath }) {
      const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], ...(defaultPath ? { defaultPath } : {}) }
      const { canceled, filePaths } = window.browser.isDestroyed() ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window.browser, options)
      return canceled ? null : filePaths[0] ?? null
    },
    async 'app.newWindow'({ state }) {
      const seed = windowState(state)
      windows.create({ near: window, ...(seed ? { seed } : {}) })
      return null
    },
    async 'app.windows'() { return windows.ids() },
    // Taken first while a page in a pane has the keyboard (see app-windows.ts).
    async 'app.boundKeys'({ keys }) { window.boundKeys = new Set(keys); return null },
    async 'app.shown'({ selection }) {
      window.shown = selection ?? undefined
      notifier.refreshBadge()
      return null
    },
    'app.updateMachine': ({ machine }) => machines.update(machine, window.browser),
    async 'app.desktop'() { return desktop.state() },
  }
}

/** A call on the app's endpoint from `window`: one of its methods, else one of the app's actions. */
export function callApp(router: Router<AppActionContext>, window: AppWindow, method: string, params: unknown): Promise<unknown> {
  if (Object.hasOwn(window.methods, method)) return (window.methods as unknown as Record<string, (params: unknown) => Promise<unknown>>)[method]!(params)
  if (router.has(method)) return router.dispatch(method, params, { window }, { source: 'window' })
  throw new RpcError('unknown_method', `Unknown method ${method}`)
}

/** The app's own actions, besides the machines' (machines.ts). */
export function registerAppActions(router: Router<AppActionContext>, { app: appConfig, settings, cli, service, layoutFile, quit }: {
  app: AppConfig
  settings: SettingsRegistry
  cli: ReturnType<typeof commandLine>
  service: Pick<Service, 'state' | 'act'>
  layoutFile: LayoutFile
  quit(): void
}) {
  router.register(defineAction({
    id: 'app.settings.set', title: 'Change an app setting', runs: 'app', expose: ['ui', 'cli'],
    params: obj({ key: str(), value: unknown() }),
    async run({ key, value }) { await settings.set(key, value as Json); return null },
  }))
  router.register(defineAction({
    id: 'app.cli.install', title: `Install the ${appConfig.id} command`, runs: 'app', expose: ['ui'],
    params: obj({}),
    run() { cli.install(); settings.invalidate(); return null },
  }))
  router.register(defineAction({
    id: 'app.cli.uninstall', title: `Remove the ${appConfig.id} command`, runs: 'app', expose: ['ui'],
    params: obj({}),
    run() { cli.uninstall(); settings.invalidate(); return null },
  }))
  router.register(defineAction({
    id: 'service.act', title: 'Restart the daemon', runs: 'app', expose: ['ui'],
    params: obj({ action: union([lit('restart'), lit('interrupt'), lit('later'), lit('review')]) }),
    async run({ action }) { await service.act(action as ServiceAction); return service.state },
  }))
  /** Where a view goes, as a window tells the layout file. */
  const placement = nullable(union([str(), arr(str()), lit(false)]))
  router.register(defineAction({
    id: 'app.layout.views', title: 'Tell the layout file the views a window has', runs: 'app', expose: ['ui'],
    params: obj({ views: arr(obj({ id: str(), title: str(), fits: arr(str()), default: opt(placement), narrow: opt(placement) })) }),
    async run({ views }, { window }) {
      if (!window) throw new RpcError('invalid', 'Only a window has views')
      // Each window's, until it closes.
      window.declaredViews = true
      await layoutFile.setViews(window.id, views as LayoutView[])
      return null
    },
  }))
  router.register(defineAction({
    id: 'app.layout.open', title: 'Open the layout file in its own app', runs: 'app', expose: ['ui'],
    async run() { await layoutFile.read(); const error = await shell.openPath(layoutFile.path); if (error) throw new RpcError('failed', error); return null },
  }))
  router.register(defineAction({ id: 'app.quit', title: `Quit ${appConfig.name}`, runs: 'app', run: quit }))
}
