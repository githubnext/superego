/// <reference path="./env.d.ts" />
// The window's parts a test harness puts together (`superego/testing`'s `mountUi`): not for extensions.
export {
  createRegistry, layoutOf, paneKind, placedFor, PlacedViews, RegistryProvider, scopedViews, seenIn, Slot, ViewScopeProvider,
  type BehaviourSlot, type Registry, type SlotProps, type UiExtension, type ViewProps,
} from './extension.tsx'
export { PaneBody } from './panes.tsx'
export { ShellStateProvider, useAllThreads, useMachines, useSelection } from './state.tsx'
export { LAYOUT, type Layout, type Place } from './layout.ts'
export { bound, normalize } from './shortcuts.ts'
export { setLocalState } from './local-state.ts'
export { windowRegistry } from './index.tsx'
