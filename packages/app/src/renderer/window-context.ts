// The window context its actions run with (actions.tsx's `WindowContext`), set in one place for every window that
// draws one: the app's shell, and a test's (`superego/testing`'s `mountUi`).
import type { WindowContext } from './actions.tsx'
import { spaceFor } from './lookups.ts'
import { useRegistry } from './registry.tsx'
import { useMachines, useSelection, useSpace } from './state.tsx'

/** What only the window's shell gives its actions: its dialogs, sidebar, history and rail, and the threads it shows. */
export type ShellContext = Omit<WindowContext, keyof ReturnType<typeof useStateContext> | 'dispatch'>

/**
 * Set the window's actions' context as it renders: what the shell's state has (`useStateContext`), and `shell`, the
 * rest.
 */
export function useWindowContext(shell: ShellContext): void {
  const registry = useRegistry()
  registry.router.setContext({ ...useStateContext(), ...shell })
}

/** The app, machines, selection and space as the shell's state has them, and the spaces registered. */
function useStateContext() {
  const registry = useRegistry()
  const machines = useMachines()
  const { selection, select } = useSelection()
  const { space, open: openSpace, docked, redock } = useSpace()
  return {
    app: registry.app, machines, selection, select, space, openSpace, docked, redock,
    hasSpace: (kind: string, at?: { machine?: string; project?: string }) => Boolean(spaceFor(registry, { kind, ...at })),
  }
}

/** A window without the shell (a test's): no dialogs, sidebar, history or rail, and no thread or app setting known. */
export const NO_SHELL: ShellContext = {
  openSettings() {}, newThread() {}, togglePalette() {}, toggleNavigator() {}, togglePanePicker() {}, showLog() {}, toggleInspect() {},
  threadOf: () => undefined, projects: [], sidebar: { pinned: [], projects: [], folded: [] }, lastThread: {}, fold() {},
  appSetting: () => undefined, toggleSidebar() {}, focusSidebar(id) { throw new Error(`${id} isn't a sidebar in this window`) }, back() {}, forward() {}, railTabs: () => [],
}
