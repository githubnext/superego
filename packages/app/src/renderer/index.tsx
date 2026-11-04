/// <reference path="./env.d.ts" />
// @mu/app/ui: the renderer side of an app. `mountApp(config, { extensions })` draws the shell; extensions and an app's
// own components use the hooks and components below.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@mu/ui/styles.css'
import './app.css'
import type { AppConfig } from '@mu/protocol'
import { createRegistry, RegistryProvider, type UiExtension } from './extension.tsx'
import { Providers } from './SettingsView.tsx'
import { Shell } from './Shell.tsx'
import { ShellStateProvider } from './state.tsx'

export function mountApp(app: AppConfig, { extensions = [], root = document.getElementById('root')! }: { extensions?: UiExtension[]; root?: HTMLElement } = {}) {
  // The Providers settings section is the core's own custom component.
  const registry = createRegistry(app, extensions, (core) => core.settings('providers', Providers))
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
  type Command, type EntryProps, type SettingsComponentProps, type SlotName, type SlotProps, type ToolCallProps, type UiApi, type UiExtension,
} from './extension.tsx'
export { useAllSessions, useMachines, useSelection, useSessions, useShell, type Selection } from './state.tsx'
export { useComposerClaim, type ComposerClaim } from './SessionView.tsx'
export { call, has, loadFonts, machine, useSessionView, useSettings, useValue, useWatch } from './client.ts'
export type { MachineEntry } from '../shared.ts'
