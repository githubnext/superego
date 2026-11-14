/// <reference path="./env.d.ts" />
// @superego/app/ui: the renderer side of an app. `mountApp(config, { extensions })` draws the shell; extensions and an app's
// own components use the hooks and components below.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@superego/ui/styles.css'
import './app.css'
import { bool, obj, opt, str, type AppConfig, type SettingsSnapshot } from '@superego/protocol'
import { watched } from './client.ts'
import { createRegistry, layoutOf, RegistryProvider, type UiExtension } from './extension.tsx'
import { LAYOUT, placeView, type Place } from './layout.ts'
import { registerLayoutText } from './layout-text.tsx'
import { Profiles, Providers } from './SettingsView.tsx'
import { WebAccess } from './web-access.tsx'
import { Shell, ThreadPicker } from './Shell.tsx'
import { SORT } from './sessions.ts'
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
  // The Providers settings section is the core's own custom component.
  const registry = createRegistry(app, extensions, (core) => {
    core.settings('providers', Providers)
    core.settings('web', WebAccess)
    core.settings('profiles', Profiles)
    core.appSettings({
      id: 'navigation', title: 'Navigation', order: 60,
      settings: [
        { key: SORT, title: 'Sort sessions and threads', default: 'recent', type: 'choice', options: [
          { value: 'recent', label: 'Recently active' }, { value: 'created', label: 'Newest first' }, { value: 'status', label: 'Needs you first' },
        ] },
      ],
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
    // The user's layout keeps it; `narrow`, the phone's layer of it.
    core.action(defineWindowAction({
      id: 'layout.place', title: 'Put a view in a place', params: obj({ view: str(), place: str(), on: opt(bool()), from: opt(str()), narrow: opt(bool()) }),
      run({ view, place, on, from, narrow }, c) {
        // Changed from the settings as last heard: before they're heard, there's nothing to change it from.
        if (!watched<SettingsSnapshot>('app', 'settings.watch', {})) throw new Error("The layout isn't loaded yet")
        const value = placeView(registry.views, layoutOf(c.appSetting(LAYOUT)), view, place as Place, {
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

export {
  defineUiExtension, fileKind, Slot, urlKind, useApp, useNarrow, usePlacement, useRegistry,
  type BehaviourSlot, type EditorSlotProps, type SpaceRailProps, type View, type ViewContext, type ViewProps, type EntryProps, type WindowEvent, type WindowEvents, type WindowState, type LinkAttributes, type LinkHandler, type LinkProps, type LinkWhere, type NewThreadField, type NewThreadFieldProps, type PaneKind, type PaneProps, type SettingsComponentProps, type SlotName, type SlotProps, type ToolCallProps, type ToolRow, type ToolRowCall, type ToolState, type UiApi, type UiExtension,
  type WorkBlock, type WorkPart, type WorkRun, type WorkStatus,
} from './extension.tsx'
export { useAppSetting } from './client.ts'
export { LAYOUT, type Layout, type Place, type Placement } from './layout.ts'
export { useDispatch } from './Shell.tsx'
export type { Dispatch } from './actions.tsx'
export { keyLabel, useActions, useKeymap, useShortcut } from './keys.ts'
export { defineWindowAction as defineAction, runsBare, type WindowAction, type WindowContext } from './actions.tsx'
export { useAllThreads, useMachines, useSelection, useSessions, useSidebar, useThreads, useShell, type Selection } from './state.tsx'
export { groupSessions, nest, sessionKey, SORT, unread, type Session, type Sort } from './sessions.ts'
export { showSession } from './actions.tsx'
export { useComposer, useComposerClaim, type Composer, type ComposerClaim } from './ThreadView.tsx'
export type { Completion, CompletionProvider, CompletionWord, ComposerWhere, SentBlock, SentWith } from './composer.ts'
export { Markdown } from './Markdown.tsx'
export { ThreadRef } from './thread-ref.tsx'
export { transcriptLinks, type TranscriptLink } from './links.tsx'
export { parseWikilink, WIKILINK, wikilinkHref, type Wikilink } from './wikilinks.ts'
export { Picker, type PickerProps, type PickerRow } from './picker.tsx'
export { useLocalState, type Store } from './local-state.ts'
export { score } from './score.ts'
export { PaneHeader, useTabNote } from './panes.tsx'
export { Diff, parseDiff, type DiffFile } from './diff.tsx'
export { FileEditor, type FileEditorProps } from './file-editor.tsx'
export { livePreview } from './live-markdown.ts'
export { call, has, loadFonts, machine, useThreadView, useSettings, useValue, useWatch, version } from './client.ts'
export { EXTENSION_API } from '@superego/protocol'
export type { MachineEntry, MachineUpdate } from '../shared.ts'
export { NOTIFY, signInNotice, threadNotice, type ThreadNotice } from '../shared.ts'
export { describeImage, ImageFrame, imageFileName, imageSourceOf, useImageSource, useNear, type ImageItem, type LoadedImage } from './images.tsx'
export { Lightbox } from './lightbox.tsx'
export { driftNote, MachineDrift } from './machine-drift.tsx'
