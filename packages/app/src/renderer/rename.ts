// The thread whose title is being edited in the title bar, if one is: started by its button or `thread.startRename`.
import { useSyncExternalStore } from 'react'

let renaming: string | undefined
const listeners = new Set<() => void>()
const set = (next: string | undefined) => { renaming = next; for (const listener of listeners) listener() }

export const startRename = (machine: string, thread: string) => set(`${machine}/${thread}`)
export const stopRename = () => set(undefined)
/** `machine/thread`, while its title is being edited. */
export const useRenaming = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => renaming)
