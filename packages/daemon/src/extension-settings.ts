// What Settings shows about a machine's extensions and profiles. Extensions: a switch for each that gives the agents
// something (the core's own parts and the bundled extensions'), off for every thread here. Profiles: each one threads
// here can start as, what it is and what it changes.
import type { Json } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { hashProfile, loadProfile, type ProfileRef, type Trust } from './profiles.ts'

/** The core's own agent parts, named for people. */
const CORE: Record<string, { title: string; description: string }> = {
  'coding-tools': { title: 'Coding tools', description: 'Read, write and edit files, and run commands.' },
  panes: { title: 'Panes', description: 'Open panes beside a thread: diffs, previews, files.' },
  skills: { title: 'Skills', description: 'Know the shared skills, and use them when they fit.' },
  'agents-md': { title: 'AGENTS.md', description: 'Follow the standing instructions in AGENTS.md files.' },
  threads: { title: 'Threads', description: 'Start threads of their own, and read and message others.' },
}

export type ExtensionAbout = { name: string; title?: string | undefined; description?: string | undefined }

/** One switch per extension, `extensions.<name>`, on unless turned off. Turning one off applies from a thread's next message. */
export function registerExtensionSettings(settings: SettingsRegistry, extensions: ExtensionAbout[]) {
  return settings.register({
    id: 'extensions', title: 'Extensions', order: 70,
    description: 'What agents here are given. A profile can do without more.',
    settings: extensions.map(({ name, title, description }) => {
      const about = CORE[name]
      const text = description ?? about?.description
      return { key: `extensions.${name}`, title: title ?? about?.title ?? name, ...(text ? { description: text } : {}), default: true, type: { type: 'boolean' as const } }
    }),
  })
}

/** A profile as Settings lists it. Only one that may run is loaded (its code runs), to tell what it changes. */
export async function describeProfile(ref: ProfileRef, userRoot: string, trust: Trust): Promise<Json> {
  const allowed = await trust.allowed(ref, hashProfile(ref.dir))
  if (!allowed) return { ...ref, allowed }
  try {
    const { spec } = await loadProfile(ref, userRoot, trust)
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
