// A profile's UI as a client receives it from a machine: every module its entries need, walked import by import (read
// as the daemon reads a profile's modules: @superego/protocol's importsOf), and a hash of exactly that. A machine other
// than this computer's own decides nothing about whether its profile's UI runs here: the window (or the CLI) hashes
// what it received and runs it only once this computer allowed that hash (see ui-allowed.ts). No Node imports: the
// renderer uses this too.
import { importsOf, type ProfileRef } from '@superego/protocol'

export type ProfileModule = { path: string; code: string }

/** A profile's UI: its entries, and each module by the specifier it was asked for (relative to the profile). */
export type ProfileUiSources = { entries: string[]; modules: Map<string, ProfileModule> }

/** What a profile's modules may import by name; anything else is one of its own files, by a relative path. */
export const SHARED_MODULES = ['react', 'react/jsx-runtime', 'superego/ui', 'superego/unstable']

/** `specifier`, imported by the module at `from`, as a path in the profile. */
export const resolveSpecifier = (from: string, specifier: string) => new URL(specifier, `file:///p/${from}`).pathname.slice(3)

/** The specifiers a module imports, each once, read as the daemon reads a profile's modules (importsOf). */
const specifiersOf = (module: ProfileModule) => [...new Set(importsOf(module.code, module.path).map((i) => i.specifier))]

/** A module's code with each import pointed elsewhere: `to` of its specifier. */
export function pointImports(module: ProfileModule, to: (specifier: string) => string): string {
  let code = '', at = 0
  for (const { specifier, start, end } of importsOf(module.code, module.path)) { code += module.code.slice(at, start) + to(specifier); at = end }
  return code + module.code.slice(at)
}

/** Fetch every module `entries` need, by `fetch` (the machine's `profile.module`). Refuses imports a profile can't make. */
export async function collectProfileUi(entries: string[], fetch: (path: string) => Promise<ProfileModule>): Promise<ProfileUiSources> {
  const modules = new Map<string, ProfileModule>()
  const visit = async (path: string): Promise<void> => {
    if (modules.has(path)) return
    const module = await fetch(path)
    modules.set(path, module)
    for (const specifier of specifiersOf(module)) {
      if (SHARED_MODULES.includes(specifier)) continue
      if (!specifier.startsWith('.')) throw Object.assign(new Error(`${module.path} imports ${specifier}: a profile's UI can import ${SHARED_MODULES.map((m) => `'${m}'`).join(', ')} and its own files`), { kind: 'invalid' })
      await visit(resolveSpecifier(module.path, specifier))
    }
  }
  for (const entry of entries) await visit(entry)
  return { entries, modules }
}

/** Each file of a profile's UI once, by its path in the profile, with its size in bytes (as served: types stripped). */
export function filesOf(sources: ProfileUiSources): { path: string; size: number }[] {
  const files = new Map<string, number>()
  for (const module of sources.modules.values()) files.set(module.path, new TextEncoder().encode(module.code).length)
  return [...files].map(([path, size]) => ({ path, size })).sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * A SHA-256 of exactly what would run: the entries, and every module (by the specifier asked and the file it is) with
 * its code. Any change to any of them is another hash.
 */
export async function hashProfileUi(sources: ProfileUiSources): Promise<string> {
  const modules = [...sources.modules].map(([asked, m]) => [asked, m.path, m.code]).sort((a, b) => a[0]!.localeCompare(b[0]!))
  const bytes = new TextEncoder().encode(JSON.stringify({ entries: sources.entries, modules }))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A profile's UI allowed to run in this computer's window: from that machine, that profile, those exact sources. */
export type AllowedUi = {
  /** The machine as this computer knows it (its id in machines.json). */
  machine: string
  profile: ProfileRef
  hash: string
  files: { path: string; size: number }[]
  /** When it was allowed (ms). */
  at: number
}

export const isAllowed = (list: AllowedUi[], machine: string, dir: string, hash: string) =>
  list.some((a) => a.machine === machine && a.profile.dir === dir && a.hash === hash)
