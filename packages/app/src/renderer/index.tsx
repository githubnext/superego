/// <reference path="./env.d.ts" />
// @mu/app/ui: the renderer side of an app. `mountApp(config, { extensions })` draws the shell; extensions and an app's
// own components use the hooks and components below.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@mu/ui/styles.css'
import './app.css'
import type { AppConfig } from '@mu/protocol'
import { createRegistry, RegistryProvider, type UiExtension } from './extension.tsx'
import { Providers, WebAccess } from './SettingsView.tsx'
import { Shell } from './Shell.tsx'
import { ShellStateProvider } from './state.tsx'
import { coreActions } from './actions.tsx'
import { webBridge } from './web-bridge.ts'
import { registerBuiltInPanes } from './panes.tsx'

export function mountApp(app: AppConfig, { extensions = [], root = document.getElementById('root')! }: { extensions?: UiExtension[]; root?: HTMLElement } = {}) {
  // In a browser there is no preload: the bridge is a WebSocket to the daemon that served the page.
  if (!window.mu) window.mu = webBridge()
  // The Providers settings section is the core's own custom component.
  const registry = createRegistry(app, extensions, (core) => {
    core.settings('providers', Providers)
    core.settings('web', WebAccess)
    registerBuiltInPanes(core)
    for (const action of coreActions) core.action(action)
  })
  void registry.router.load('app')
  // Declared before anything renders, so a component reading or setting them finds them registered.
  for (const section of registry.appSettings) void window.mu.call('app', 'settings.register', { section }).catch((error) => console.error(error))
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider registry={registry}>
        <ShellStateProvider><Shell /></ShellStateProvider>
      </RegistryProvider>
    </StrictMode>,
  )
}

export {
  defineUiExtension, Slot, useApp, useRegistry,
  type EntryProps, type PaneKind, type PaneProps, type SettingsComponentProps, type SlotName, type SlotProps, type ToolCallProps, type UiApi, type UiExtension,
} from './extension.tsx'
export { useAppSetting } from './client.ts'
export { useDispatch } from './Shell.tsx'
export type { Dispatch } from './actions.tsx'
export { keyLabel, useActions, useKeymap, useShortcut } from './keys.ts'
export { runsBare, type WindowAction, type WindowContext } from './actions.tsx'
export { defineAction } from '@mu/protocol'
export { useAllSessions, useMachines, useSelection, useSessions, useShell, type Selection } from './state.tsx'
export { useComposerClaim, type ComposerClaim } from './SessionView.tsx'
export { Markdown } from './Markdown.tsx'
export { FileEditor, type FileEditorProps, type MarkdownLink } from './file-editor.tsx'
export { livePreview } from './live-markdown.ts'
export { call, has, loadFonts, machine, useSessionView, useSettings, useValue, useWatch } from './client.ts'
export type { MachineEntry } from '../shared.ts'
