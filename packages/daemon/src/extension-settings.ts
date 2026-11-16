// What Settings shows about a machine's extensions and profiles. Extensions: a switch for each optional one (the
// core's own agent parts and the bundled extensions), off for every thread here. Required ones aren't listed: they're
// part of what the app is. Profiles: each one threads here can start as, what it is and what it changes.
import type { ExtensionAbout, Json } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { hashProfile, loadProfile, type ProfileRef, type Allowances } from './profiles.ts'

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

/** A profile as Settings lists it. Only one that may run is loaded (its code runs), to tell what it changes. */
export async function describeProfile(ref: ProfileRef, userRoot: string, allowances: Allowances): Promise<Json> {
  let allowed: boolean
  try { allowed = await allowances.allowed(ref, hashProfile(ref.dir)) } catch (error) { return { ...ref, allowed: false, error: (error as Error).message } }
  if (!allowed) return { ...ref, allowed }
  try {
    const { spec } = await loadProfile(ref, userRoot, allowances)
    return {
      ...ref, allowed,
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.extends ? { extends: spec.extends } : {}),
      extensions: spec.extensions?.length ?? 0,
      ui: spec.ui?.length ?? 0,
      without: spec.without ?? [],
    }
  } catch (error) {
    return { ...ref, allowed, error: (error as Error).message }
  }
}
