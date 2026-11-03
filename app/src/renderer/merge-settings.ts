// "All machines" in Settings: one view over the settings of every connected machine, for editing them together. It is
// a bulk edit, not a global default: machines that are offline or added later keep their own values.
import type { Json, SectionInfo, SettingInfo, SettingsSnapshot } from '@mu/protocol'

export type MergedSetting = SettingInfo & {
  /** The machines that have this setting; a change goes to each of them. */
  machines: string[]
  /** Whether those machines disagree on its value. */
  mixed: boolean
  value: Json
}
export type MergedSection = Omit<SectionInfo, 'settings'> & { settings: MergedSetting[] }

/**
 * The sections and settings of `snapshots` (by machine id), merged. A choice offers only what every machine having it
 * accepts, so one change is valid everywhere. Sections with a custom component are per-machine and left out, and so
 * are hidden settings and settings no machine could take the same value for.
 */
export function mergeSettings(snapshots: Record<string, SettingsSnapshot>): MergedSection[] {
  const sections = new Map<string, MergedSection>()
  for (const [machine, snapshot] of Object.entries(snapshots)) {
    for (const section of snapshot.sections) {
      if (section.ui) continue
      const merged = sections.get(section.id) ?? { ...section, settings: [] }
      sections.set(section.id, merged)
      for (const setting of section.settings) {
        if (setting.hidden) continue
        const value = snapshot.values[setting.key] ?? null
        const existing = merged.settings.find((s) => s.key === setting.key)
        if (!existing) {
          merged.settings.push({ ...setting, machines: [machine], mixed: false, value })
          continue
        }
        existing.machines.push(machine)
        if (JSON.stringify(existing.value) !== JSON.stringify(value)) existing.mixed = true
        if (existing.type === 'choice' && setting.type === 'choice') {
          existing.options = existing.options.filter((option) => setting.options.some((other) => other.value === option.value))
          existing.nullable = Boolean(existing.nullable && setting.nullable)
        }
      }
    }
  }
  return [...sections.values()]
    .map((section) => ({
      ...section,
      settings: section.settings.filter((s) => s.type !== 'choice' || s.options.length > 0 || s.nullable),
    }))
    .filter((section) => section.settings.length > 0)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}
