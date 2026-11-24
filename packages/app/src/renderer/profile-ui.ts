// A profile's UI, loaded while the app runs. The daemon serves the profile's modules (types stripped, after checking the
// profile is allowed there); here every module its entries need is fetched, then each one's imports are rewritten and
// it is loaded from a blob URL:
//   'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'superego/ui', 'superego/unstable'
//                                         → this window's own copies, so a profile's components share its React
//   './other.ts'                          → that module of the profile, loaded the same way
// Their default exports are UI halves, installed for that profile's threads only (see Registry.installProfile); a global
// profile's (`global: true`, the machine's GLOBAL_PROFILES) as the app's, from the moment the machine says it has it; a
// project's profile's spaces as its project's, from the moment the project is listed (`useListedProfileUis`).
//
// The window runs with the user's full access to every machine, so a machine other than this computer gets no say in
// what runs in it: a remote profile's UI runs only once it is allowed on this computer, for that machine, that profile
// and a hash of exactly the sources the window received (computed here, never the machine's word). Until then the
// thread works without it, and the window offers to allow it (ProfileUiNotice). This computer's own profiles keep their
// daemon's rules: they are on this computer already. Once allowed, it runs in the window's own JavaScript with its full
// reach: a narrower `call` or `dispatch` wouldn't hold, with `window.superego` beside it. Isolating it is a sandbox's job.
// Revoking it takes out what it registered, but not what its code already did (timers, listeners, globals, requests
// under way): the window offers a reload for that (RevokedUiNotice).
import { useEffect, useSyncExternalStore } from 'react'
import type { ProfileInfo, ProfileRef, ThreadInfo } from '@superego/protocol'
import {
  collectProfileUi, filesOf, hashProfileUi, isAllowed, pointImports, resolveSpecifier, type AllowedUi, type ProfileUiSources,
} from '@superego/client/profile-ui'
import { machine as client } from './client.ts'
import { clearProblem, reportProblem } from './machine-problems.ts'
import type { UiExtension } from './extension-api.ts'
import { profileScope, scopeIsOn, useRegistry, type Registry } from './registry.tsx'
import { APP } from '../shared/app-settings.ts'

/** What a profile's modules import by name: built on first use, from this window's own modules. */
let shared: Promise<Map<string, string>> | undefined
function sharedModules() {
  return shared ??= (async () => {
    const [react, jsx, dom, domClient, stable, unstable] = await Promise.all([
      import('react'), import('react/jsx-runtime'), import('react-dom'), import('react-dom/client'), import('./sdk-ui.ts'), import('./sdk-unstable.ts'),
    ])
    const g = globalThis as { __superegoShared?: Record<string, Record<string, unknown>> }
    g.__superegoShared = {
      react: { ...react }, 'react/jsx-runtime': { ...jsx }, 'react-dom': { ...dom }, 'react-dom/client': { ...domClient },
      'superego/ui': { ...stable }, 'superego/unstable': { ...unstable },
    }
    const urls = new Map<string, string>()
    for (const [name, exports] of Object.entries(g.__superegoShared)) {
      const names = Object.keys(exports).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default')
      const source = `const m = globalThis.__superegoShared[${JSON.stringify(name)}];\nexport default m.default ?? m;\n${names.map((key) => `export const ${key} = m.${key};`).join('\n')}\n`
      urls.set(name, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
    }
    return urls
  })()
}

export type LoadUi = (profile: ProfileRef, sources: ProfileUiSources) => Promise<UiExtension[]>

/** Load a profile's UI halves from the sources fetched: each module from a blob URL, its imports pointed at the others'. */
const loadProfileUi: LoadUi = async (profile, sources) => {
  const names = await sharedModules()
  const urls = new Map<string, string>()
  const urlOf = (asked: string, chain: string[] = []): string => {
    const done = urls.get(asked)
    if (done) return done
    if (chain.includes(asked)) throw new Error(`${[...chain, asked].join(' → ')}: a profile's UI modules can't import each other in a cycle`)
    const module = sources.modules.get(asked)!
    const code = pointImports(module, (specifier) => names.get(specifier) ?? urlOf(resolveSpecifier(module.path, specifier), [...chain, asked]))
    const url = URL.createObjectURL(new Blob([`${code}\n//# sourceURL=superego-profile://${profile.scope}/${profile.name}/${module.path}`], { type: 'text/javascript' }))
    urls.set(asked, url)
    return url
  }
  const extensions: UiExtension[] = []
  for (const entry of sources.entries) {
    const module = await import(/* @vite-ignore */ urlOf(entry)) as { default?: UiExtension }
    if (!module.default?.name || typeof module.default.setup !== 'function') throw new Error(`${entry} must export default defineUiExtension({ name, setup })`)
    extensions.push(module.default)
  }
  return extensions
}

// ── Allowed here ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The remote profile UIs this computer allows (the app's ui-allowed.json), and the ones it put off for now
 * (ui-declined.json): kept current as the app says.
 */
let allowed: AllowedUi[] = []
let declined: AllowedUi[] = []
let allowedLoad: Promise<AllowedUi[]> | undefined
function allowedList() {
  return allowedLoad ??= (async () => {
    window.superego.onEvent((event) => {
      if (event.machine !== APP) return
      if (event.method === 'profileUi.allowed') { allowed = event.params as AllowedUi[]; void settle() }
      if (event.method === 'profileUi.declined') { declined = event.params as AllowedUi[]; changed() }
    })
    // A window with no say of its own (superego/testing's) answers none.
    const [yes, no] = await Promise.all([
      window.superego.call(APP, 'profileUi.allowed', {}) as Promise<AllowedUi[] | null>,
      window.superego.call(APP, 'profileUi.declined', {}) as Promise<AllowedUi[] | null>,
    ])
    allowed = yes ?? []
    declined = no ?? []
    changed()
    return allowed
  })()
}

/** The allowed list, in a component: what Settings lists. */
export function useAllowedUi(): AllowedUi[] {
  useEffect(() => { void allowedList().catch((error) => console.error(error)) }, [])
  return useSyncExternalStore(subscribe, () => allowed)
}

/** The ones put off ("Not now"), in a component: Settings lists them too, to allow. */
export function useDeclinedUi(): AllowedUi[] {
  useEffect(() => { void allowedList().catch((error) => console.error(error)) }, [])
  return useSyncExternalStore(subscribe, () => declined)
}

// ── Each profile's UI in this window ────────────────────────────────────────────────────────────────────────────────

/** A profile's UI as this window has it: the daemon's version it last looked at, what it fetched, and whether it runs. */
type Known = {
  registry: Pick<Registry, 'installProfile'>; machine: string; profile: ProfileRef
  /** The daemon's hash of the profile's files: when it changes, the window fetches again. */
  version: string
  sources: ProfileUiSources
  /** This window's hash of `sources`; for this computer's own profiles, none (its daemon decides). */
  hash?: string
  installed: boolean
}

/** The global profiles each machine has (GLOBAL_PROFILES), by `keyOf`: their UI is installed as the app's. */
const globals = new Set<string>()
const known = new Map<string, Known>()
const loading = new Map<string, Promise<void>>()
const keyOf = (machine: string, dir: string) => profileScope(machine, { dir })

const listeners = new Set<() => void>()
let version = 0
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function changed() { version++; for (const listener of listeners) listener() }

/** Put off ("Not now") but asked about again in this window, from the thread's header: per profile UI and hash. */
const reopened = new Set<string>()

let load: LoadUi = loadProfileUi
/** Tests: load sources without a DOM. */
export const setLoader = (next: LoadUi) => { load = next }

async function install(entry: Known) {
  // A module that doesn't load here (a bad import, no extension exported, a throw as it runs) is broken.
  const extensions = entry.sources.entries.length ? await load(entry.profile, entry.sources).catch((error: Error & { kind?: string }) => {
    throw Object.assign(error, { kind: error.kind ?? 'invalid' })
  }) : []
  if (globals.has(keyOf(entry.machine, entry.profile.dir))) entry.registry.installProfile(entry.machine, entry.profile, extensions, { global: true })
  else entry.registry.installProfile(entry.machine, entry.profile, extensions)
  entry.installed = true
  if (revokedRan.delete(keyOf(entry.machine, entry.profile.dir))) revokedList = [...revokedRan.values()]
}

// ── Revoked after it ran ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Remote profile UIs revoked after their code ran in this window. Revoking takes out what they registered (views,
 * panes, actions), but code that ran may have left timers, listeners, globals or requests going that nothing here can
 * undo: only a fresh window clears them. Each is offered a reload until allowed again or dismissed.
 */
export type RevokedUi = { machine: string; profile: ProfileRef }
const revokedRan = new Map<string, RevokedUi>()
let revokedList: RevokedUi[] = []

/** The ones revoked after their code ran here, to offer a reload for. */
export const revokedUi = () => revokedList
export function useRevokedUi(): RevokedUi[] {
  return useSyncExternalStore(subscribe, () => revokedList)
}

/** Not reloading after all: stop offering it for these. */
export function dismissRevokedUi(list: RevokedUi[]) {
  for (const r of list) revokedRan.delete(keyOf(r.machine, r.profile.dir))
  revokedList = [...revokedRan.values()]
  changed()
}

/** Let what runs follow the allowed list: allowed ones that wait start, revoked ones are taken out (see RevokedUi). */
async function settle() {
  for (const entry of known.values()) {
    if (!entry.hash) continue
    const ok = isAllowed(allowed, entry.machine, entry.profile.dir, entry.hash)
    if (ok && !entry.installed) await install(entry).catch((error) => console.error(`The ${entry.profile.name} profile's UI didn't load`, error))
    else if (!ok && entry.installed) {
      entry.registry.installProfile(entry.machine, entry.profile, [])
      entry.installed = false
      revokedRan.set(keyOf(entry.machine, entry.profile.dir), { machine: entry.machine, profile: entry.profile })
      revokedList = [...revokedRan.values()]
    }
  }
  changed()
}

/**
 * Errors that say the profile can't run here (gone, broken, no longer allowed): the window lets go of its UI. Any other
 * (the machine away or restarting, busy with another profile's run, a timeout) may pass, and keeps it.
 */
const GONE = new Set(['not_found', 'invalid', 'profile_not_allowed'])

/**
 * Fetch `profile`'s UI on `machine` when its files changed, and run it if it may: always for this computer's (its daemon
 * checked), for another machine's once allowed here for exactly these sources. Let go of it when the profile can't run
 * there now, or its sources changed from what was allowed.
 */
export async function ensureProfileUi(registry: Pick<Registry, 'installProfile'>, machine: string, profile: ProfileRef) {
  const key = keyOf(machine, profile.dir)
  try {
    const { hash: daemonHash, entries } = await client(machine).call('profile.ui', profile)
    if (known.get(key)?.version === daemonHash) return
    const sources = await collectProfileUi(entries, (path) => client(machine).call('profile.module', { ...profile, path }))
      .catch((error: Error & { kind?: string }) => { throw Object.assign(error, { kind: error.kind ?? 'invalid' }) })
    const entry: Known = { registry, machine, profile, version: daemonHash, sources, installed: false }
    if (machine !== 'local' && entries.length) {
      entry.hash = await hashProfileUi(sources)
      await allowedList()
    }
    const was = known.get(key)
    if (!entry.hash || isAllowed(allowed, machine, profile.dir, entry.hash)) await install(entry)
    else if (was?.installed) registry.installProfile(machine, profile, [])
    // Only once it's in (or waits to be allowed): a load that failed is tried again.
    known.set(key, entry)
    changed()
  } catch (error) {
    const was = known.get(key)
    if (GONE.has((error as { kind?: string }).kind ?? '') && was) {
      known.delete(key)
      if (was.installed) registry.installProfile(machine, profile, [])
      changed()
    }
    throw error
  }
}

/** Profiles whose UI the window was given already (a test's, by `keyOf`): not fetched from their machine. */
const provided = new Set<string>()
/** Tests: `profile` on `machine` is installed by the test itself; the window doesn't load it from the daemon. */
export const provideProfileUi = (machine: string, profile: Pick<ProfileRef, 'dir'>) => { provided.add(keyOf(machine, profile.dir)) }

/** `ensureProfileUi`, unless it's under way for that profile already: one at a time per profile, however many ask. */
function ensureOnce(registry: Pick<Registry, 'installProfile'>, machine: string, profile: ProfileRef, quiet = false) {
  const key = keyOf(machine, profile.dir)
  if (provided.has(key)) return Promise.resolve()
  const under = loading.get(key)
  if (under) return under
  const done = ensureProfileUi(registry, machine, profile)
    .catch((error: Error & { kind?: string }) => {
      if (!quiet || !GONE.has(error.kind ?? '')) console.error(`The ${profile.name} profile's UI didn't load`, error)
    })
    .finally(() => loading.delete(key))
  loading.set(key, done)
  return done
}

/** Load the UI of `thread`'s profile into the registry (once per version of its files), and redraw when it lands. */
export function useProfileUi(machine: string, thread: ThreadInfo) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const profile = thread.profile
  useEffect(() => {
    if (profile) void ensureOnce(registry, machine, profile)
  }, [machine, profile?.dir, thread.activeAt])
}

/**
 * Load the UIs of the profiles of a machine's listed threads (the sidebar's and the navigator's; archived ones aren't
 * listed), so their badges, slots, tool rows and pane kinds are there before any of those threads is shown; and those of
 * the listed projects' own profiles that may run (`profile.list` in each project's folder), whatever profile its
 * threads run, so a project's spaces are there with it. Once per profile, not per thread: asked again only when the set
 * of profiles (or projects) listed changes, the machine connects again, or it allows a project profile (`allowedThere`:
 * its PROFILES_ALLOWED, as it says it).
 * Another machine's profile is fetched only when this computer allowed a UI of it before: one never allowed waits for
 * a thread of it to be shown, which asks (ProfileUiNotice). A profile whose last listed thread goes stays loaded until
 * the window reloads: what it registered shows only on its own threads, so it shows nowhere.
 */
export function useListedProfileUis(machine: string, connected: boolean, threads: ThreadInfo[] | undefined, allowedThere: unknown) {
  const registry = useRegistry()
  const profiles = new Map<string, ProfileRef>()
  for (const thread of threads ?? []) if (thread.profile) profiles.set(thread.profile.dir, thread.profile)
  const dirs = [...profiles.keys()].sort().join('\n')
  useEffect(() => {
    if (connected && profiles.size) void loadListedProfileUis(registry, machine, [...profiles.values()])
  }, [machine, connected, dirs])
  const roots = [...new Set((threads ?? []).map((t) => t.project?.root).filter((root): root is string => Boolean(root)))].sort().join('\n')
  // Asked once the machine says it lists profiles (its actions loaded): a machine that doesn't has none to give.
  useSyncExternalStore(registry.router.onChange, registry.router.version)
  const lists = registry.router.all(machine).some((a) => a.id === 'profile.list')
  // Listed again when the machine allows a project profile (PROFILES_ALLOWED), from a window or its command line.
  const allows = JSON.stringify(allowedThere ?? null)
  useEffect(() => {
    if (!connected || !roots || !lists) return
    let alive = true
    void projectProfiles(registry, machine, roots.split('\n')).then((refs) => { if (alive && refs.length) return loadListedProfileUis(registry, machine, refs) })
    return () => { alive = false }
  }, [machine, connected, roots, lists, allows])
}

/**
 * The profiles of the projects at `roots` on `machine` that may run there (allowed): theirs alone, not the user's a
 * thread there could start with too. A project its machine can't list for is told of (the machine's problems), and
 * left out.
 */
export async function projectProfiles(registry: Pick<Registry, 'router'>, machine: string, roots: string[]): Promise<ProfileRef[]> {
  const what = "Listing its projects' profiles"
  const lists = await Promise.all(roots.map((root) => registry.router.dispatch('profile.list', { cwd: root }, { machine, source: 'profiles' })
    .then((list) => list as ProfileInfo[], (error: unknown) => {
      reportProblem(machine, what, error)
      return undefined
    })))
  if (lists.every(Boolean)) clearProblem(machine, what)
  return lists.flatMap((list) => (list ?? []).filter((p) => p.scope === 'project' && p.allowed)
    .map(({ scope, name, dir, source }): ProfileRef => ({ scope, name, dir, ...(source ? { source } : {}) })))
}

/**
 * Load the UIs of a machine's global profiles (GLOBAL_PROFILES, as it says them now) as the app's, whatever threads
 * there are; and again when the window comes to the front, should their files have changed. One no longer global
 * there is installed again as a profile's (its threads') or let go of.
 */
export function useGlobalProfileUis(machine: string, connected: boolean, refs: ProfileRef[] | null | undefined) {
  const registry = useRegistry()
  const dirs = (refs ?? []).map((r) => r.dir).sort().join('\n')
  useEffect(() => {
    if (!connected || !refs) return
    const now = new Set(refs.map((r) => keyOf(machine, r.dir)))
    for (const key of [...globals]) {
      if (!scopeIsOn(key, machine) || now.has(key)) continue
      globals.delete(key)
      const entry = known.get(key)
      // Its UI as a profile's again (for its threads), from the sources it has.
      if (entry?.installed) void install(entry).catch((error) => console.error(`The ${entry.profile.name} profile's UI didn't load`, error))
    }
    const load = () => {
      for (const ref of refs) {
        const key = keyOf(machine, ref.dir)
        const was = globals.has(key)
        globals.add(key)
        const entry = known.get(key)
        // Installed already as a profile's: as the app's now, from what it has; then as its files are now.
        if (!was && entry?.installed) void install(entry).catch((error) => console.error(`The ${ref.name} profile's UI didn't load`, error))
        void ensureOnce(registry, machine, ref)
      }
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [machine, connected, dirs])
}

/** What `useListedProfileUis` does once the profiles listed change: done when each of them is (or waits to be allowed). */
export async function loadListedProfileUis(registry: Pick<Registry, 'installProfile'>, machine: string, profiles: ProfileRef[]) {
  if (machine !== 'local') await allowedList().catch(() => undefined)
  const remoteAllowed = (dir: string) => allowed.some((a) => a.machine === machine && a.profile.dir === dir)
  await Promise.all(profiles.filter((p) => machine === 'local' || remoteAllowed(p.dir)).map((p) => ensureOnce(registry, machine, p, true)))
}

// ── Waiting for this computer's say ─────────────────────────────────────────────────────────────────────────────────

/** A remote profile's UI not allowed here for what it is now: what it is, and its files as fetched. */
export type PendingUi = {
  machine: string; profile: ProfileRef; hash: string; files: { path: string; size: number }[]
  /**
   * Put off ("Not now") for these sources, on this computer: the thread's header says so quietly instead of asking.
   * Until they change, it is allowed or revoked, or the header's marker asks again.
   */
  declined: boolean
  /** Each file's code, as it would run. */
  code(path: string): string | undefined
}

const pendingKey = (pending: Pick<PendingUi, 'machine' | 'profile' | 'hash'>) => `${keyOf(pending.machine, pending.profile.dir)}:${pending.hash}`

export function pendingUi(machine: string, dir: string): PendingUi | undefined {
  const entry = known.get(keyOf(machine, dir))
  if (!entry?.hash || entry.installed) return undefined
  const modules = [...entry.sources.modules.values()]
  const pending = { machine, profile: entry.profile, hash: entry.hash }
  return {
    ...pending, files: filesOf(entry.sources),
    declined: isAllowed(declined, machine, dir, entry.hash) && !reopened.has(pendingKey(pending)),
    code: (path) => modules.find((m) => m.path === path)?.code,
  }
}

/** The profile UI of `profile` on `machine` waiting to be allowed (or put off: see `declined`). */
export function usePendingUi(machine: string, profile: ProfileRef | undefined): PendingUi | undefined {
  useSyncExternalStore(subscribe, () => version)
  return profile ? pendingUi(machine, profile.dir) : undefined
}

/** A file of a profile's UI as this window fetched it: what would run (or runs). */
export function useProfileSource(machine: string, dir: string, path: string): string | undefined {
  useSyncExternalStore(subscribe, () => version)
  const entry = known.get(keyOf(machine, dir))
  return entry && [...entry.sources.modules.values()].find((m) => m.path === path)?.code
}

/** Not now, said: as the app will tell every window (it keeps it), and no longer asked again in this one. */
export function declineUi(pending: PendingUi) {
  const { machine, profile, hash, files } = pending
  declined = [...declined.filter((d) => !(d.machine === machine && d.profile.dir === profile.dir)), { machine, profile, hash, files, at: Date.now() }]
  reopenUi(pending, false)
}

/** Ask again about a profile UI put off, in this window (the header's marker); or, `false`, stop asking (Not now). */
export function reopenUi(pending: PendingUi, open: boolean) {
  if (open) reopened.add(pendingKey(pending))
  else reopened.delete(pendingKey(pending))
  changed()
}

/** Tests: wait out every load of a profile's UI under way, and any one sets off, so none lands after its window is gone. */
export async function profileUisLoaded() {
  while (loading.size) await Promise.all(loading.values())
}

/** Tests: forget every profile's UI. */
export function resetProfileUi() {
  known.clear(); loading.clear(); globals.clear(); provided.clear(); reopened.clear(); revokedRan.clear(); revokedList = []; allowed = []; declined = []; allowedLoad = undefined; load = loadProfileUi
}
