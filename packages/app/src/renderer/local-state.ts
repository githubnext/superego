// The window's own state, kept across reloads: which thread is selected, a draft not yet sent, how a view was left.
// It lives in this window's storage (the app's, or the browser's for the web app), never on a machine, and is only
// read when a component first shows it. A value back at its initial one is forgotten, so drafts don't pile up.
import { useCallback, useState, useSyncExternalStore } from 'react'

const PREFIX = 'superego.'

function read<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? initial : JSON.parse(raw) as T
  } catch { return initial }
}

function write<T>(key: string, value: T, initial: T) {
  try {
    if (value === undefined || JSON.stringify(value) === JSON.stringify(initial)) localStorage.removeItem(PREFIX + key)
    else localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch { /* storage full or unavailable: it just won't survive a reload */ }
}

/** Set what `useLocalState(key, initial)` starts with next time a component shows it. */
export const setLocalState = <T,>(key: string, value: T, initial: T) => write(key, value, initial)

/** Like useState, kept in this window under `key` (which may change: a draft per thread, say). JSON values only. */
export function useLocalState<T>(key: string, initial: T): [T, (next: T | ((previous: T) => T)) => void] {
  const [state, setState] = useState(() => ({ key, value: read(key, initial) }))
  let current = state
  if (state.key !== key) {
    current = { key, value: read(key, initial) }
    setState(current)
  }
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setState((s) => {
      const previous = s.key === key ? s.value : read(key, initial)
      const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next
      write(key, value, initial)
      return { key, value }
    })
  }, [key])
  return [current.value, set]
}

/**
 * State an extension keeps in the window, outside any one component: what its actions change and its components show
 * (a dialog open, a tree shown). `persist` keeps it across reloads, in this window's storage like `useLocalState`.
 */
export type Store<T> = {
  get(): T
  set(next: T | ((previous: T) => T)): void
  subscribe(listener: () => void): () => void
  /** In a component: the value, redrawn when it changes. */
  use(): T
}

export function createStore<T>(key: string, initial: T, { persist = false }: { persist?: boolean } = {}): Store<T> {
  let value = persist ? read(key, initial) : initial
  const listeners = new Set<() => void>()
  const store: Store<T> = {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next
      if (persist) write(key, value, initial)
      for (const listener of listeners) listener()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    use: () => useSyncExternalStore(store.subscribe, store.get),
  }
  return store
}
