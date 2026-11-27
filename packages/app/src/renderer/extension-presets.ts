// A machine's extensions as Settings → Extensions and setup show them: its preset (Core or Full), each optional
// extension's switch against what the preset says of it, and Custom (a preset and the user's changes) said in a line.
// Experimental extensions are in no preset: their switches never make it Custom.
import { EXTENSIONS_PRESET, extensionSwitch, type ExtensionAbout, type ExtensionGroup, type ExtensionPreset, type SettingsSnapshot } from '@superego/protocol'

/** An optional extension on a machine: what it is (its `about`), whether it's on, and whether its preset turns it on. */
export type ExtensionRow = Pick<ExtensionAbout, 'name' | 'group' | 'core' | 'experimental'> & { title: string; description?: string; on: boolean; preset: boolean }
/** What a machine starts from, and its optional extensions. */
export type Extensions = { preset: ExtensionPreset; rows: ExtensionRow[] }
/** What the machine's switches add up to: a preset as it is, or `custom`, one with changes. */
export type Picked = ExtensionPreset | 'custom'

/** A machine's extensions, from its settings (the `extensions` section's rows and the switches' values). */
export function extensionsOf(snapshot: SettingsSnapshot | undefined): Extensions | undefined {
  const section = snapshot?.sections.find((s) => s.id === 'extensions')
  if (!section || !Array.isArray(section.data)) return undefined
  const rows = (section.data as Pick<ExtensionAbout, 'name' | 'title' | 'description' | 'group' | 'core' | 'experimental'>[]).flatMap((about): ExtensionRow[] => {
    const setting = section.settings.find((s) => s.key === extensionSwitch(about.name))
    if (!setting) return []
    return [{ ...about, title: about.title ?? about.name, on: snapshot!.values[setting.key] === true, preset: setting.default === true }]
  })
  return { preset: snapshot!.values[EXTENSIONS_PRESET] === 'core' ? 'core' : 'full', rows }
}

/** The switches that differ from the preset: never an experimental one's, which no preset has. */
export const changes = (rows: ExtensionRow[]) => rows.filter((row) => !row.experimental && row.on !== row.preset)

/** The preset as the switches are now, or Custom when one differs from it. */
export const picked = ({ preset, rows }: Extensions): Picked => changes(rows).length ? 'custom' : preset

/** `a`, `a and b`, `a, b and c`. */
export const and = (words: string[]) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

export const PRESET_TITLES: Record<ExtensionPreset, string> = { core: 'Core', full: 'Full' }

/** Custom, said: the preset and what's changed, "Full without GitHub", "Core with Terminal"; past two, how many. */
export function customLine({ preset, rows }: Extensions): string {
  const changed = changes(rows)
  const name = PRESET_TITLES[preset]
  if (changed.length > 2) return `${name}, ${changed.length} changed`
  const off = changed.filter((row) => !row.on).map((row) => row.title)
  const on = changed.filter((row) => row.on).map((row) => row.title)
  return `${name}${off.length ? ` without ${and(off)}` : ''}${on.length ? `${off.length ? ',' : ''} with ${and(on)}` : ''}`
}

/** The extensions a preset's line names first, the best known: the rest are counted. */
const NAMED: Record<ExtensionPreset, string[]> = {
  core: ['coding-tools', 'git', 'panes', 'ego'],
  full: ['terminal', 'browser', 'github', 'schedules'],
}

/** What a preset turns on, in a line: Core's own, "Coding tools, Git, Panes, Ego and 3 more"; Full's past Core's, "Adds …". */
export function presetLine(preset: ExtensionPreset, rows: ExtensionRow[]): string {
  const listed = rows.filter((row) => !row.experimental && (preset === 'core' ? row.core : !row.core))
  const named = NAMED[preset].flatMap((name) => listed.find((row) => row.name === name)?.title ?? [])
  if (!listed.length) return preset === 'full' ? 'The same as Core' : 'None'
  const rest = listed.length - named.length
  const line = rest > 0 ? `${named.join(', ')} and ${rest} more` : and(listed.map((row) => row.title))
  return preset === 'full' ? `Adds ${line}` : line
}

/** Settings → Extensions' groups, in order: the four of `ExtensionGroup`, then those that say none, then the experimental. */
export const GROUPS: { id: ExtensionGroup | 'other' | 'experimental'; title: string }[] = [
  { id: 'beside', title: 'Beside a thread' },
  { id: 'agent', title: 'The agent' },
  { id: 'thread', title: 'In the thread' },
  { id: 'around', title: 'Getting around' },
  { id: 'other', title: 'Other' },
  { id: 'experimental', title: 'Experimental' },
]
export const groupOf = (row: ExtensionRow): (typeof GROUPS)[number]['id'] => row.experimental ? 'experimental' : row.group ?? 'other'

/** The rows by group, in the groups' order, leaving out empty ones. */
export const grouped = (rows: ExtensionRow[]) =>
  GROUPS.map((group) => ({ ...group, rows: rows.filter((row) => groupOf(row) === group.id) })).filter((group) => group.rows.length)
