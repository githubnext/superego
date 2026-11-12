// A profile's UI, loaded while the app runs. The daemon serves the profile's modules (types stripped, after checking the
// profile is allowed); here each one's imports are rewritten and it is loaded from a blob URL:
//   'react', 'react/jsx-runtime', 'superego/ui'  → this window's own copies, so a profile's components share its React
//   './other.ts'                          → that module of the profile, loaded the same way
// Their default exports are UI extensions, installed for that profile's threads only (see Registry.installProfile).
import { useEffect, useSyncExternalStore } from 'react'
import type { ProfileRef, ThreadInfo } from '@superego/protocol'
import { machine as client } from './client.ts'
import { useRegistry, type Registry, type UiExtension } from './extension.tsx'

/** What a profile's modules import by name: built on first use, from this window's own modules. */
let shared: Promise<Map<string, string>> | undefined
function sharedModules() {
  return shared ??= (async () => {
    const [react, jsx, ui, kit] = await Promise.all([import('react'), import('react/jsx-runtime'), import('./index.tsx'), import('@superego/ui')])
    const superego = { ...kit, ...ui, h: react.createElement, Fragment: react.Fragment }
    const g = globalThis as { __superegoShared?: Record<string, Record<string, unknown>> }
    g.__superegoShared = { react: { ...react }, 'react/jsx-runtime': { ...jsx }, 'superego/ui': superego }
    const urls = new Map<string, string>()
    for (const [name, exports] of Object.entries(g.__superegoShared)) {
      const names = Object.keys(exports).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default')
      const source = `const m = globalThis.__superegoShared[${JSON.stringify(name)}];\nexport default m.default ?? m;\n${names.map((key) => `export const ${key} = m.${key};`).join('\n')}\n`
      urls.set(name, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
    }
    return urls
  })()
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\2/g

/** Load a profile's UI extensions from `machine`: every module its entries need, each from a blob URL. */
async function loadProfileUi(machine: string, profile: ProfileRef, entries: string[]): Promise<UiExtension[]> {
  const names = await sharedModules()
  const loaded = new Map<string, Promise<string>>()
  const load = (path: string): Promise<string> => {
    const existing = loaded.get(path)
    if (existing) return existing
    const url = (async () => {
      const module = await client(machine).call('profile.module', { ...profile, path })
      // Rewrite each import: shared names to this window's copies, relative paths to the profile's own modules.
      const specifiers = [...module.code.matchAll(SPECIFIER)].map((m) => m[3]!)
      const targets = new Map<string, string>()
      for (const specifier of new Set(specifiers)) {
        if (names.has(specifier)) targets.set(specifier, names.get(specifier)!)
        else if (specifier.startsWith('.')) targets.set(specifier, await load(new URL(specifier, `file:///p/${module.path}`).pathname.slice(3)))
        else throw new Error(`${module.path} imports ${specifier}: a profile's UI can import 'react', 'react/jsx-runtime', 'superego/ui' and its own files`)
      }
      const code = module.code.replace(SPECIFIER, (all, lead: string, quote: string, specifier: string) => `${lead}${quote}${targets.get(specifier) ?? specifier}${quote}`)
      return URL.createObjectURL(new Blob([`${code}\n//# sourceURL=superego-profile://${profile.scope}/${profile.name}/${module.path}`], { type: 'text/javascript' }))
    })()
    loaded.set(path, url)
    return url
  }
  const extensions: UiExtension[] = []
  for (const entry of entries) {
    const module = await import(/* @vite-ignore */ await load(entry)) as { default?: UiExtension }
    if (!module.default?.name || typeof module.default.setup !== 'function') throw new Error(`${entry} must export default defineUiExtension({ name, setup })`)
    extensions.push(module.default)
  }
  return extensions
}

/** What each profile's UI was installed at, so it reloads only when its files changed. */
const installed = new Map<string, string>()
const loading = new Map<string, Promise<void>>()

async function ensureProfileUi(registry: Registry, machine: string, profile: ProfileRef) {
  const key = `${machine}:${profile.dir}`
  const { hash, entries } = await client(machine).call('profile.ui', profile)
  if (installed.get(key) === hash) return
  installed.set(key, hash)
  registry.installProfile(machine, profile, entries.length ? await loadProfileUi(machine, profile, entries) : [])
}

/** Load the UI of `thread`'s profile into the registry (once per version of its files), and redraw when it lands. */
export function useProfileUi(machine: string, thread: ThreadInfo) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const profile = thread.profile
  useEffect(() => {
    if (!profile) return
    const key = `${machine}:${profile.dir}`
    if (loading.has(key)) return
    const done = ensureProfileUi(registry, machine, profile).catch((error) => console.error(`The ${profile.name} profile's UI didn't load`, error))
      .finally(() => loading.delete(key))
    loading.set(key, done)
  }, [machine, profile?.dir, thread.activeAt])
}
