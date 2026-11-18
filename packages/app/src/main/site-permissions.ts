// What a page in Preview may use, as the user said: per site (its origin), per permission. Asked in the page's pane
// (web-panes' Preview), answered there by the user alone, never by an agent: a window's click comes over the IPC, and
// no action grants anything (Settings → Site permissions only forgets). Nothing is granted until then.
//
// A page asks in two ways. A request (Notification.requestPermission, getUserMedia) waits for the answer. A check
// (navigator.permissions.query, Notification.permission) can only be told yes or no: Electron has no "not asked yet",
// so an unanswered one is no. That's a dead end for a page that checks before it asks, as Okta FastPass does for its
// loopback port: a check for the local network asks too, and the page is loaded again once allowed, to see it.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { PermissionAsk, SiteAnswer, SitePermission, SitePermissions } from '../shared/bridge.ts'

/** Chromium's local network permissions: the older one for both, and the two it was split into. */
const NETWORK: Record<string, SitePermission[]> = {
  'local-network-access': ['loopback-network', 'local-network'],
  'loopback-network': ['loopback-network'],
  'local-network': ['local-network'],
}

/**
 * What the user is asked for, for Chromium's `permission` (a request's media types, a check's media type): undefined
 * for one they're never asked about (the page is refused it). A camera and microphone request asks for both at once.
 */
export function asked(permission: string, media?: readonly string[]): SitePermission[] | undefined {
  if (permission === 'notifications') return ['notifications']
  if (NETWORK[permission]) return NETWORK[permission]
  if (permission !== 'media') return undefined
  const kinds: SitePermission[] = []
  if (!media || media.includes('video') || media.includes('unknown')) kinds.push('camera')
  if (!media || media.includes('audio') || media.includes('unknown')) kinds.push('microphone')
  return kinds
}

/** Whether a check of `permission` asks the user too (see the top): the local network's alone. */
export const checkAsks = (permission: string) => Boolean(NETWORK[permission])

/** A site as permissions know it: its origin, for a web page; none for any other (`data:`, a file, an opaque origin). */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const { origin, protocol } = new URL(url)
    return (protocol === 'http:' || protocol === 'https:') && origin !== 'null' ? origin : undefined
  } catch { return undefined }
}

/** Where answers are kept between launches. */
export type AnswerStore = { load(): SitePermissions; save(answers: SitePermissions): void }

/**
 * Answers kept in a JSON file. One that can't be read is said (`problem`) and starts empty, and isn't written over until
 * something's answered.
 */
export function fileStore(path: string): AnswerStore & { problem?: string } {
  const store: AnswerStore & { problem?: string } = {
    load() {
      try {
        const read = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (read && typeof read === 'object' && !Array.isArray(read)) return read as SitePermissions
        throw new Error('not an object')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        store.problem = `${path} couldn't be read: ${(error as Error).message}`
        console.error(store.problem)
        return {}
      }
    },
    save(answers) {
      writeFileSync(`${path}.tmp`, `${JSON.stringify(answers, null, 2)}\n`)
      renameSync(`${path}.tmp`, path)
      store.problem = undefined
    },
  }
  return store
}

/** Something waiting for the user's answer: a request (`done` hears it), or a check (`done` hears only a yes). */
type Pending = PermissionAsk & { done: ((granted: boolean) => void)[]; check: boolean }

export type SitePermissionsOptions<V> = {
  store: AnswerStore
  /** What `view` asks the user now (none: nothing), as that changes. */
  asking(view: V, ask: PermissionAsk | undefined): void
  /** The answers changed (Settings shows them). */
  changed?(): void
}

/**
 * Preview's permissions: the answers, and what each view waits on. A view asks one thing at a time (`asking`), the
 * first it asked; another view's ask for the same is answered with it.
 */
export function createSitePermissions<V>({ store, asking, changed }: SitePermissionsOptions<V>) {
  let answers = store.load()
  const waiting = new Map<V, Pending[]>()

  const answerOf = (origin: string, kind: SitePermission): SiteAnswer | undefined => answers[origin]?.[kind]
  /** Granted if every kind is, denied if any is, else the ones not answered yet. */
  function decide(origin: string, kinds: SitePermission[]): 'granted' | 'denied' | SitePermission[] {
    if (kinds.some((kind) => answerOf(origin, kind) === 'denied')) return 'denied'
    const open = kinds.filter((kind) => answerOf(origin, kind) !== 'granted')
    return open.length ? open : 'granted'
  }
  const same = (a: PermissionAsk, b: PermissionAsk) => a.origin === b.origin && a.kinds.join() === b.kinds.join()
  const head = (view: V): PermissionAsk | undefined => {
    const first = waiting.get(view)?.[0]
    return first && { origin: first.origin, kinds: first.kinds }
  }

  function wait(view: V, ask: PermissionAsk, done: ((granted: boolean) => void) | undefined, check: boolean) {
    const queue = waiting.get(view) ?? []
    const found = queue.find((p) => same(p, ask))
    if (found) {
      // Checked again: it's still the one ask, loading the page once.
      if (done && !check) found.done.push(done)
      found.check &&= check
    } else queue.push({ ...ask, done: done ? [done] : [], check })
    waiting.set(view, queue)
    if (queue.length === 1 && !found) asking(view, head(view))
  }

  /** Settle what's waiting that the answers now decide, in every view; the views whose first ask that changed are told. */
  function settle() {
    for (const [view, queue] of waiting) {
      const before = queue[0]
      const left = queue.filter((pending) => {
        const decided = decide(pending.origin, pending.kinds)
        if (Array.isArray(decided)) return true
        for (const done of pending.done) done(decided === 'granted')
        return false
      })
      if (left.length) waiting.set(view, left)
      else waiting.delete(view)
      if (left[0] !== before) asking(view, head(view))
    }
  }

  function record(origin: string, kinds: SitePermission[], answer: SiteAnswer) {
    answers = { ...answers, [origin]: { ...answers[origin], ...Object.fromEntries(kinds.map((kind) => [kind, answer])) } }
    store.save(answers)
    changed?.()
  }

  return {
    /** A page in `view` asks for `kinds`: answered now if the user has, else once they do (`done`). */
    request(view: V, origin: string, kinds: SitePermission[], done: (granted: boolean) => void) {
      const decided = decide(origin, kinds)
      if (!Array.isArray(decided)) return done(decided === 'granted')
      wait(view, { origin, kinds: decided }, done, false)
    },
    /**
     * Whether `origin` has every one of `kinds`. With a `view` (a check that asks, see the top), one not answered yet
     * is asked for, and `allowed` hears the user allow it.
     */
    check(origin: string, kinds: SitePermission[], ask?: { view: V; allowed(): void }): boolean {
      const decided = decide(origin, kinds)
      if (Array.isArray(decided) && ask) wait(ask.view, { origin, kinds: decided }, (granted) => { if (granted) ask.allowed() }, true)
      return decided === 'granted'
    },
    /** The user's answer to what `view` asks now: kept for its site, and everything waiting on it settled. */
    answer(view: V, allow: boolean) {
      const first = waiting.get(view)?.[0]
      if (!first) return
      record(first.origin, first.kinds, allow ? 'granted' : 'denied')
      settle()
    },
    /**
     * `view` goes (`all`), or its page does: what it asked is refused, unanswered, but a check's ask is kept for the
     * next page, which loads anew once it's allowed.
     */
    drop(view: V, all: boolean) {
      const queue = waiting.get(view)
      if (!queue) return
      const before = queue[0]
      const left = queue.filter((pending) => {
        if (pending.check && !all) return true
        for (const done of pending.done) done(false)
        return false
      })
      if (left.length) waiting.set(view, left)
      else waiting.delete(view)
      if (!all && left[0] !== before) asking(view, head(view))
    },
    /** What `view` asks now. */
    asking: head,
    /** Every site's answers. */
    list: (): SitePermissions => answers,
    /** Forget what was said for `origin`: it's asked again. */
    forget(origin: string) {
      if (!answers[origin]) return
      const { [origin]: _gone, ...rest } = answers
      answers = rest
      store.save(answers)
      changed?.()
    },
  }
}

export type SitePermissionsHandle<V> = ReturnType<typeof createSitePermissions<V>>
