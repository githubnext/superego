/// <reference path="./env.d.ts" />
// The window's parts a test harness puts together (`superego/testing`'s `mountUi`): not for extensions.
export { createRegistry, layoutOf, placedFor, PlacedViews, RegistryProvider, scopedViews, ViewScopeProvider, type Registry, type UiExtension, type ViewProps } from './extension.tsx'
export { ShellStateProvider, useAllThreads, useMachines, useSelection } from './state.tsx'
export { LAYOUT, type Layout, type Place } from './layout.ts'
export { bound, normalize } from './shortcuts.ts'
export { setLocalState } from './local-state.ts'
export { windowRegistry } from './index.tsx'
