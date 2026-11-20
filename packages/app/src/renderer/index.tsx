/// <reference path="./env.d.ts" />
// @superego/app/ui: the renderer side of an app. `mountApp(config, { extensions })` draws the shell; extensions and an app's
// own components use the hooks and components below.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@superego/ui/styles.css'
import './app.css'
import { bool, obj, opt, str, type AppConfig, type SettingsSnapshot } from '@superego/protocol'
import { watched } from './client.ts'
import type { UiExtension } from './extension-api.ts'
import { createRegistry, RegistryProvider, type Registry } from './registry.tsx'
import { layoutOf, placeScope, scopedViews } from './placement.tsx'
import { APP, LAYOUT } from '../shared/app-settings.ts'
import { placeView, type Place } from '../shared/layout.ts'
import { registerLayoutText } from './layout-text.tsx'
import { Profiles } from './settings/profiles.tsx'
import { Providers } from './settings/providers.tsx'
import { ModelFavourites } from './settings/models.tsx'
import { CommandLine } from './command-line.tsx'
import { About } from './about.tsx'
import { SitePermissions } from './site-permissions.tsx'
import { WebAccess } from './web-access.tsx'
import { ConnectedClients } from './connected.tsx'
import { Shell, ThreadPicker } from './Shell.tsx'
import { SORT } from './projects.ts'
import { PINS, SHOW_PINNED } from './pins.ts'
import { DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH, SIDEBAR_WIDTH } from './sidebar-width.ts'
import { ShellStateProvider } from './state.tsx'
import { coreActions, defineWindowAction } from './actions.tsx'
import { webBridge } from './web-bridge.ts'
import { registerBuiltInPanes } from './panes.tsx'
import { registerToolRows } from './tool-rows.tsx'
import { registerLinks } from './links.tsx'
import { registerSeen } from './seen.ts'
import { registerProfileUi } from './profile-ui-notice.tsx'
import { registerNotifications } from './notifications.tsx'

export function mountApp(app: AppConfig, { extensions = [], root = document.getElementById('root')! }: { extensions?: UiExtension[]; root?: HTMLElement } = {}) {
  // In a browser there is no preload: the bridge is a WebSocket to the daemon that served the page.
  if (!window.superego) window.superego = webBridge()
  const registry = windowRegistry(app, extensions)
  window.superegoRegistered = () => registeredIn(registry)
  void registry.router.load(APP)
  // Declared before anything renders, so a component reading or setting them finds them registered.
  for (const { owner: _owner, ...section } of registry.appSettings) void window.superego.call(APP, 'settings.register', { section }).catch((error) => console.error(error))
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider registry={registry}>
        <ShellStateProvider><Shell /></ShellStateProvider>
      </RegistryProvider>
    </StrictMode>,
  )
}

declare global {
  interface Window {
    /** What the window's extensions registered now, by owner: for checks from outside (the evals, a debugging session). */
    superegoRegistered?: () => Registered
  }
}

/** Who registered something: an extension, of a profile (its key) or the app's. */
type RegisteredOwner = { extension: string; profile?: string }
export type Registered = {
  panes: (RegisteredOwner & { kind: string })[]
  slots: Record<string, RegisteredOwner[]>
  views: (RegisteredOwner & { id: string })[]
}

function registeredIn(registry: Registry): Registered {
  const owner = ({ extension, profile }: { extension: string; profile?: string }): RegisteredOwner => ({ extension, ...(profile ? { profile } : {}) })
  return {
    panes: registry.panes.map((p) => ({ kind: p.kind, ...owner(p.owner) })),
    slots: Object.fromEntries(Object.entries(registry.slots).map(([name, list]) => [name, list.map((s) => owner(s.owner))])),
    views: registry.views.map((v) => ({ id: v.id, ...owner(v.owner) })),
  }
}

/** The window's registry: the core's own (its panes, rows, links, actions, the thread picker), then `extensions`. */
export function windowRegistry(app: AppConfig, extensions: UiExtension[]) {
  // The Providers settings section is the core's own custom component.
  const registry = createRegistry(app, extensions, (core) => {
    core.settings('providers', Providers)
    core.settings('models', ModelFavourites)
    core.settings('web', WebAccess)
    core.settings('clients', ConnectedClients)
    core.settings('profiles', Profiles)
    core.settings('command-line', CommandLine)
    core.settings('sites', SitePermissions)
    core.settings('about', About)
    core.appSettings({
      id: 'navigation', title: 'Navigation', order: 60,
      settings: [
        { key: SORT, title: 'Sort projects and threads', default: 'recent', type: 'choice', options: [
          { value: 'recent', label: 'Recently active' }, { value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' }, { value: 'name', label: 'Alphabetical' },
        ] },
        { key: SHOW_PINNED, title: 'Show pinned', default: true, type: 'boolean' },
      ],
    })
    // Changed by dragging the sidebar's edge, and by pinning threads, not in Settings.
    core.appSettings({
      id: 'sidebar', title: 'Sidebar', order: 61,
      settings: [
        { key: SIDEBAR_WIDTH, title: 'Sidebar width', default: DEFAULT_WIDTH, type: 'number', min: MIN_WIDTH, max: MAX_WIDTH, step: 1, hidden: true },
        { key: PINS, title: 'Pinned threads', default: [], type: 'pins', hidden: true },
      ],
    })
    registerBuiltInPanes(core)
    registerToolRows(core)
    registerLinks(core)
    registerSeen(core)
    registerProfileUi(core)
    registerNotifications(core)
    for (const action of coreActions(app)) core.action(action)
    // Every thread in a menu, and a new one: at the title bar's start while there's no space (no sidebar).
    core.view('core.picker', { title: 'Threads', context: 'window', fits: ['titlebar'], withoutSpaces: 'titlebar', component: ThreadPicker })
    // A view put in a place, or taken out (toggled, unless `on` says); `from`: taken out of that one too, moved there.
    // The user's layout keeps it; `narrow`, the phone's layer of it. Worked out from the view as the place is drawn
    // for `machine` and `thread` (else the selected thread): its declaration there, where it is there now.
    core.action(defineWindowAction({
      id: 'layout.place', title: 'Put a view in a place',
      params: obj({ view: str(), place: str(), on: opt(bool()), from: opt(str()), narrow: opt(bool()), machine: opt(str()), thread: opt(str()) }),
      run({ view, place, on, from, narrow, machine, thread }, c) {
        // Changed from the settings as last heard: before they're heard, there's nothing to change it from.
        if (!watched<SettingsSnapshot>(APP, 'settings.watch', {})) throw new Error("The layout isn't loaded yet")
        const at = machine && thread ? { machine, thread } : c.selection
        const info = at && c.threadOf(at)
        if (machine && thread && !info) throw new Error(`No thread ${thread} on ${machine} here`)
        const where = at && info ? { machine: at.machine, thread: info } : undefined
        const scope = placeScope(place as Place, where) ?? (from ? placeScope(from as Place, where) : undefined)
        const value = placeView(scopedViews(registry, scope), layoutOf(c.appSetting(LAYOUT)), view, place as Place, {
          ...(on === undefined ? {} : { on }), ...(from ? { from: from as Place } : {}), ...(narrow ? { narrow } : {}),
        })
        return c.dispatch('app.settings.set', { key: LAYOUT, value }, { machine: APP, source: 'layout' })
      },
    }))
    // Every view back where it goes by default, wide and on a phone: in a browser too, which keeps its layout itself.
    core.action(defineWindowAction({
      id: 'layout.reset', title: 'Reset layout',
      run: (_params, c) => c.dispatch('app.settings.set', { key: LAYOUT, value: {} }, { machine: APP, source: 'layout' }),
    }))
    registerLayoutText(core)
  })
  return registry
}

// Everything an extension can import: the stable author surface (what profiles get as 'superego/ui') and the window's
// own workings (their 'superego/unstable'). Bundled extensions take both from here.
export * from './sdk-ui.ts'
export * from './sdk-unstable.ts'
// Blocks, for the bundled extensions that draw them (agent-ui): not in `superego/ui` or `superego/unstable` (yet).
export { Blocks, type BlocksHost, type BlocksProps } from './blocks/blocks.tsx'
