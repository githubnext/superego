/// <reference path="./env.d.ts" />
// @superego/app/ui: the renderer side of an app. `mountApp(config, { extensions })` draws the shell; extensions and an app's
// own components use the hooks and components below.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@superego/ui/styles.css'
import './app.css'
import { bool, obj, opt, str, type AppConfig, type SettingsSnapshot } from '@superego/protocol'
import { watched } from './client.ts'
import { createRegistry, layoutOf, placeScope, RegistryProvider, scopedViews, type UiExtension } from './extension.tsx'
import { LAYOUT, placeView, type Place } from './layout.ts'
import { registerLayoutText } from './layout-text.tsx'
import { Profiles, Providers } from './SettingsView.tsx'
import { CommandLine } from './command-line.tsx'
import { WebAccess } from './web-access.tsx'
import { ConnectedClients } from './connected.tsx'
import { Shell, ThreadPicker } from './Shell.tsx'
import { SORT } from './sessions.ts'
import { DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH, SIDEBAR_WIDTH } from './sidebar-width.ts'
import { ShellStateProvider } from './state.tsx'
import { coreActions, defineWindowAction } from './actions.tsx'
import { webBridge } from './web-bridge.ts'
import { registerBuiltInPanes } from './panes.tsx'
import { registerToolRows } from './tool-rows.tsx'
import { registerLinks } from './links.tsx'
import { registerSeen } from './seen.ts'
import { registerProfileUi } from './profile-ui-notice.tsx'

export function mountApp(app: AppConfig, { extensions = [], root = document.getElementById('root')! }: { extensions?: UiExtension[]; root?: HTMLElement } = {}) {
  // In a browser there is no preload: the bridge is a WebSocket to the daemon that served the page.
  if (!window.superego) window.superego = webBridge()
  const registry = windowRegistry(app, extensions)
  void registry.router.load('app')
  // Declared before anything renders, so a component reading or setting them finds them registered.
  for (const { owner: _owner, ...section } of registry.appSettings) void window.superego.call('app', 'settings.register', { section }).catch((error) => console.error(error))
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider registry={registry}>
        <ShellStateProvider><Shell /></ShellStateProvider>
      </RegistryProvider>
    </StrictMode>,
  )
}

/** The window's registry: the core's own (its panes, rows, links, actions, the thread picker), then `extensions`. */
export function windowRegistry(app: AppConfig, extensions: UiExtension[]) {
  // The Providers settings section is the core's own custom component.
  const registry = createRegistry(app, extensions, (core) => {
    core.settings('providers', Providers)
    core.settings('web', WebAccess)
    core.settings('clients', ConnectedClients)
    core.settings('profiles', Profiles)
    core.settings('command-line', CommandLine)
    core.appSettings({
      id: 'navigation', title: 'Navigation', order: 60,
      settings: [
        { key: SORT, title: 'Sort sessions and threads', default: 'recent', type: 'choice', options: [
          { value: 'recent', label: 'Recently active' }, { value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' },
        ] },
      ],
    })
    // Changed by dragging the sidebar's edge, not in Settings.
    core.appSettings({
      id: 'sidebar', title: 'Sidebar', order: 61,
      settings: [{ key: SIDEBAR_WIDTH, title: 'Sidebar width', default: DEFAULT_WIDTH, type: 'number', min: MIN_WIDTH, max: MAX_WIDTH, step: 1, hidden: true }],
    })
    registerBuiltInPanes(core)
    registerToolRows(core)
    registerLinks(core)
    registerSeen(core)
    registerProfileUi(core)
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
        if (!watched<SettingsSnapshot>('app', 'settings.watch', {})) throw new Error("The layout isn't loaded yet")
        const at = machine && thread ? { machine, thread } : c.selection
        const info = at && c.threadOf(at)
        if (machine && thread && !info) throw new Error(`No thread ${thread} on ${machine} here`)
        const where = at && info ? { machine: at.machine, thread: info } : undefined
        const scope = placeScope(place as Place, where) ?? (from ? placeScope(from as Place, where) : undefined)
        const value = placeView(scopedViews(registry, scope), layoutOf(c.appSetting(LAYOUT)), view, place as Place, {
          ...(on === undefined ? {} : { on }), ...(from ? { from: from as Place } : {}), ...(narrow ? { narrow } : {}),
        })
        return c.dispatch('app.settings.set', { key: LAYOUT, value }, { machine: 'app', source: 'layout' })
      },
    }))
    // Every view back where it goes by default, wide and on a phone: in a browser too, which keeps its layout itself.
    core.action(defineWindowAction({
      id: 'layout.reset', title: 'Reset layout',
      run: (_params, c) => c.dispatch('app.settings.set', { key: LAYOUT, value: {} }, { machine: 'app', source: 'layout' }),
    }))
    registerLayoutText(core)
  })
  return registry
}

// Everything an extension can import: the stable author surface (what profiles get as 'superego/ui') and the window's
// own workings (their 'superego/unstable'). Bundled extensions take both from here.
export * from './sdk-ui.ts'
export * from './sdk-unstable.ts'
