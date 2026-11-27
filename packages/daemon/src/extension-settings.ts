// What Settings shows about a machine's extensions and profiles. Extensions: the preset the machine starts from (Core or
// Full), and a switch for each optional one (the core's own agent parts and the bundled extensions), off for every
// thread here. Required ones aren't listed: they're part of what the app is. Profiles: each one threads here can start
// as, what it is and what it changes.
import { EXTENSIONS_PRESET, extensionSwitch, onByDefault, type ExtensionAbout, type ExtensionPreset, type Json } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { hashProfile, loadProfile, type Allowances, type ProfileKeys, type ProfileRef, type UserRoot } from './profiles.ts'

/**
 * The machine's preset (`extensions.preset`, Full unless picked) and one switch per optional extension,
 * `extensions.<name>`: what the preset says of it until the user changes it, so one that's new follows the preset; an
 * experimental one, in no preset, says its own (on unless `'off'`). Both drawn by the section's own component
 * (`extensions`), from the rows it's given. A switch applies from a thread's next message.
 */
export function registerExtensionSettings(settings: SettingsRegistry, extensions: ExtensionAbout[]) {
  const optional = extensions.filter((e) => !e.required)
  const preset = () => settings.get<ExtensionPreset>(EXTENSIONS_PRESET)
  return settings.register({
    id: 'extensions', title: 'Extensions', order: 70, ui: 'extensions',
    description: 'What threads here are given. A profile can do without more.',
    data: () => optional.map(({ name, title, description, group, core, experimental }): Json => ({
      name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(group ? { group } : {}), ...(core ? { core } : {}), ...(experimental ? { experimental } : {}),
    })),
    settings: [
      {
        key: EXTENSIONS_PRESET, title: 'Start from', default: 'full', hidden: () => true,
        type: { type: 'choice', options: [{ value: 'core', label: 'Core' }, { value: 'full', label: 'Full' }] },
      },
      ...optional.map((about) => ({
        key: extensionSwitch(about.name), title: about.title ?? about.name, ...(about.description ? { description: about.description } : {}),
        default: () => onByDefault(about, preset()), type: { type: 'boolean' as const }, hidden: () => true,
      })),
    ],
  })
}

/**
 * Start from `preset` again: it, and none of the user's changes but to experimental extensions', which no preset has.
 * Saved as one change.
 */
export function pickPreset(settings: SettingsRegistry, extensions: ExtensionAbout[], preset: ExtensionPreset) {
  const reset = extensions.filter((e) => !e.required && !e.experimental).map((e) => [extensionSwitch(e.name), undefined] as const)
  return settings.change({ [EXTENSIONS_PRESET]: preset, ...Object.fromEntries(reset) })
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
