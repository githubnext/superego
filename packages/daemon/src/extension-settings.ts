// What Settings shows about a machine's extensions and profiles. Extensions: a switch for each optional one (the
// core's own agent parts and the bundled extensions), off for every thread here. Required ones aren't listed: they're
// part of what the app is. Profiles: each one threads here can start as, what it is and what it changes.
import type { ExtensionAbout, Json } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { hashProfile, loadProfile, type Allowances, type ProfileKeys, type ProfileRef, type UserRoot } from './profiles.ts'

/** One switch per optional extension, `extensions.<name>`, on unless turned off. It applies from a thread's next message. */
export function registerExtensionSettings(settings: SettingsRegistry, extensions: ExtensionAbout[]) {
  return settings.register({
    id: 'extensions', title: 'Extensions', order: 70,
    description: 'What threads here are given. A profile can do without more.',
    settings: extensions.filter((e) => !e.required).map(({ name, title, description }) => ({
      key: `extensions.${name}`, title: title ?? name, ...(description ? { description } : {}), default: true, type: { type: 'boolean' as const },
    })),
  })
}

/**
 * A profile as Settings lists it. Only one that may run is loaded (its code runs), to tell what it changes. `problems`:
 * what's wrong with how it's found (it shadows another of its name), and once loaded, with it.
 */
export async function describeProfile(ref: ProfileRef, roots: UserRoot[], allowances: Allowances, keys: ProfileKeys, found: string[] = []): Promise<Json> {
  const about = { ...ref, ...(found.length ? { problems: found } : {}) }
  let allowed: boolean
  try { allowed = await allowances.allowed(ref, await hashProfile(ref.dir)) } catch (error) { return { ...about, allowed: false, error: (error as Error).message } }
  if (!allowed) return { ...about, allowed }
  try {
    const { spec, problems } = await loadProfile(ref, roots, allowances, keys)
    const all = [...found, ...problems]
    return {
      ...ref, allowed,
      ...(all.length ? { problems: all } : {}),
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.extends ? { extends: spec.extends } : {}),
      extensions: spec.extensions?.length ?? 0,
      ui: spec.ui?.length ?? 0,
      without: spec.without ?? [],
    }
  } catch (error) {
    return { ...about, allowed, error: (error as Error).message }
  }
}
