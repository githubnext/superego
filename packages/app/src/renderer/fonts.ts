// The families of the fonts installed here, for the font pickers. Chromium's Local Font Access API reads every font on
// the machine for them (2,000-odd on a Mac), which takes many seconds, so the list is kept: in memory for the session,
// and in this window's storage, drawn from at once on the next launch. Where access is already granted it's read again
// in the background once per session, soon after the window settles, and the list updates if it changed. Where it
// isn't, nothing asks in the background: the picker asks when it opens (a user gesture), as before.

type LocalFont = { family: string }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

export type FontSource = {
  /** `window.queryLocalFonts`, looked up when it's needed (smoke replaces it once the page has loaded). */
  query(): (() => Promise<LocalFont[]>) | undefined
  /** Whether the page may read the fonts without asking: the Permissions API's answer, or undefined where it has none. */
  permission(): Promise<PermissionState | undefined>
  storage: Storage | undefined
}

const KEY = 'superego.fonts'
type Saved = { families: string[]; at: number }

export type FontList = {
  /** The families known so far (from the last launch, until this session's read is done), sorted. */
  get(): string[] | undefined
  subscribe(listener: () => void): () => void
  /** Read the fonts (once a session; again after a failure). Called from a user gesture, it may ask for access. */
  load(): Promise<string[]>
  /** Read them now if access is already granted, never asking; a no-op once read, or while reading. */
  refresh(): Promise<void>
}

export function createFontList(source: FontSource, now = Date.now): FontList {
  let families = restore(source.storage)
  let loading: Promise<string[]> | undefined
  const listeners = new Set<() => void>()

  const list: FontList = {
    get: () => families,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load() {
      const query = source.query()
      if (!query) return Promise.reject(new Error('This build cannot list fonts'))
      loading ??= query().then((fonts) => {
        const read = [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b))
        try { source.storage?.setItem(KEY, JSON.stringify({ families: read, at: now() } satisfies Saved)) } catch { /* full: next launch reads them again */ }
        if (!same(read, families)) {
          families = read
          for (const listener of listeners) listener()
        }
        return read
      })
      loading.catch(() => { loading = undefined })
      return loading
    },
    async refresh() {
      if (loading || !source.query()) return
      if (await source.permission().catch(() => undefined) !== 'granted') return
      await list.load().catch(() => {})
    },
  }
  return list
}

function restore(storage: Storage | undefined): string[] | undefined {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null') as Saved | null
    return Array.isArray(saved?.families) ? saved.families : undefined
  } catch { return undefined }
}

const same = (a: string[], b: string[] | undefined) => a.length === b?.length && a.every((family, i) => family === b[i])

/** This window's list. */
export const fonts = createFontList({
  query() {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts
    return query && (() => query.call(window))
  },
  async permission() {
    if (!navigator.permissions?.query) return undefined
    return (await navigator.permissions.query({ name: 'local-fonts' as PermissionName })).state
  },
  // The window's (not Node's own, under the tests).
  storage: typeof window === 'undefined' ? undefined : window.localStorage,
})

/** Read the fonts in the background, once the window has settled after starting (a few seconds, then an idle moment). */
export function refreshFontsSoon(delay = 3000): () => void {
  let idle: number | undefined
  const timer = setTimeout(() => {
    const go = () => void fonts.refresh()
    idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(go, { timeout: 10_000 }) : (go(), undefined)
  }, delay)
  return () => {
    clearTimeout(timer)
    if (idle !== undefined) cancelIdleCallback(idle)
  }
}
