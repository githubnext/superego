/// <reference path="./env.d.ts" />
// The window's parts a test harness puts together (`superego/testing`'s `mountUi`): not for extensions.
export {
  createRegistry, layoutOf, linkHandler, toolRow, paneKind, placedFor, PlacedViews, RegistryProvider, scopedViews, seenIn, Slot, ViewScopeProvider,
  type BehaviourSlot, type Registry, type SlotProps, type UiExtension, type ViewProps,
} from './extension.tsx'
export { PaneBody } from './panes.tsx'
export { DescribedCall, describeRun, mainKind } from './tool-rows.tsx'
export { ShellStateProvider, useAllThreads, useMachines, useSelection } from './state.tsx'
export { LAYOUT } from '../shared/app-settings.ts'
export type { Layout, Place } from '../shared/layout.ts'
export { bound, normalize } from '../shared/shortcuts.ts'
export { setLocalState } from './local-state.ts'
export { windowRegistry } from './index.tsx'
