// Profiles: what an agent is, as files. A profile is a folder with a `profile.ts`, in the user's `~/.superego/profiles/<name>`
// or in a project's own `.superego/profiles/<name>`, so a repo can carry the harness it needs (a customer-service agent in the
// support repo, say). A thread takes its profile when it starts and keeps it: where it moved (relocated), if it moves.
//
//   import { defineProfile } from 'superego'
//   export default defineProfile({
//     description: 'Answers customer mail',
//     model: 'anthropic/claude-sonnet-4-5',
//     prompt: 'You answer customer email for Acme. Be brief.',
//     extensions: ['./extensions/orders.ts'],    // agent parts: tools, prompt sections, hooks
//     without: ['agent-ui'],                      // built-ins this profile does without
//     mcpServers: ['linear'],                     // an extension's own key: the MCP servers its threads use
//   })
//
// Besides its own keys, a profile carries extensions' (`mcpServers`, the mcp-servers extension's), each checked and
// merged over `extends` by the extension that registered it (`superego.profileKey`); the core only carries them.
//
// The user's own profiles are `~/.superego/profiles/<name>`, then those of each profile source in the order installed
// (profile-sources.ts: a git repo or a folder, its `profiles/<name>`): of two of one name, the first is used, and the
// other told of as shadowed. Each is a user root (`UserRoot`), and wherever a user's profile is looked for, it's across them.
//
// A project's profile replaces the user's of the same name, unless it `extends: 'user:<name>'`. A project's profile is
// code from that repo, so it runs only once allowed (`superego profile allow`), and again after any of its files change.
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import * as nodeModule from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Extension } from '@earendil-works/pi-durable'
import type { DaemonExtension } from './extension.ts'
import { RpcError, type Json } from '@superego/protocol'
import { CODE, digestOf, graphOf, profileImport, versionedUrl, versionOf, within } from './module-graph.ts'
import { projectFolders, trusted } from './project-files.ts'
import { writeAtomic } from './write-atomic.ts'

/**
 * A profile, as its profile.ts default-exports it (`defineProfile`): its agent's model, prompt and extensions, its UI.
 * The core's keys only: closed, so a typo or a key that's gone fails the type check. Bundled extensions' own keys
 * (`superego.profileKey`) are added where they're known, by the SDK's `defineProfile` ('superego').
 */
export type ProfileSpec = {
  /** What it's for, in a line: shown where it's picked. */
  description?: string
  /** `provider/model` for its threads, unless a thread picks its own. */
  model?: string
  /** Thinking level for its threads (`low`, `high`, …), unless a thread picks its own. */
  thinking?: string
  /**
   * The kind of agent its threads run on, for their whole life: an extension's (`agentKind`), such as `claude-agent`.
   * Unset, Superego's own.
   */
  agent?: string
  /** Instructions for the agent, after the extensions' prompt sections. */
  prompt?: string
  /**
   * Extensions, as paths from the profile's folder. A module's default export is an agent part (defineExtension:
   * tools, prompt sections, hooks) or a daemon half (defineDaemonExtension: actions, live values, agent parts
   * of its own), set up when the profile loads and torn down when its files change.
   */
  extensions?: string[]
  /**
   * UI halves, as paths from the profile's folder: modules whose default export is defineUiExtension({ … }), drawn
   * for this profile's threads. They import from 'superego/ui' (hooks, components, `h` for elements) and 'react'.
   */
  ui?: string[]
  /**
   * Pane kinds this profile's UI adds, and what each shows: told to the agent, so it can open them (pane_open). The UI
   * registers them with superego.pane(kind, …).
   */
  panes?: Record<string, string>
  /**
   * What its threads ask extensions for, by name, unless a thread is started otherwise: as `thread.start`'s `options`,
   * read by their `starting` hooks (`{ worktrees: true }`: a git worktree of its own).
   */
  options?: Record<string, Json>
  /** Built-in extensions this profile does without: 'coding-tools', 'agent-ui', … */
  without?: string[]
  /** Start from another profile and add to it: 'user:<name>' (a project's profile on the user's). */
  extends?: string
  /**
   * One of your own profiles that is part of the app, not only of its threads: the daemon loads it as it starts (its
   * daemon halves run for the daemon's life), and the window installs its UI as the app's, so its views may go in any
   * place (a sidebar in the rail) and it may add spaces. Not a project's profile's, nor taken from the one it extends.
   */
  global?: boolean
}

/**
 * A profile as loaded: the core's keys, and extensions' own (`mcpServers: ['linear']`, the mcp-servers extension's),
 * read by key. Those are checked when the profile loads and merged over `extends` by the extension that registered them
 * (`superego.profileKey`); a key no extension here registered is the profile's problem (`LoadedProfile.problems`),
 * carried as it is, its `extends` the profile's own replacing the other's.
 */
export type LoadedSpec = ProfileSpec & { [key: string]: Json | undefined }

/** The profile keys that are the core's own: an extension can't register them (`profileKey`). */
export const CORE_KEYS = new Set(['description', 'model', 'thinking', 'agent', 'prompt', 'extensions', 'ui', 'panes', 'options', 'without', 'extends', 'global'])

/**
 * A key of an extension's own in profiles (`superego.profileKey`): how a profile's value of it is checked, merged over
 * `extends`, and told (`ProfileInfo.brings`).
 */
export type ProfileKey = {
  /** Why a profile's value won't do, in a line ("mcpServers: …"), if it won't: the profile then doesn't load. */
  check?(value: Json): string | undefined
  /** With `extends`: the two together, the base's (the user's) and the profile's own. Unset, its own replaces the base's. */
  merge?(base: Json, own: Json): Json
  /** What a profile's value brings, by name each (its servers), for where a profile is told about (its card). */
  brings?(value: Json): string[]
  /** What `brings` names, in a few words ("MCP servers"); default, the key. */
  title?: string
}

/** The profile keys registered now, by key, and whose each is. */
export type ProfileKeys = Map<string, ProfileKey & { owner: string }>

/** Identity for type inference: `export default defineProfile({ … })`. */
export const defineProfile = (spec: ProfileSpec) => spec

/**
 * A profile: the user's (`~/.superego/profiles/<name>`, or a profile source's `profiles/<name>`) or a project's
 * (`.superego/profiles/<name>`), its folder, and for one of a source's, the source.
 */
export type ProfileRef = { scope: 'user' | 'project'; name: string; dir: string; source?: string }

/**
 * A folder of the user's own profiles: `~/.superego/profiles` (no `source`), or a profile source's `profiles` folder.
 * Looked in in order: the first holding a name has the profile of that name.
 */
export type UserRoot = { dir: string; source?: string }

/**
 * A daemon half a profile names, and which: `key` is its file at the version loaded (the module's URL, versioned
 * by it and every local file it imports: see module-graph.ts), so two profiles naming the same file (one extending the other, or both listing it) share one set-up of it. `prefix` names
 * its agent parts: `<prefix>/<part>`, the profile whose folder holds the file (else `file:<hash of its path>`).
 */
export type ProfileDaemonExtension = { extension: DaemonExtension; key: string; file: string; prefix: string }

export type LoadedProfile = ProfileRef & {
  spec: LoadedSpec
  /** What's wrong with it that doesn't stop it loading (a key nothing here reads), for where it's told of (`ProfileInfo.problems`). */
  problems: string[]
  /** Its agent parts, installed under names of their own: `<scope>:<name>/<extension>`. */
  extensions: Extension[]
  /** Its daemon halves, for the daemon to set up (or share with another profile that has them set up already). */
  daemon: ProfileDaemonExtension[]
  /** What its files hash to: a change means reloading it, and (for a project's) allowing it again. */
  hash: string
  /** What it's made of: its own folder, what it extends, and files it lists from outside them. A change in any means loading it again. */
  versions: Record<string, string>
}

/**
 * What a loaded profile brings, as profile.list tells it: its extensions by name, and what extensions' keys bring, by
 * their titles (`{ 'MCP servers': ['linear'] }`), and the kind of agent its threads run on.
 */
export function broughtBy(profile: LoadedProfile, keys: ProfileKeys): { extensions?: string[]; brings?: Record<string, string[]>; problems?: string[]; agent?: string } {
  const extensions = [...new Set([...profile.daemon.map((d) => d.extension.name), ...profile.extensions.map((e) => e.name.split('/').at(-1)!)])]
  const brings: Record<string, string[]> = {}
  for (const [key, spec] of keys) {
    const value = profile.spec[key]
    if (value === undefined || !spec.brings) continue
    let items: string[]
    try { items = spec.brings(value) } catch (error) { console.error(`Profile key ${key} (${spec.owner}): brings failed:`, error); continue }
    if (items.length) brings[spec.title ?? key] = items
  }
  const agent = typeof profile.spec.agent === 'string' && profile.spec.agent ? profile.spec.agent : undefined
  return {
    ...(extensions.length ? { extensions } : {}), ...(Object.keys(brings).length ? { brings } : {}), ...(profile.problems.length ? { problems: profile.problems } : {}),
    ...(agent ? { agent } : {}),
  }
}

export const DEFAULT_PROFILE = 'default'

/** A path as it really is: symlinks followed, where it exists. */
const real = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

/** Whether `a` and `b` are the same folder, however they're spelled. */
const same = (a: string, b: string) => real(a) === real(b)

/**
 * The folder holding a project's profiles: the nearest `.superego/profiles` from `cwd` up to the project's top, that
 * isn't the user's own, and that no one else could have put there (project-files.ts). From `~` (or a repository whose
 * top is `~`), that walk finds `~/.superego/profiles`: the user's, never a project's, even for a daemon keeping its
 * data elsewhere (`SUPEREGO_HOME`), as is each of the user's roots wherever it is.
 */
export function projectProfiles(cwd: string, roots: UserRoot[]): string | undefined {
  for (const dir of projectFolders(cwd)) {
    const candidate = join(dir, '.superego', 'profiles')
    const users = roots.some((root) => same(candidate, root.dir)) || same(dir, homedir())
    if (!users && trusted(join(dir, '.superego')) && trusted(candidate) && statSync(candidate).isDirectory()) return candidate
  }
  return undefined
}

const names = (root: string | undefined) => !root || !existsSync(root) ? [] :
  readdirSync(root).filter((name) => existsSync(join(root, name, 'profile.ts'))).sort()

/** Every profile in each of the user's roots, in order: those shadowed by an earlier one of their name too. */
export function allUserProfiles(roots: UserRoot[]): ProfileRef[] {
  return roots.flatMap((root) => names(root.dir).map((name): ProfileRef => ({ scope: 'user', name, dir: join(root.dir, name), ...(root.source ? { source: root.source } : {}) })))
}

/** The user's own profiles, by name: of two of one name, the first root's. */
export function userProfiles(roots: UserRoot[]): ProfileRef[] {
  const seen = new Set<string>()
  return allUserProfiles(roots).filter((p) => !seen.has(p.name) && seen.add(p.name))
}

/** The user's profile `name`, in the first root that has one. */
export const userProfile = (roots: UserRoot[], name: string) => userProfiles(roots).find((p) => p.name === name)

/**
 * What's wrong with how the user's profiles are found, by the folder of the one it's about: one shadowing another of
 * its name from a later root (a profile source installed after), and that one, which isn't used.
 */
export function shadowing(roots: UserRoot[]): Map<string, string[]> {
  const first = new Map<string, ProfileRef>()
  const problems = new Map<string, string[]>()
  const add = (dir: string, problem: string) => problems.set(dir, [...problems.get(dir) ?? [], problem])
  for (const ref of allUserProfiles(roots)) {
    const winner = first.get(ref.name)
    if (!winner) { first.set(ref.name, ref); continue }
    add(winner.dir, `Shadows the ${ref.name} profile of ${ref.source ?? '~/.superego/profiles'} (${ref.dir}), which isn't used`)
    add(ref.dir, `Shadowed by ${winner.dir}, of ${winner.source ?? '~/.superego/profiles'}: not used`)
  }
  return problems
}

/** Every profile a thread in `cwd` could start with: the project's, then the user's it doesn't replace. */
export function listProfiles(cwd: string, roots: UserRoot[]): ProfileRef[] {
  const project = projectProfiles(cwd, roots)
  const own = names(project).map((name): ProfileRef => ({ scope: 'project', name, dir: join(project!, name) }))
  const user = userProfiles(roots).filter((p) => !own.some((o) => o.name === p.name))
  return [...own, ...user]
}

/** The profile a thread in `cwd` starts with: `name` if given, else the default; the project's before the user's. */
export function findProfile(cwd: string, roots: UserRoot[], name?: string): ProfileRef | undefined {
  const wanted = name ?? DEFAULT_PROFILE
  const found = listProfiles(cwd, roots).find((p) => p.name === wanted)
  if (!found && name) throw new RpcError('not_found', `No profile ${name} for ${cwd}`, { hint: `Make one: superego profile new ${name}` })
  return found
}

/** Whether a profile's folder is still there to load: its `profile.ts`. */
export const profileThere = (ref: ProfileRef) => existsSync(join(ref.dir, 'profile.ts'))

/**
 * Where a thread's profile is now that its folder is gone (moved to the user's profiles, say): the profile of that name
 * a thread in the first of `cwds` that has one would start with now (the project's before the user's). None: undefined.
 */
export function relocated(ref: ProfileRef, cwds: string[], roots: UserRoot[]): ProfileRef | undefined {
  for (const cwd of new Set(cwds)) {
    const found = listProfiles(cwd, roots).find((p) => p.name === ref.name && !same(p.dir, ref.dir))
    if (found) return found
  }
  return undefined
}

/**
 * A hash of what a profile runs, what allowing it vouches for: every file in its folder (not node_modules, nor
 * dotfiles: what its code reads as it runs, say), and every file its code can run (module-graph.ts): each module in its
 * folder, hidden ones too, and every local file they import, wherever, dotfiles included. Symlinks are followed. Of a
 * file (one a profile lists from outside its folder), it and the local files it imports (`versionOf`). Packages and
 * aliases aren't in it: its modules can't import them (module-graph.ts's profileImport). Throws for a module whose
 * imports can't be told.
 */
export async function hashProfile(dir: string): Promise<string> {
  if (statSync(dir).isFile()) return versionOf(dir)
  const root = real(dir)
  const hash = createHash('sha256')
  const hashed = new Set<string>()
  const add = (name: string, file: string) => { hashed.add(file); hash.update(name).update('\0').update(digestOf(file)).update('\0') }
  const code: string[] = []
  const walk = (at: string, hidden: boolean, folders: Set<string>) => {
    for (const entry of readdirSync(at).sort((a, b) => a.localeCompare(b))) {
      if (entry === 'node_modules' || entry === '.git') continue
      const path = join(at, entry)
      const file = real(path)
      let stat
      try { stat = statSync(file) } catch { continue }
      const dot = hidden || entry.startsWith('.')
      // A symlinked folder is walked as its own, once along the way (a link to a folder above it isn't a loop).
      if (stat.isDirectory()) { if (!folders.has(file)) walk(path, dot, new Set([...folders, file])) }
      else if (stat.isFile()) {
        if (CODE.test(entry)) code.push(file)
        if (!dot) add(relative(dir, path), file)
      }
    }
  }
  walk(dir, false, new Set([root]))
  // What its code imports and the walk left out: a hidden file, or one outside its folder (a helper shared between profiles).
  for (const file of await graphOf(code)) if (!hashed.has(file)) add(within(root, file) ? relative(root, file) : file, file)
  return hash.digest('hex').slice(0, 16)
}

/**
 * Which project profiles may run here: the hash each was allowed at, and of each file it lists from outside its folder
 * then (that's code it runs too). Kept in the daemon's data dir.
 */
type Allowed = Record<string, { hash: string; files: Record<string, string> }>
export class Allowances {
  #path: string
  #allowed: Allowed | undefined
  constructor(dataDir: string) { this.#path = join(dataDir, 'allowed-profiles.json') }
  async #load() { return this.#allowed ??= JSON.parse(await readFile(this.#path, 'utf8').catch(() => '{}')) as Allowed }
  async #of(ref: ProfileRef) { return (await this.#load())[ref.dir] }
  async allowed(ref: ProfileRef, hash: string) { return ref.scope === 'user' || (await this.#of(ref))?.hash === hash }
  /** Whether `file`, listed from outside the profile's folder, is as it was when the profile was allowed. */
  async allowedFile(ref: ProfileRef, file: string) { return ref.scope === 'user' || (await this.#of(ref))?.files[file] === await hashProfile(file) }
  /** Allow it as it is now: its folder, and the files it lists from outside it (reading its profile.ts to know them). */
  async allow(ref: ProfileRef) {
    const all = await this.#load()
    const files = Object.fromEntries(await Promise.all((await outsideFiles(ref)).map(async (file) => [file, await hashProfile(file)])))
    const hash = await hashProfile(ref.dir)
    all[ref.dir] = { hash, files }
    await writeAtomic(this.#path, JSON.stringify(all, null, 2) + '\n')
    return hash
  }
}

/** What `import … from 'superego'` gives a profile and its extensions. */
export type ProfileSdk = Record<string, unknown>

/**
 * Node's own `import()`, out of reach of bundlers and test runners that would rewrite it: profiles must load through
 * Node's loader, where the hook for 'superego' and TypeScript's type stripping are.
 */
const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>
/** Where modules run in a VM without Node's loader (vitest), plain `import()`, with 'superego' aliased to sdk-shim.ts. */
const load = (url: string) => nativeImport(url).catch((error: unknown) => {
  if (!/dynamic import callback/.test(String(error))) throw error
  return import(/* @vite-ignore */ url)
})

/** What 'superego' exports: kept in step with sdk-shim.ts (a test checks). */
export const SDK_EXPORTS = [
  'defineProfile', 'defineExtension', 'defineTool', 'section', 'hook', 'wrapTool', 'wrapSection', 'defineDaemonExtension', 'defineAction', 'RpcError', 'spawnGroup',
  'arr', 'blockErrors', 'bool', 'int', 'lit', 'nullable', 'num', 'obj', 'opt', 'str', 'union', 'unknown',
] as const

let hooked = false
/** Profiles and their extensions `import … from 'superego'` without installing anything: the daemon answers with its own API. */
export function provideSdk(sdk: ProfileSdk) {
  const missing = SDK_EXPORTS.filter((key) => !(key in sdk))
  if (missing.length) throw new Error(`The profile SDK lacks ${missing.join(', ')}`)
  ;(globalThis as { __superegoSdk?: ProfileSdk }).__superegoSdk = sdk
  if (hooked) return
  hooked = true
  const source = `const sdk = globalThis.__superegoSdk;\n${SDK_EXPORTS.map((key) => `export const ${key} = sdk.${key};`).join('\n')}\nexport default sdk;\n`
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'superego') return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      // A profile's module imports its own files at their versions now, not the copies Node loaded before, and nothing
      // its allowing didn't vouch for (profileImport). Imports only (profiles are ES modules): a require takes paths, not URLs.
      let resolved: ReturnType<typeof next> | undefined
      const url = profileImport(specifier, context.parentURL, () => (resolved = next(context.conditions?.includes('import') ? realSpecifier(specifier, context.parentURL) : specifier, context)).url)
      return { ...resolved!, url }
    },
  })
}

/**
 * A file `specifier` names, by its real path as it is now: Node's resolver follows symlinks through a cache it keeps for
 * the life of the process, so a profile linked into ~/.superego/profiles and then linked elsewhere (its repo moved)
 * would load from the old target, gone, until the daemon restarts. A real path is one that cache has nothing to say
 * about. Anything else (a package, a path that isn't a file as written) is left for Node to resolve.
 */
function realSpecifier(specifier: string, parent: string | undefined): string {
  if (!/^(\.{0,2}\/|file:)/.test(specifier)) return specifier
  let url: URL
  try { url = new URL(specifier, parent ?? pathToFileURL(process.cwd() + '/')) } catch { return specifier }
  if (url.protocol !== 'file:') return specifier
  let path: string
  // Not a file as written (Node then says so, or finds one a runtime would guess, or a folder's index): left to Node.
  try { path = realpathSync(fileURLToPath(new URL(url.pathname, url))) } catch { return specifier }
  if (!statSync(path).isFile()) return specifier
  return pathToFileURL(path).href + url.search + url.hash
}

/**
 * A file's module URL, versioned by it and the local files it imports (module-graph.ts): a query that changes with any
 * of them makes Node load it again rather than reuse the first import, and the files it imports are loaded at their
 * versions too. Wherever it is and whichever profile names it, profiles naming the same file share one.
 */
const fresh = versionedUrl

/** What a profile's profile.ts says, as it is now. */
/** Whether one of the user's profiles says it's `global`, by its profile.ts alone (nothing of it set up). */
export async function isGlobal(ref: ProfileRef): Promise<boolean> {
  return ref.scope === 'user' && (await specOf(ref)).global === true
}

async function specOf(ref: ProfileRef): Promise<LoadedSpec> {
  const spec = (await load(fresh(join(ref.dir, 'profile.ts'))) as { default?: LoadedSpec }).default
  if (!spec || typeof spec !== 'object') throw new RpcError('invalid', `${join(ref.dir, 'profile.ts')} must export default defineProfile({ … })`)
  return spec
}

/** The files a profile lists from outside its own folder (a shared extension), resolved. */
async function outsideFiles(ref: ProfileRef) {
  // One that doesn't load lists nothing: allowed, it fails to load until fixed (and allowed again, as it changed).
  const spec = await specOf(ref).catch(() => undefined)
  return (spec?.extensions ?? []).map((path) => resolve(ref.dir, path)).filter((file) => !within(ref.dir, file) && existsSync(file))
}

/** Load a profile (and what it extends) fresh from disk; refuses a project's profile that isn't allowed as it is now. */
export async function loadProfile(ref: ProfileRef, roots: UserRoot[], allowances: Allowances, keys: ProfileKeys = new Map()): Promise<LoadedProfile> {
  const hash = await hashProfile(ref.dir)
  if (!(await allowances.allowed(ref, hash))) {
    throw new RpcError('profile_not_allowed', `The profile ${ref.name} in ${dirname(dirname(dirname(ref.dir)))} runs that project's code: allow it first (again, if it changed since)`, {
      hint: `Look it over, then: superego profile allow ${ref.name}`,
    })
  }
  const spec = await specOf(ref)
  const problems: string[] = []
  for (const [key, value] of Object.entries(spec)) {
    if (value === undefined || CORE_KEYS.has(key)) continue
    const owned = keys.get(key)
    if (!owned) { problems.push(`${key} isn't a key of any extension here`); continue }
    let problem: string | undefined
    try { problem = owned.check?.(value) } catch (error) { problem = `${key}: ${(error as Error).message}` }
    if (problem) throw new RpcError('invalid', `Profile ${ref.name}: ${problem}`)
  }
  let base: LoadedProfile | undefined
  if (spec.extends) {
    const [scope, name] = spec.extends.split(':')
    if (scope !== 'user' || !name) throw new RpcError('invalid', `extends: '${spec.extends}' — use 'user:<name>'`)
    const found = userProfile(roots, name)
    if (!found) throw new RpcError('not_found', `No user profile ${name} to extend`)
    base = await loadProfile(found, roots, allowances, keys)
  }
  const extensions: Extension[] = [...(base?.extensions ?? [])]
  const daemon: ProfileDaemonExtension[] = [...(base?.daemon ?? [])]
  const versions: Record<string, string> = { ...base?.versions, [ref.dir]: hash }
  for (const path of spec.extensions ?? []) {
    const file = resolve(ref.dir, path)
    if (!existsSync(file)) throw new RpcError('not_found', `${path} in profile ${ref.name} doesn't exist`)
    const outside = !within(ref.dir, file)
    if (outside && !(await allowances.allowedFile(ref, file))) {
      throw new RpcError('profile_not_allowed', `The profile ${ref.name} runs ${file}, which changed since it was allowed (or wasn't listed then)`, {
        hint: `Look it over, then: superego profile allow ${ref.name}`,
      })
    }
    // A file from outside its folder is part of what it's made of too: a change in it loads the profile again.
    if (outside) versions[file] = await hashProfile(file)
    const key = fresh(file)
    const module = await load(key) as { default?: Extension | DaemonExtension }
    const extension = module.default
    if (!extension?.name) throw new RpcError('invalid', `${path} in profile ${ref.name} must export default an extension with a name`)
    const prefix = ownerOf(file, ref, roots)
    // Named once, though listed again (by this profile and the one it extends, say).
    if (typeof (extension as DaemonExtension).setup === 'function') {
      if (!daemon.some((d) => d.key === key)) daemon.push({ extension: extension as DaemonExtension, key, file, prefix })
    } else if (!extensions.some((e) => e.name === `${prefix}/${extension.name}`)) {
      extensions.push({ ...(extension as Extension), name: `${prefix}/${extension.name}` })
    }
  }
  // Extensions' keys in both: as their extension merges them.
  const theirs: Record<string, Json> = {}
  for (const [key, own] of Object.entries(spec)) {
    const below = base?.spec[key]
    const merge = keys.get(key)?.merge
    if (CORE_KEYS.has(key) || own === undefined || below === undefined || !merge) continue
    try { theirs[key] = merge(below, own) } catch (error) { throw new RpcError('invalid', `Profile ${ref.name}: ${key} doesn't go with ${spec.extends}'s: ${(error as Error).message}`) }
  }
  const merged: LoadedSpec = {
    ...base?.spec, ...spec, ...theirs,
    prompt: [base?.spec.prompt, spec.prompt].filter(Boolean).join('\n\n') || undefined,
    without: [...new Set([...(base?.spec.without ?? []), ...(spec.without ?? [])])],
    options: { ...base?.spec.options, ...spec.options },
    // UI paths are relative to their own profile's folder: only this profile's are served from here.
    ui: spec.ui,
    // Its own say, never the one it extends': and only one of the user's own may be.
    global: ref.scope === 'user' && spec.global === true ? true : undefined,
  }
  if (spec.global && ref.scope !== 'user') problems.push("global: only one of your own profiles may be global, not a project's")
  return { ...ref, spec: merged, problems: [...base?.problems.map((p) => `${spec.extends}: ${p}`) ?? [], ...problems], extensions, daemon, hash, versions }
}

/**
 * Whose a listed file is, to name its agent parts by, whichever profile lists it: the profile whose folder holds it
 * (this one, or a user profile it shares with), else the file itself. The same file is named the same however the
 * profiles that list it load, and after a restart.
 */
function ownerOf(file: string, ref: ProfileRef, roots: UserRoot[]) {
  if (within(ref.dir, file)) return `${ref.scope}:${ref.name}`
  for (const root of roots) {
    const name = within(root.dir, file) ? relative(resolve(root.dir), file).split(/[\\/]/)[0] : undefined
    if (name && existsSync(join(root.dir, name, 'profile.ts'))) return `user:${name}`
  }
  return `file:${createHash('sha256').update(file).digest('hex').slice(0, 12)}`
}

/** Whether `dir` is a profile folder at all: in one of the user's roots, or a project's `.superego/profiles`. */
export function isProfileDir(ref: ProfileRef, roots: UserRoot[]): boolean {
  const parent = dirname(ref.dir)
  const ok = ref.scope === 'user' ? roots.some((root) => resolve(parent) === resolve(root.dir)) : parent.endsWith(join('.superego', 'profiles'))
  return ok && ref.name === ref.dir.split(/[\\/]/).at(-1) && existsSync(join(ref.dir, 'profile.ts'))
}

/**
 * One module of a profile's UI, as the window loads it: the file at `path` (tried as given, then with .tsx, .ts, .jsx,
 * .js or /index.*), inside the profile's folder, compiled to JavaScript: types stripped, JSX turned into calls to
 * 'react/jsx-runtime' (the window's own React). Its imports are left for the window to load.
 */
export async function profileModule(dir: string, path: string): Promise<{ path: string; code: string }> {
  const base = resolve(dir, path)
  if (base !== dir && !base.startsWith(dir + '/')) throw new RpcError('invalid', `${path} is outside the profile`)
  const candidates = [base, ...['.tsx', '.ts', '.jsx', '.js'].map((ext) => `${base}${ext}`), ...['tsx', 'ts', 'jsx', 'js'].map((ext) => join(base, `index.${ext}`))]
  const found = candidates.find((p) => existsSync(p) && statSync(p).isFile())
  if (!found) throw new RpcError('not_found', `No module ${path} in the profile`)
  const source = await readFile(found, 'utf8')
  const typed = /\.[cm]?tsx?$/.test(found)
  const jsx = /x$/.test(found)
  // Loaded only now, not with the daemon: some 60 modules, a second of its start on a busy machine.
  const { transform } = await import('sucrase')
  try {
    const { code } = transform(source, {
      transforms: [...(typed ? ['typescript' as const] : []), ...(jsx ? ['jsx' as const] : [])],
      jsxRuntime: 'automatic', production: true, filePath: found, disableESTransforms: true,
    })
    return { path: relative(dir, found), code }
  } catch (error) {
    throw new RpcError('invalid', `${relative(dir, found)}: ${(error as Error).message}`)
  }
}
