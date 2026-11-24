// The profile host: the profiles loaded here, by folder, each as its files are now. A profile's daemon halves are set up
// through the extension host, once however many profiles have them; its agent parts are installed once by name. A
// profile that changes is loaded again (not under a thread running it); one that's gone or broken lets go of all of it.
// Also the `profile.*` actions, the window's reads of a profile's UI, and Settings → Profiles.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Extension } from '@earendil-works/pi-durable'
import { bool, GLOBAL_PROFILES, Lifetime, obj, opt, RpcError, str, type Json, type ProfileRef as Ref } from '@superego/protocol'
import { describeProfile } from './extension-settings.ts'
import type { ExtensionHost } from './extension-host.ts'
import { defineAction } from './extension.ts'
import type { Host, ThreadMeta } from './host.ts'
import {
  allUserProfiles, broughtBy, findProfile, hashProfile, isGlobal, isProfileDir, listProfiles, loadProfile, profileModule, shadowing, type LoadedProfile, type ProfileDaemonExtension,
  type ProfileRef,
} from './profiles.ts'
import type { Threads } from './threads.ts'

/**
 * A profile's daemon half, set up once however many profiles have it (by its file at one version, `key`: see
 * ProfileDaemonExtension), and torn down when the last of them lets it go. `profiles`: their folders, whose threads
 * its pane kinds are for; `parts`: the agent parts it gave, which each of them selects.
 */
type Shared = { key: string; file: string; profiles: Set<string>; parts: Extension[]; teardown: () => Promise<void> }

/** Just a profile's ref, of anything carrying one (a loaded profile, a method's params). */
const refOf = ({ scope, name, dir, source }: ProfileRef): ProfileRef => ({ scope, name, dir, ...(source ? { source } : {}) })

export function createProfileHost(host: Host, extensions: ExtensionHost, later: { threads(): Threads }) {
  const { registry, mounted, changed, profileSources, allowances, profileKeys, settings, router, folderOf } = host
  /** The profiles loaded, by folder. */
  const profiles = new Map<string, LoadedProfile>()
  /** Profiles that failed to load, and why: until they load. */
  const profileErrors = new Map<string, { ref: ProfileRef; error: string }>()
  const shared = new Map<string, Shared>()
  /** What each loaded profile set up or shares, and how to let go of all of it. */
  const holds = new Map<string, { uses: Shared[]; release: () => void }>()
  /** Profiles' agent parts, installed once by name however many profiles have them, and uninstalled after the last. */
  const installs = new Map<string, number>()
  const install = (part: Extension) => {
    installs.set(part.name, (installs.get(part.name) ?? 0) + 1)
    registry.install(part)
    return () => {
      const left = installs.get(part.name)! - 1
      if (left) return void installs.set(part.name, left)
      installs.delete(part.name)
      registry.uninstall(part)
    }
  }
  /**
   * Profile `ref`'s use of a daemon half: the one set up already for another profile, else set up now. It's the user's
   * own (its `window` views may be sidebars) when it's in one of their profiles' folders (a project's profile extending one
   * of theirs shares it as theirs), or set up for a profile of theirs; never a project profile's own file.
   */
  async function share(item: ProfileDaemonExtension, ref: ProfileRef) {
    const dir = ref.dir
    let entry = shared.get(item.key)
    if (!entry) {
      const made: Shared = { key: item.key, file: item.file, profiles: new Set(), parts: [], teardown: async () => {} }
      made.teardown = await extensions.setUp(item.extension, (part, always) => {
        let named = { ...part, name: `${item.prefix}/${part.name}` }
        const uninstall = install(named)
        if (always) made.parts.push(named)
        return {
          installed: named,
          undo: () => { if (always) made.parts.splice(made.parts.indexOf(named), 1); uninstall() },
          replace(next) {
            const renamed = { ...next, name: named.name }
            registry.install(renamed)
            if (always) made.parts[made.parts.indexOf(named)] = renamed
            return named = renamed
          },
        }
      }, made.profiles, { source: 'profile', file: item.file, scope: ref.scope === 'user' || item.prefix.startsWith('user:') ? 'user' : 'project' })
      shared.set(item.key, entry = made)
    }
    const used = entry
    used.profiles.add(dir)
    extensions.publishViews()
    return {
      entry: used,
      release() {
        used.profiles.delete(dir)
        extensions.publishViews()
        if (used.profiles.size) return
        shared.delete(used.key)
        return used.teardown()
      },
    }
  }
  /** A profile's agent parts: its own, and those its daemon halves give. */
  const partsOf = (profile: LoadedProfile) => [...profile.extensions, ...(holds.get(profile.dir)?.uses.flatMap((use) => use.parts) ?? [])]
  /** Whether a profile is still as it was loaded: its files, and those of the one it extends, unchanged. */
  const current = async (profile: LoadedProfile) =>
    (await Promise.all(Object.entries(profile.versions).map(([dir, hash]) => hashProfile(dir).then((now) => now === hash, () => false)))).every(Boolean)
  /** Whether a thread of one of these profiles is mid-run: its profile isn't loaded again under it. */
  const running = (dirs: Set<string>) => [...mounted.values()].some((m) => m.live?.run && m.meta.profile && dirs.has(m.meta.profile.dir))
  /** Let go of everything a profile set up: what it shares stays for the other profiles that have it. */
  function unload(dir: string) {
    holds.get(dir)?.release()
    holds.delete(dir)
    if (profiles.delete(dir)) changed()
    publishGlobals()
  }
  // The global profiles loaded now, for the window (GLOBAL_PROFILES).
  const setGlobals = host.values.core(GLOBAL_PROFILES, [] as Ref[])
  let globalsNow = '[]'
  function publishGlobals() {
    const now = [...profiles.values()].filter((p) => p.spec.global).map(refOf).sort((a, b) => a.dir.localeCompare(b.dir))
    if (JSON.stringify(now) === globalsNow) return
    globalsNow = JSON.stringify(now)
    setGlobals(now as unknown as Json)
  }
  /** Profile loads, one at a time: two never set up the same extension at once, nor an older version last. */
  let loads: Promise<unknown> = Promise.resolve()
  /**
   * A profile as its files are now: loaded again (its extensions torn down and set up again) when they changed, and
   * nothing of it left set up when it's gone, no longer allowed, or broken. Not under a run, though: a thread mid-run
   * keeps the profile it started with, and the change is loaded for its next turn.
   */
  async function profileOf(ref: ProfileRef): Promise<LoadedProfile> {
    const cached = profiles.get(ref.dir)
    if (cached && await current(cached)) return cached
    const next = loads.then(() => reload(ref))
    loads = next.catch(() => {})
    return next
  }
  async function reload(ref: ProfileRef): Promise<LoadedProfile> {
    const cached = profiles.get(ref.dir)
    if (cached && (await current(cached) || running(new Set([ref.dir])))) return cached
    let loaded: LoadedProfile
    try {
      if (!existsSync(join(ref.dir, 'profile.ts'))) throw new RpcError('not_found', `No profile ${ref.name} at ${ref.dir}`)
      // Its modules may hang as they load (a top-level await): given up on in time, so the profiles behind it load.
      let timer: ReturnType<typeof setTimeout> | undefined
      loaded = await Promise.race([
        loadProfile(ref, profileSources.roots(), allowances, profileKeys),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RpcError('invalid', `Profile ${ref.name} didn't load in ${host.inTime}: one of its modules hangs as it loads`)), host.setupTimeout) }),
      ]).finally(() => clearTimeout(timer))
    } catch (error) {
      unload(ref.dir)
      profileErrors.set(ref.dir, { ref, error: (error as Error).message })
      throw error
    }
    // Another version of a file it has, set up for other profiles too: they let go of it, and load this one next time.
    const others = new Set([...shared.values()]
      .filter((use) => loaded.daemon.some((d) => d.file === use.file && d.key !== use.key))
      .flatMap((use) => [...use.profiles]).filter((dir) => dir !== ref.dir))
    if (running(others)) {
      if (cached) return cached
      throw new RpcError('busy', `Profile ${ref.name} has an extension a running thread has another version of`, { hint: 'Try again once it finishes.' })
    }
    unload(ref.dir)
    for (const dir of others) unload(dir)
    // Everything it sets up is undone together, each step tried whatever the others do: when a later step fails too, so
    // a fixed profile can load again.
    const uses: Shared[] = []
    const life = new Lifetime(`Profile ${ref.name}`)
    const release = () => { life.dispose() }
    try {
      for (const item of loaded.daemon) {
        const { entry, release } = await share(item, ref)
        uses.push(entry)
        life.add(release)
      }
      for (const extension of loaded.extensions) life.add(install(extension))
    } catch (error) {
      release()
      profileErrors.set(ref.dir, { ref, error: (error as Error).message })
      throw new RpcError('invalid', `Profile ${ref.name}: ${(error as Error).message}`)
    }
    holds.set(ref.dir, { uses, release })
    profiles.set(ref.dir, loaded)
    publishGlobals()
    profileErrors.delete(ref.dir)
    // What its threads go without may have changed with it.
    changed()
    for (const name of loaded.spec.without ?? []) {
      const known = extensions.known(name)
      if (!known) loaded.problems.push(`without: ${name} isn't an extension here`)
      else if (known.required) loaded.problems.push(`without: ${name} is required, and can't be done without`)
    }
    return loaded
  }

  /**
   * Load the user's global profiles (`global: true`): theirs, not shadowed, each loaded whatever threads there are, so
   * their daemon halves run from the start and the window can install their UI. One that fails says why and is skipped.
   */
  function loadGlobals() {
    return (async () => {
      const roots = profileSources.roots()
      const shadowed = shadowing(roots)
      for (const ref of allUserProfiles(roots)) {
        if (shadowed.get(ref.dir)?.some((p) => p.startsWith('Shadowed'))) continue
        try {
          if (await isGlobal(ref)) await profileOf(ref)
        } catch (error) {
          console.error(`Profile ${ref.name}: ${(error as Error).message}`)
        }
      }
    })()
  }

  router.register(defineAction({
    id: 'profile.list', title: 'List profiles', expose: ['ui', 'cli', 'outside'],
    description: 'The profiles a thread in `cwd` could start with (thread.start\'s `profile`), and whether each may run. `user`: the user\'s own only, whatever the folder: those a project\'s replaces too, and those shadowed by another of theirs (their `problems` say so), the one used first.',
    params: obj({ cwd: opt(str()), user: opt(bool()) }),
    async run({ cwd, user }) {
      const dir = folderOf(cwd)
      const roots = profileSources.roots()
      const shadows = shadowing(roots)
      return Promise.all((user ? allUserProfiles(roots) : listProfiles(dir, roots)).map(async (ref) => {
        const loaded = profiles.get(ref.dir)
        const description = loaded?.spec.description
        // One whose imports can't be told can't be allowed as it is: loading it says why.
        const allowed = await Promise.resolve().then(async () => allowances.allowed(ref, await hashProfile(ref.dir))).catch(() => false)
        const brought = loaded ? broughtBy(loaded, profileKeys) : {}
        const problems = [...shadows.get(ref.dir) ?? [], ...brought.problems ?? []]
        return { ...ref, ...(description ? { description } : {}), allowed, ...(loaded?.spec.global ? { global: true } : {}), ...brought, ...(problems.length ? { problems } : {}) }
      }))
    },
  }))
  router.register(defineAction({
    id: 'profile.allow', title: 'Allow a project profile to run', expose: ['ui', 'cli'], consent: true,
    params: obj({ cwd: opt(str()), name: opt(str()) }),
    async run({ cwd, name }) {
      const dir = folderOf(cwd)
      const ref = findProfile(dir, profileSources.roots(), name?.trim() || undefined)
      if (!ref) throw new RpcError('not_found', `No profile in ${dir}`)
      return { ...ref, hash: await allowances.allow(ref) }
    },
  }))
  router.register(defineAction({
    id: 'profile.reload', title: 'Load a profile again', expose: ['ui', 'cli'],
    params: obj({ cwd: opt(str()), name: opt(str()) }),
    // What changed in its files loads now, as its next turn would load it (not under a thread that's running it); its
    // extensions torn down and set up again. Fails with why it doesn't load.
    async run({ cwd, name }) {
      const dir = folderOf(cwd)
      const ref = findProfile(dir, profileSources.roots(), name?.trim() || undefined)
      if (!ref) throw new RpcError('not_found', `No profile ${name ?? ''} in ${dir}`.replace('  ', ' '))
      await profileOf(ref)
      return ref
    },
  }))
  /** Sources changed: what profiles there are may have, and the window's list of them. */
  const sourcesChanged = () => { settings.invalidate(); changed() }
  router.register(defineAction({
    id: 'profile.sources', title: 'List profile sources', expose: ['ui', 'cli'],
    description: 'Where your own profiles come from beyond ~/.superego/profiles: each source (a git repo or a folder), its state, and its profiles.',
    params: obj({}),
    async run() {
      const problem = profileSources.problem()
      if (problem) throw new RpcError('invalid', `Profile sources: ${problem}`, { hint: 'Fix the file (or remove it), then try again.' })
      return profileSources.describe()
    },
  }))
  router.register(defineAction({
    id: 'profile.install', title: 'Install a profile source', expose: ['ui', 'cli'], consent: true,
    description: 'Add a source of your own profiles, and clone it if it\'s a git repo: `git:<host>/<owner>/<repo>[@ref]`, or a folder (`~/…` or absolute). Its profiles run as yours: installing it is trusting its code. Again, nothing changes.',
    params: obj({ source: str() }),
    async run({ source }) {
      const installed = await profileSources.install(source)
      if (installed.changed) sourcesChanged()
      return installed
    },
  }))
  router.register(defineAction({
    id: 'profile.remove', title: 'Remove a profile source', expose: ['ui', 'cli'],
    description: 'Drop a profile source; a git one\'s clone is deleted.',
    params: obj({ source: str() }),
    async run({ source }) {
      const removed = await profileSources.remove(source)
      sourcesChanged()
      return removed
    },
  }))
  router.register(defineAction({
    id: 'profile.update', title: 'Update profile sources', expose: ['ui', 'cli'],
    description: 'Pull the git profile sources (`git pull --ff-only`), or the one named; clone one that isn\'t yet. Pinned ones (`@ref`) and folders stay as they are. Their profiles load again as their next turn would.',
    params: obj({ source: opt(str()) }),
    async run({ source }) {
      const results = await profileSources.update(source?.trim() || undefined)
      if (results.some((r) => r.result === 'updated' || r.result === 'cloned')) sourcesChanged()
      return results
    },
  }))
  // The profiles threads here can start with: the user's, and those of the projects that have threads.
  settings.register({
    id: 'profiles', title: 'Profiles', order: 75, ui: 'profiles', settings: [],
    description: 'Your own, and those of the projects you have threads in.',
    data: async () => {
      const found = new Map<string, ProfileRef>()
      const roots = profileSources.roots()
      for (const folder of new Set([host.defaultCwd, ...(await later.threads().list()).map((t) => t.project.root)])) {
        for (const ref of listProfiles(folder, roots)) found.set(ref.dir, ref)
      }
      const shadows = shadowing(roots)
      return Promise.all([...found.values()].map((ref) => describeProfile(ref, roots, allowances, profileKeys, shadows.get(ref.dir))))
    },
  })

  return {
    profileOf, partsOf, loadGlobals,
    /** A thread's profile, if it's loaded yet. */
    loaded: (meta: ThreadMeta) => meta.profile && profiles.get(meta.profile.dir),
    all: () => [...profiles.values()],
    errors: () => [...profileErrors.values()],
    /** Why the profile in `dir` failed to load, while it hasn't loaded since. */
    error: (dir: string) => profileErrors.get(dir)?.error,
    /** A profile whose folder is gone and no thread is bound to: what it set up let go of, its failure forgotten. */
    forget(dir: string) {
      unload(dir)
      if (profileErrors.delete(dir)) changed()
    },
    /** Let go of every profile, as the daemon closes: what they share goes with the last. */
    unloadAll() { for (const dir of [...holds.keys()]) unload(dir) },
    /** A profile's UI, as the window loads it: its code too, so served only for a real profile folder, once it's allowed. */
    async ui(ref: ProfileRef) {
      // One that was loaded and is gone now is let go of (profileOf), and the window's UI of it with it.
      const known = profiles.get(ref.dir)
      if (!isProfileDir(ref, profileSources.roots()) && !known) throw new RpcError('not_found', `No profile at ${ref.dir}`)
      const loaded = await profileOf(known ? refOf(known) : refOf(ref))
      return { hash: loaded.hash, entries: loaded.spec.ui ?? [] }
    },
    /** One module of a profile's UI (see profileModule). */
    async module(ref: ProfileRef, path: string) {
      if (!isProfileDir(ref, profileSources.roots())) throw new RpcError('not_found', `No profile at ${ref.dir}`)
      await profileOf(refOf(ref))
      return profileModule(ref.dir, path)
    },
  }
}

export type ProfileHost = ReturnType<typeof createProfileHost>
