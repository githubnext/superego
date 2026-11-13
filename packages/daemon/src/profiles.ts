// Profiles: what an agent is, as files. A profile is a folder with a `profile.ts`, in the user's `~/.superego/profiles/<name>`
// or in a project's own `.superego/profiles/<name>`, so a repo can carry the harness it needs (a customer-service agent in the
// support repo, say). A thread takes its profile when it starts and keeps it.
//
//   import { defineProfile } from 'superego'
//   export default defineProfile({
//     description: 'Answers customer mail',
//     model: 'anthropic/claude-sonnet-4-5',
//     prompt: 'You answer customer email for Acme. Be brief.',
//     extensions: ['./extensions/orders.ts'],    // agent extensions: tools, prompt sections, hooks
//     without: ['ask-user'],                      // built-ins this profile does without
//   })
//
// A project's profile replaces the user's of the same name, unless it `extends: 'user:<name>'`. A project's profile is
// code from that repo, so it runs only once allowed (`superego profile allow`), and again after any of its files change.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as nodeModule from 'node:module'
import { transform } from 'sucrase'
import type { Extension } from '@earendil-works/pi-durable'
import type { DaemonExtension } from './extension.ts'
import { RpcError } from '@superego/protocol'

export type ProfileSpec = {
  description?: string
  /** `provider/model` for its threads, unless a thread picks its own. */
  model?: string
  thinking?: string
  /** Instructions for the agent, after the extensions' prompt sections. */
  prompt?: string
  /**
   * Extensions, as paths from the profile's folder. A module's default export is an agent extension (defineExtension:
   * tools, prompt sections, hooks) or a daemon extension (defineDaemonExtension: actions, live values, agent extensions
   * of its own), set up when the profile loads and torn down when its files change.
   */
  extensions?: string[]
  /**
   * UI extensions, as paths from the profile's folder: modules whose default export is defineUiExtension({ … }), drawn
   * for this profile's threads. They import from 'superego/ui' (hooks, components, `h` for elements) and 'react'.
   */
  ui?: string[]
  /**
   * Pane kinds this profile's UI adds, and what each shows: told to the agent, so it can open them (open_pane). The UI
   * registers them with superego.pane(kind, …).
   */
  panes?: Record<string, string>
  /** Whether its threads get a git worktree of their own (in a repository), unless a thread is started otherwise. */
  worktree?: boolean
  /** Built-in extensions this profile does without: 'coding-tools', 'ask-user', … */
  without?: string[]
  /** Start from another profile and add to it: 'user:<name>' (a project's profile on the user's). */
  extends?: string
}

/** Identity for type inference: `export default defineProfile({ … })`. */
export const defineProfile = (spec: ProfileSpec) => spec

export type ProfileRef = { scope: 'user' | 'project'; name: string; dir: string }

/**
 * A daemon extension a profile names, and which: `key` is its file at the version loaded (the module's URL), so two
 * profiles naming the same file (one extending the other, or both listing it) share one set-up of it. `prefix` names
 * its agent parts: `<prefix>/<part>`, the profile whose folder holds the file (else `file:<hash of its path>`).
 */
export type ProfileDaemonExtension = { extension: DaemonExtension; key: string; file: string; prefix: string }

export type LoadedProfile = ProfileRef & {
  spec: ProfileSpec
  /** Its agent extensions, installed under names of their own: `<scope>:<name>/<extension>`. */
  extensions: Extension[]
  /** Its daemon extensions, for the daemon to set up (or share with another profile that has them set up already). */
  daemon: ProfileDaemonExtension[]
  /** What its files hash to: a change means reloading it, and (for a project's) allowing it again. */
  hash: string
  /** What it's made of, by folder: its own and what it extends. A change in any means loading it again. */
  versions: Record<string, string>
}

export const DEFAULT_PROFILE = 'default'

/** The folder holding a project's profiles: the nearest `.superego/profiles` at or above `cwd`. */
export function projectProfiles(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, '.superego', 'profiles')
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
    if (dirname(dir) === dir) return undefined
  }
}

const names = (root: string | undefined) => !root || !existsSync(root) ? [] :
  readdirSync(root).filter((name) => existsSync(join(root, name, 'profile.ts'))).sort()

/** Every profile a thread in `cwd` could start with: the project's, then the user's it doesn't replace. */
export function listProfiles(cwd: string, userRoot: string): ProfileRef[] {
  const project = projectProfiles(cwd)
  const own = names(project).map((name): ProfileRef => ({ scope: 'project', name, dir: join(project!, name) }))
  const user = names(userRoot).filter((name) => !own.some((p) => p.name === name))
    .map((name): ProfileRef => ({ scope: 'user', name, dir: join(userRoot, name) }))
  return [...own, ...user]
}

/** The profile a thread in `cwd` starts with: `name` if given, else the default; the project's before the user's. */
export function findProfile(cwd: string, userRoot: string, name?: string): ProfileRef | undefined {
  const wanted = name ?? DEFAULT_PROFILE
  const found = listProfiles(cwd, userRoot).find((p) => p.name === wanted)
  if (!found && name) throw new RpcError('not_found', `No profile ${name} for ${cwd}`, { hint: `Make one: superego profile new ${name}` })
  return found
}

/** A hash of every file in a profile's folder (not node_modules): what allowing it vouches for. */
export function hashProfile(dir: string): string {
  const hash = createHash('sha256')
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) hash.update(relative(dir, path)).update('\0').update(readFileSync(path)).update('\0')
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 16)
}

/** Which project profiles may run here: the hash each was allowed at. Kept in the daemon's data dir. */
export class Trust {
  #path: string
  #allowed: Record<string, string> | undefined
  constructor(dataDir: string) { this.#path = join(dataDir, 'trusted-profiles.json') }
  async #load() { return this.#allowed ??= JSON.parse(await readFile(this.#path, 'utf8').catch(() => '{}')) as Record<string, string> }
  async allowed(ref: ProfileRef, hash: string) { return ref.scope === 'user' || (await this.#load())[ref.dir] === hash }
  async allow(ref: ProfileRef) {
    const all = await this.#load()
    all[ref.dir] = hashProfile(ref.dir)
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
    return all[ref.dir]!
  }
}

/** What `import … from 'superego'` gives a profile and its extensions. */
export type ProfileSdk = Record<string, unknown>

// Only the runtime virtual-module API we use; Node builds need no Bun type dependency.
type BunModuleLoader = {
  plugin(plugin: {
    name: string
    setup(build: { module(name: string, load: () => { exports: ProfileSdk; loader: 'object' }): void }): void
  }): void
}

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
  'defineProfile', 'defineExtension', 'defineTool', 'section', 'hook', 'wrapTool', 'wrapSection', 'defineDaemonExtension', 'defineAction', 'RpcError',
  'arr', 'bool', 'int', 'lit', 'nullable', 'num', 'obj', 'opt', 'str', 'union', 'unknown',
] as const

let hooked = false
/** Profiles and their extensions `import … from 'superego'` without installing anything: the daemon answers with its own API. */
export function provideSdk(sdk: ProfileSdk) {
  const missing = SDK_EXPORTS.filter((key) => !(key in sdk))
  if (missing.length) throw new Error(`The profile SDK lacks ${missing.join(', ')}`)
  ;(globalThis as { __superegoSdk?: ProfileSdk }).__superegoSdk = sdk
  if (hooked) return
  hooked = true
  // Bun's runtime virtual modules (not its bundler-only onResolve hooks).
  const bun = (globalThis as typeof globalThis & { Bun?: BunModuleLoader }).Bun
  if (bun) {
    bun.plugin({ name: 'superego-profile-sdk', setup(build) {
      build.module('superego', () => ({ exports: sdk, loader: 'object' }))
    } })
    return
  }
  const source = `const sdk = globalThis.__superegoSdk;\n${SDK_EXPORTS.map((key) => `export const ${key} = sdk.${key};`).join('\n')}\nexport default sdk;\n`
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'superego') return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      return next(specifier, context)
    },
  })
}

/** Load a profile (and what it extends) fresh from disk; refuses a project's profile that isn't allowed as it is now. */
export async function loadProfile(ref: ProfileRef, userRoot: string, trust: Trust): Promise<LoadedProfile> {
  const hash = hashProfile(ref.dir)
  if (!(await trust.allowed(ref, hash))) {
    throw new RpcError('untrusted_profile', `The profile ${ref.name} in ${dirname(dirname(dirname(ref.dir)))} runs that project's code: allow it first (again, if it changed since)`, {
      hint: `Look it over, then: superego profile allow ${ref.name}`,
    })
  }
  // A query that changes with the file makes Node load it again rather than reuse the first import. Its own contents
  // version it, wherever it is and whichever profile names it: profiles that name the same file share one module.
  const fresh = (path: string) => `${pathToFileURL(path).href}?v=${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)}`
  const spec = (await load(fresh(join(ref.dir, 'profile.ts'))) as { default?: ProfileSpec }).default
  if (!spec || typeof spec !== 'object') throw new RpcError('invalid', `${join(ref.dir, 'profile.ts')} must export default defineProfile({ … })`)
  let base: LoadedProfile | undefined
  if (spec.extends) {
    const [scope, name] = spec.extends.split(':')
    if (scope !== 'user' || !name) throw new RpcError('invalid', `extends: '${spec.extends}' — use 'user:<name>'`)
    if (!existsSync(join(userRoot, name, 'profile.ts'))) throw new RpcError('not_found', `No user profile ${name} to extend`)
    base = await loadProfile({ scope: 'user', name, dir: join(userRoot, name) }, userRoot, trust)
  }
  const extensions: Extension[] = [...(base?.extensions ?? [])]
  const daemon: ProfileDaemonExtension[] = [...(base?.daemon ?? [])]
  for (const path of spec.extensions ?? []) {
    const file = resolve(ref.dir, path)
    if (!existsSync(file)) throw new RpcError('not_found', `${path} in profile ${ref.name} doesn't exist`)
    const key = fresh(file)
    const module = await load(key) as { default?: Extension | DaemonExtension }
    const extension = module.default
    if (!extension?.name) throw new RpcError('invalid', `${path} in profile ${ref.name} must export default an extension with a name`)
    const prefix = ownerOf(file, ref, userRoot)
    // Named once, though listed again (by this profile and the one it extends, say).
    if (typeof (extension as DaemonExtension).setup === 'function') {
      if (!daemon.some((d) => d.key === key)) daemon.push({ extension: extension as DaemonExtension, key, file, prefix })
    } else if (!extensions.some((e) => e.name === `${prefix}/${extension.name}`)) {
      extensions.push({ ...(extension as Extension), name: `${prefix}/${extension.name}` })
    }
  }
  const merged: ProfileSpec = {
    ...base?.spec, ...spec,
    prompt: [base?.spec.prompt, spec.prompt].filter(Boolean).join('\n\n') || undefined,
    without: [...new Set([...(base?.spec.without ?? []), ...(spec.without ?? [])])],
    // UI paths are relative to their own profile's folder: only this profile's are served from here.
    ui: spec.ui,
  }
  return { ...ref, spec: merged, extensions, daemon, hash, versions: { ...base?.versions, [ref.dir]: hash } }
}

/**
 * Whose a listed file is, to name its agent parts by, whichever profile lists it: the profile whose folder holds it
 * (this one, or a user profile it shares with), else the file itself. The same file is named the same however the
 * profiles that list it load, and after a restart.
 */
function ownerOf(file: string, ref: ProfileRef, userRoot: string) {
  const within = (dir: string) => { const path = relative(resolve(dir), file); return path && !path.startsWith('..') && !isAbsolute(path) ? path : undefined }
  if (within(ref.dir)) return `${ref.scope}:${ref.name}`
  const name = within(userRoot)?.split(/[\\/]/)[0]
  if (name && existsSync(join(userRoot, name, 'profile.ts'))) return `user:${name}`
  return `file:${createHash('sha256').update(file).digest('hex').slice(0, 12)}`
}

/** Whether `dir` is a profile folder at all: under the user's profiles, or a project's `.superego/profiles`. */
export function isProfileDir(ref: ProfileRef, userRoot: string): boolean {
  const parent = dirname(ref.dir)
  const ok = ref.scope === 'user' ? resolve(parent) === resolve(userRoot) : parent.endsWith(join('.superego', 'profiles'))
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
