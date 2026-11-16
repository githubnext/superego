// The profile host: the profiles loaded here, by folder, each as its files are now. A profile's daemon halves are set up
// through the extension host, once however many profiles have them; its agent parts are installed once by name. A
// profile that changes is loaded again (not under a thread running it); one that's gone or broken lets go of all of it.
// Also the `profile.*` actions, the window's reads of a profile's UI, and Settings → Profiles.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Extension } from '@earendil-works/pi-durable'
import { Lifetime, obj, opt, RpcError, str } from '@superego/protocol'
import { describeProfile } from './extension-settings.ts'
import type { ExtensionHost } from './extension-host.ts'
import { defineAction } from './extension.ts'
import type { Host, ThreadMeta } from './host.ts'
import {
  broughtBy, findProfile, hashProfile, isProfileDir, listProfiles, loadProfile, profileModule, type LoadedProfile, type ProfileDaemonExtension,
  type ProfileRef,
} from './profiles.ts'
import type { Threads } from './threads.ts'

/**
 * A profile's daemon half, set up once however many profiles have it (by its file at one version, `key`: see
 * ProfileDaemonExtension), and torn down when the last of them lets it go. `profiles`: their folders, whose threads
 * its pane kinds are for; `parts`: the agent parts it gave, which each of them selects.
 */
type Shared = { key: string; file: string; profiles: Set<string>; parts: Extension[]; teardown: () => Promise<void> }

export function createProfileHost(host: Host, extensions: ExtensionHost, later: { threads(): Threads }) {
  const { registry, mounted, changed, userProfiles, allowances, profileKeys, settings, router, folderOf } = host
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
  /** Profile `dir`'s use of a daemon half: the one set up already for another profile, else set up now. */
  async function share(item: ProfileDaemonExtension, dir: string) {
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
      }, made.profiles, { source: 'profile', file: item.file })
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
        loadProfile(ref, userProfiles, allowances, profileKeys),
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
        const { entry, release } = await share(item, ref.dir)
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

  router.register(defineAction({
    id: 'profile.list', title: 'List profiles', expose: ['ui', 'cli', 'outside'],
    description: 'The profiles a thread in `cwd` could start with (thread.start\'s `profile`), and whether each may run.',
    params: obj({ cwd: opt(str()) }),
    async run({ cwd }) {
      const dir = folderOf(cwd)
      return Promise.all(listProfiles(dir, userProfiles).map(async (ref) => {
        const loaded = profiles.get(ref.dir)
        const description = loaded?.spec.description
        // One whose imports can't be told can't be allowed as it is: loading it says why.
        const allowed = await Promise.resolve().then(async () => allowances.allowed(ref, await hashProfile(ref.dir))).catch(() => false)
        return { ...ref, ...(description ? { description } : {}), allowed, ...(loaded ? broughtBy(loaded, profileKeys) : {}) }
      }))
    },
  }))
  router.register(defineAction({
    id: 'profile.allow', title: 'Allow a project profile to run', expose: ['ui', 'cli'],
    params: obj({ cwd: opt(str()), name: opt(str()) }),
    async run({ cwd, name }) {
      const dir = folderOf(cwd)
      const ref = findProfile(dir, userProfiles, name?.trim() || undefined)
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
      const ref = findProfile(dir, userProfiles, name?.trim() || undefined)
      if (!ref) throw new RpcError('not_found', `No profile ${name ?? ''} in ${dir}`.replace('  ', ' '))
      await profileOf(ref)
      return ref
    },
  }))
  // The profiles threads here can start with: the user's, and those of the projects that have threads.
  settings.register({
    id: 'profiles', title: 'Profiles', order: 75, ui: 'profiles', settings: [],
    description: 'Your own, and those of the projects you have threads in.',
    data: async () => {
      const found = new Map<string, ProfileRef>()
      for (const folder of new Set([host.defaultCwd, ...(await later.threads().list()).map((t) => t.project.root)])) {
        for (const ref of listProfiles(folder, userProfiles)) found.set(ref.dir, ref)
      }
      return Promise.all([...found.values()].map((ref) => describeProfile(ref, userProfiles, allowances, profileKeys)))
    },
  })

  return {
    profileOf, partsOf,
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
      if (!isProfileDir(ref, userProfiles) && !known) throw new RpcError('not_found', `No profile at ${ref.dir}`)
      const loaded = await profileOf(known ? { scope: known.scope, name: known.name, dir: known.dir } : { scope: ref.scope, name: ref.name, dir: ref.dir })
      return { hash: loaded.hash, entries: loaded.spec.ui ?? [] }
    },
    /** One module of a profile's UI (see profileModule). */
    async module(ref: ProfileRef, path: string) {
      if (!isProfileDir(ref, userProfiles)) throw new RpcError('not_found', `No profile at ${ref.dir}`)
      await profileOf({ scope: ref.scope, name: ref.name, dir: ref.dir })
      return profileModule(ref.dir, path)
    },
  }
}

export type ProfileHost = ReturnType<typeof createProfileHost>
