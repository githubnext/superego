// The app's own endpoint (`APP`), kept in the page where there's no main process to keep it: a browser's
// (web-bridge.ts), and a test's window (superego/testing's `mountUi`). Its settings are the desktop's own
// (registerAppSettings), kept in `store`; its changes are told through `emit`, as the desktop's main process tells them.
import { RpcError, type ActionInfo, type Json } from '@superego/protocol'
import { declaredSpec, MemorySettingsStore, serveSettings, SettingsRegistry, type SettingsStore } from '@superego/settings'
import type { BrowserAppHandlers, SuperegoEvent } from '../shared/bridge.ts'
import { APP, registerAppSettings } from '../shared/app-settings.ts'
import { storedThemes, themeActions, type ThemeStore } from '../shared/themes.ts'

/** An action the page's app runs: its info for the router, and what it does. */
export type PageAppAction = { info: ActionInfo; run(params: never): Promise<unknown> }

/**
 * `store`: where its settings are kept, `themes` its imported themes (both in memory unless given); `actions`: the page's
 * own, beside `app.settings.set` and the themes'.
 */
export function pageApp(emit: (event: SuperegoEvent) => void, { store = new MemorySettingsStore(), themes = storedThemes(), actions: more = {} }: { store?: SettingsStore; themes?: ThemeStore; actions?: Record<string, PageAppAction> } = {}) {
  const settings = new SettingsRegistry(store)
  registerAppSettings(settings, { themes })
  const theme = themeActions(themes, settings)
  const subs = new Map<string, () => unknown>()
  const served = serveSettings(settings, (params) => emit({ machine: APP, method: 'settings.changed', params }), subs)
  /** The app's actions a page can run: the desktop's main process has more (adding machines, updating them, …). */
  const actions: Record<string, PageAppAction> = {
    'app.settings.set': {
      info: { id: 'app.settings.set', title: 'Change an app setting', runs: 'app', expose: ['ui'] },
      run: async ({ key, value }: { key: string; value: Json }) => { await settings.set(key, value); return null },
    },
    'app.themes.add': {
      info: { id: 'app.themes.add', title: 'Add an imported theme', runs: 'app', expose: ['ui'] },
      run: theme.add,
    },
    'app.themes.remove': {
      info: { id: 'app.themes.remove', title: 'Remove an imported theme', runs: 'app', expose: ['ui'] },
      run: theme.remove,
    },
    ...more,
  }
  const handlers = {
    'settings.watch': served['settings.watch'],
    'settings.register': async ({ section }) => { settings.upsert(declaredSpec(section)); return null },
    unwatch: async ({ sub }) => { await subs.get(sub)?.(); subs.delete(sub); return null },
    'action.list': async () => Object.values(actions).map((action) => action.info),
    'action.log': async () => [],
    'app.ready': async () => ({}),
    'service.get': async () => ({ phase: 'current', busy: false, deferred: false }),
    // Another machine's profile UI (reached through this daemon) is allowed only on a desktop: none runs here.
    'profileUi.allowed': async () => [],
    'profileUi.declined': async () => [],
  } satisfies BrowserAppHandlers
  return {
    settings,
    /** What answers `method` here, if anything does. */
    answer(method: string): ((params: never) => Promise<unknown>) | undefined {
      return method in handlers ? handlers[method as keyof typeof handlers] as (params: never) => Promise<unknown> : actions[method]?.run
    },
    /** Answer `method`, or say it's the desktop's alone. */
    call(method: string, params: unknown): Promise<unknown> {
      const handler = this.answer(method)
      if (!handler) throw new RpcError('unsupported', `${method} is part of the desktop app`)
      return handler(params as never)
    },
  }
}
