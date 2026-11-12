// A profile's UI, loaded while the app runs. The daemon serves the profile's modules (types stripped, after checking the
// profile is allowed); here each one's imports are rewritten and it is loaded from a blob URL:
//   'react', 'react/jsx-runtime', 'superego/ui'  → this window's own copies, so a profile's components share its React
//   './other.ts'                          → that module of the profile, loaded the same way
// Their default exports are UI extensions, installed for that profile's threads only (see Registry.installProfile).
import { useEffect, useSyncExternalStore } from 'react'
import type { ProfileRef, ThreadInfo } from '@superego/protocol'
import { machine as client } from './client.ts'
import { useRegistry, type Registry, type UiExtension } from './extension.tsx'
import { hashModules, LOCAL, uiDecision, type UiGrant } from '../ui-trust.ts'

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

type Source = { path: string; code: string }

/** Fetch every module the entries need (following their relative imports), without running any of it. */
async function fetchModules(machine: string, profile: ProfileRef, entries: string[]): Promise<Source[]> {
  const names = await sharedModules()
  const fetched = new Map<string, Source>()
  const fetch = async (path: string): Promise<void> => {
    if (fetched.has(path)) return
    const module = await client(machine).call('profile.module', { ...profile, path })
    fetched.set(path, { path, code: module.code })
    for (const specifier of new Set([...module.code.matchAll(SPECIFIER)].map((m) => m[3]!))) {
      if (specifier.startsWith('.')) await fetch(new URL(specifier, `file:///p/${path}`).pathname.slice(3))
      else if (!names.has(specifier)) throw new Error(`${path} imports ${specifier}: a profile's UI can import 'react', 'react/jsx-runtime', 'superego/ui' and its own files`)
    }
  }
  for (const entry of entries) await fetch(entry)
  return [...fetched.values()]
}

/** Load a profile's UI extensions from the sources just fetched: each module from a blob URL, imports rewritten. */
async function loadProfileUi(profile: ProfileRef, sources: Source[], entries: string[]): Promise<UiExtension[]> {
  const names = await sharedModules()
  const code = new Map(sources.map((s) => [s.path, s.code]))
  const loaded = new Map<string, string>()
  const load = (path: string): string => {
    const existing = loaded.get(path)
    if (existing) return existing
    const source = code.get(path)!
    // Rewrite each import: shared names to this window's copies, relative paths to the profile's own modules.
    const rewritten = source.replace(SPECIFIER, (all, lead: string, quote: string, specifier: string) => {
      const target = names.get(specifier) ?? (specifier.startsWith('.') ? load(new URL(specifier, `file:///p/${path}`).pathname.slice(3)) : specifier)
      return `${lead}${quote}${target}${quote}`
    })
    const url = URL.createObjectURL(new Blob([`${rewritten}\n//# sourceURL=superego-profile://${profile.scope}/${profile.name}/${path}`], { type: 'text/javascript' }))
    loaded.set(path, url)
    return url
  }
  const extensions: UiExtension[] = []
  for (const entry of entries) {
    const module = await import(/* @vite-ignore */ load(entry)) as { default?: UiExtension }
    if (!module.default?.name || typeof module.default.setup !== 'function') throw new Error(`${entry} must export default defineUiExtension({ name, setup })`)
    extensions.push(module.default)
  }
  return extensions
}

/** A remote profile's UI that waits for an Allow: what the window would load, and from where. */
export type PendingUi = { key: string; machine: string; label: string; profile: ProfileRef; grant: UiGrant; entries: string[]; sources: Source[] }
const pending = new Map<string, PendingUi>()
const pendingListeners = new Set<() => void>()
let pendingList: PendingUi[] = []
function setPending(key: string, ui: PendingUi | undefined) {
  if (ui) pending.set(key, ui)
  else if (!pending.delete(key)) return
  pendingList = [...pending.values()]
  for (const listener of pendingListeners) listener()
}

/** The remote profile UIs waiting for an Allow in `profile`'s threads on `machine`. */
export function usePendingUi(machine: string, profile: ProfileRef | undefined): PendingUi | undefined {
  const all = useSyncExternalStore((listener) => { pendingListeners.add(listener); return () => { pendingListeners.delete(listener) } }, () => pendingList)
  return profile ? all.find((ui) => ui.key === `${machine}:${profile.dir}`) : undefined
}

/** Record the allow decision in the app, then install exactly the code that was shown. */
export async function allowProfileUi(registry: Registry, ui: PendingUi) {
  await window.superego.call('app', 'ui.trust.allow', ui.grant)
  setPending(ui.key, undefined)
  registry.installProfile(ui.profile.dir, await loadProfileUi(ui.profile, ui.sources, ui.entries))
}

/** What each profile's UI was installed at, so it reloads only when its files changed. */
const installed = new Map<string, string>()
const loading = new Map<string, Promise<void>>()

async function ensureProfileUi(registry: Registry, machine: string, profile: ProfileRef) {
  const key = `${machine}:${profile.dir}`
  const { hash: served, entries } = await client(machine).call('profile.ui', profile)
  if (installed.get(key) === served) return
  installed.set(key, served)
  setPending(key, undefined)
  if (!entries.length) return registry.installProfile(profile.dir, [])
  const sources = await fetchModules(machine, profile, entries)
  // The hash is of what was fetched here, not the daemon's say; the same sources are what gets loaded.
  const entry = (await window.superego.machines()).find((m) => m.id === machine)
  const identity = machine === LOCAL ? LOCAL : entry?.machine?.id
  if (!identity) { installed.delete(key); throw new Error(`${machine} has not said who it is yet`) }
  const grant: UiGrant = { machine: identity, dir: profile.dir, hash: await hashModules(sources) }
  const grants = machine === LOCAL ? [] : await window.superego.call('app', 'ui.trust.list', {}) as UiGrant[]
  if (uiDecision(machine, grant, grants) === 'ask') {
    registry.installProfile(profile.dir, [])
    return setPending(key, { key, machine, label: entry?.label ?? machine, profile, grant, entries, sources })
  }
  registry.installProfile(profile.dir, await loadProfileUi(profile, sources, entries))
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
