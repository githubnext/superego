// The window's own state, kept across reloads: which thread is selected, a draft not yet sent, how a view was left.
// It lives in the window's storage (the app's, or the browser's for the web app), never on a machine, and is only
// read when a component first shows it. A value back at its initial one is forgotten, so drafts don't pile up.
//
// The desktop app's windows share one storage, so each keeps its own state under its id (the main process passes it in
// the window's address, which a reload keeps): which thread it shows, its sidebar, shown or hidden. State
// every window agrees on (a draft, a notice dismissed) is `shared`. The web app has one window: its state is all one.
import { useCallback, useState, useSyncExternalStore } from 'react'

const PREFIX = 'superego.'

const address = typeof location === 'undefined' ? undefined : new URLSearchParams(location.search)
/** This window's id, in the desktop app. */
const windowId = address?.get('window') || undefined
/** Where this window's own state is kept. */
const OWN = windowId ? `${PREFIX}window.${windowId}.` : PREFIX
/**
 * Whether this is the app's first window: the one opened while no other was (as the app launches, the first one it
 * reopens). Something to show once (onboarding) shows there. The web app's one window is.
 */
export const firstWindow = !windowId || address?.get('first') === '1'

const storageKey = (key: string, shared: boolean) => (shared ? PREFIX : OWN) + key

// A new window starts as a copy of the one it was opened from (`windowState`): taken once, and out of the address so
// a reload doesn't take it again.
if (windowId && address?.has('seed')) {
  try {
    for (const [key, value] of Object.entries(JSON.parse(address.get('seed')!) as Record<string, string>)) localStorage.setItem(OWN + key, value)
  } catch { /* it starts afresh */ }
  address.delete('seed')
  history.replaceState(history.state, '', `${location.pathname}?${address}${location.hash}`)
}

/**
 * State no longer kept, dropped from every window's as one loads: `pane.widths`, the columns' shares of the row that
 * 0.1.10 kept per window (their widths are factors of the window's width now, see panes.tsx).
 */
const RETIRED = ['pane.widths']
if (typeof localStorage !== 'undefined') {
  const retired: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(PREFIX)) continue
    const own = key.startsWith(`${PREFIX}window.`) ? key.slice(`${PREFIX}window.`.length).split('.').slice(1).join('.') : key.slice(PREFIX.length)
    if (RETIRED.includes(own)) retired.push(key)
  }
  for (const key of retired) localStorage.removeItem(key)
}

/** This window's own state, for a new window to start as a copy of it. */
export function windowState(): Record<string, string> {
  const state: Record<string, string> = {}
  if (!windowId) return state
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(OWN)) state[key.slice(OWN.length)] = localStorage.getItem(key)!
  }
  return state
}

/** Drop the state of windows gone for good: every window but `known` (the app's, open or put away to reopen). */
export function forgetWindows(known: string[]) {
  const kept = new Set([windowId, ...known])
  const gone: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    const id = key?.startsWith(`${PREFIX}window.`) ? key.slice(`${PREFIX}window.`.length).split('.')[0] : undefined
    if (id !== undefined && !kept.has(id)) gone.push(key!)
  }
  for (const key of gone) localStorage.removeItem(key)
}

function read<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? initial : JSON.parse(raw) as T
  } catch { return initial }
}

function write<T>(key: string, value: T, initial: T) {
  try {
    if (value === undefined || JSON.stringify(value) === JSON.stringify(initial)) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch { /* storage full or unavailable: it just won't survive a reload */ }
}

/** Kept for this window alone (the default), or `shared` by every window of the app. */
export type LocalStateOptions = { shared?: boolean }

/** Set what `useLocalState(key, initial)` starts with next time a component shows it. */
export const setLocalState = <T,>(key: string, value: T, initial: T, { shared = false }: LocalStateOptions = {}) => write(storageKey(key, shared), value, initial)

/**
 * Like useState, kept in this window under `key` (which may change: a draft per thread, say), or for every window of
 * the app (`shared`). JSON values only.
 */
export function useLocalState<T>(key: string, initial: T, { shared = false }: LocalStateOptions = {}): [T, (next: T | ((previous: T) => T)) => void] {
  const stored = storageKey(key, shared)
  const [state, setState] = useState(() => ({ key: stored, value: read(stored, initial) }))
  let current = state
  if (state.key !== stored) {
    current = { key: stored, value: read(stored, initial) }
    setState(current)
  }
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setState((s) => {
      const previous = s.key === stored ? s.value : read(stored, initial)
      const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next
      write(stored, value, initial)
      return { key: stored, value }
    })
  }, [stored])
  return [current.value, set]
}

/**
 * State an extension keeps in the window, outside any one component: what its actions change and its components show
 * (a dialog open, a tree shown). `persist` keeps it across reloads, for this window or `shared` by all, like
 * `useLocalState`.
 */
export type Store<T> = {
  get(): T
  set(next: T | ((previous: T) => T)): void
  subscribe(listener: () => void): () => void
  /** In a component: the value, redrawn when it changes. */
  use(): T
}

export function createStore<T>(key: string, initial: T, { persist = false, shared = false }: { persist?: boolean } & LocalStateOptions = {}): Store<T> {
  const stored = storageKey(key, shared)
  let value = persist ? read(stored, initial) : initial
  const listeners = new Set<() => void>()
  const store: Store<T> = {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next
      if (persist) write(stored, value, initial)
      for (const listener of listeners) listener()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    use: () => useSyncExternalStore(store.subscribe, store.get),
  }
  return store
}
