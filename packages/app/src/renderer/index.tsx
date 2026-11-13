/// <reference path="./env.d.ts" />
// @superego/app/ui: the renderer side of an app. `mountApp(config, { extensions })` draws the shell; extensions and an app's
// own components use the hooks and components below.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@superego/ui/styles.css'
import './app.css'
import type { AppConfig } from '@superego/protocol'
import { createRegistry, RegistryProvider, type UiExtension } from './extension.tsx'
import { Profiles, Providers, WebAccess } from './SettingsView.tsx'
import { Shell } from './Shell.tsx'
import { SORT } from './sessions.ts'
import { ShellStateProvider } from './state.tsx'
import { coreActions } from './actions.tsx'
import { webBridge } from './web-bridge.ts'
import { registerBuiltInPanes } from './panes.tsx'
import { registerToolRows } from './tool-rows.tsx'
import { registerLinks } from './links.tsx'
import { registerSeen } from './seen.ts'

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
    for (const action of coreActions(app)) core.action(action)
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
  defineUiExtension, fileKind, Slot, urlKind, useApp, useRegistry,
  type EditorSlotProps, type EntryProps, type WindowEvent, type WindowEvents, type WindowState, type LinkAttributes, type LinkHandler, type LinkProps, type LinkWhere, type PaneKind, type PaneProps, type SettingsComponentProps, type SlotName, type SlotProps, type ToolCallProps, type ToolRow, type ToolRowCall, type ToolState, type UiApi, type UiExtension,
  type WorkBlock, type WorkPart, type WorkRun, type WorkStatus,
} from './extension.tsx'
export { useAppSetting } from './client.ts'
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
export { Picker, type PickerProps, type PickerRow } from './picker.tsx'
export { useLocalState, type Store } from './local-state.ts'
export { score } from './score.ts'
export { PaneHeader, useTabNote } from './panes.tsx'
export { Diff, parseDiff, type DiffFile } from './diff.tsx'
export { FileEditor, type FileEditorProps, type MarkdownLink } from './file-editor.tsx'
export { livePreview } from './live-markdown.ts'
export { call, has, loadFonts, machine, useThreadView, useSettings, useValue, useWatch } from './client.ts'
export type { MachineEntry, MachineUpdate } from '../shared.ts'
export { NOTIFY, threadNotice, type ThreadNotice } from '../shared.ts'
export { describeImage, ImageFrame, imageFileName, imageSourceOf, useImageSource, useNear, type ImageItem, type LoadedImage } from './images.tsx'
export { Lightbox } from './lightbox.tsx'
export { driftNote, MachineDrift } from './machine-drift.tsx'
