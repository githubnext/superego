// The hooks over shortcuts.ts: the user's keymap and what runs on which keys now.
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ActionInfo } from '@superego/protocol'
import { useAppSetting } from './client.ts'
import { useRegistry } from './extension.tsx'
import { bound, KEYMAP, keyLabel, type Keymap } from './shortcuts.ts'
import { tabAction } from './rail-tabs.ts'

export * from './shortcuts.ts'

/** Every action this window can dispatch (with `machine`'s), kept current as machines connect. */
export function useActions(machine?: string): ActionInfo[] {
  const { router } = useRegistry()
  useSyncExternalStore(router.onChange, router.version)
  return router.all(machine)
}

/** The user's keymap, kept in the app's settings. */
export const useKeymap = () => useAppSetting<Keymap>(KEYMAP)

/** The label of the shortcut that runs `id` now, for hints in menus and buttons; undefined when it has none. */
export function useShortcut(id: string): string | undefined {
  const action = useActions().find((a) => a.id === id)
  const [keymap] = useKeymap()
  const keys = action && bound(action, keymap)
  return keys ? keyLabel(keys) : undefined
}

/** The rail's tab drawn inside, by its number (from 1): the shell says, around each tab's button. */
export const RailTabNumber = createContext<number | undefined>(undefined)

/** In the rail: the label of the shortcut that goes to this tab (⌘1…), for its tooltip; undefined without one. */
export function useRailShortcut(): string | undefined {
  const n = useContext(RailTabNumber)
  return useShortcut(n ? tabAction(n) : '')
}
