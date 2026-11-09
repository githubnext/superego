// The window's own state, kept across reloads: which session is selected, a draft not yet sent, how a view was left.
// It lives in this window's storage (the app's, or the browser's for the web app), never on a machine, and is only
// read when a component first shows it. A value back at its initial one is forgotten, so drafts don't pile up.
import { useCallback, useState } from 'react'

const PREFIX = 'mu.'

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

/** Like useState, kept in this window under `key` (which may change: a draft per session, say). JSON values only. */
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
