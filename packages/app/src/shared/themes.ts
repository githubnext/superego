// Themes for code and the terminal, as the app keeps them: which one is chosen for light and which for dark (app
// settings, Settings → Appearance), and the themes imported into it. The desktop keeps those as files in
// <dataDir>/themes/<id>.json (main/theme-files.ts), a browser in its own storage; both answer the same two actions,
// and list them as the Appearance section's data, so the window hears of a change as it hears of settings.
import { BUILTIN_THEMES, DEFAULT_THEME, checkTheme, type ImportedTheme, type Theme } from '@superego/ui/themes'
import type { Json } from '@superego/protocol'
import type { SettingSpec, SettingsRegistry } from '@superego/settings'

export const THEME_LIGHT = 'app.theme.light'
export const THEME_DARK = 'app.theme.dark'

export const THEME_SETTINGS: SettingSpec[] = [
  { key: THEME_LIGHT, title: 'Light theme', default: DEFAULT_THEME, type: { type: 'theme', appearance: 'light' } },
  { key: THEME_DARK, title: 'Dark theme', default: DEFAULT_THEME, type: { type: 'theme', appearance: 'dark' } },
]

/** A theme file that doesn't read: which, and why. */
export type ThemeProblem = { file: string; message: string }
/** The imported themes, as the Appearance section's data carries them. */
export type ImportedThemes = { themes: Theme[]; problems: ThemeProblem[] }

/** Where imported themes are kept: listed, added (replacing the one of that id) and removed. */
export type ThemeStore = {
  list(): ImportedThemes | Promise<ImportedThemes>
  save(theme: Theme): Promise<void>
  remove(id: string): Promise<void>
}

/** Ids no imported theme may take: Superego's and the built-ins'. */
const RESERVED = new Set([DEFAULT_THEME, ...BUILTIN_THEMES.map((theme) => theme.id)])

/** An imported theme's id, from its name: lowercase words with dashes, never one of the built-ins'. */
export function importedId(name: string): string {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
  return RESERVED.has(slug) ? `${slug}-imported` : slug
}

/** Whether an imported theme's id clashes with one of the app's own. */
export const reservedId = (id: string) => RESERVED.has(id)

/**
 * What the two theme actions do, wherever the themes are kept: `add` keeps an imported theme (one of the same name
 * replaces it) and returns it with its id; `remove` drops one, and a picker that had it goes back to Superego's.
 */
export function themeActions(store: ThemeStore, settings: SettingsRegistry) {
  return {
    async add({ theme }: { theme: Json }): Promise<Theme> {
      const given = theme as ImportedTheme | null
      const kept = checkTheme({ ...(given && typeof given === 'object' ? given : {}), id: importedId(String(given?.name ?? '')) }, 'Imported theme')
      await store.save(kept)
      settings.invalidate()
      return kept
    },
    async remove({ id }: { id: string }): Promise<null> {
      await store.remove(id)
      for (const key of [THEME_LIGHT, THEME_DARK]) if (settings.get(key) === id) await settings.set(key, DEFAULT_THEME)
      settings.invalidate()
      return null
    },
  }
}

/** Imported themes kept in memory, or in `storage` (a browser's): one JSON list under `key`. */
export function storedThemes(storage?: { get(): string | null; set(value: string): void }): ThemeStore {
  let themes: Theme[] = []
  const problems: ThemeProblem[] = []
  if (storage) {
    try {
      const kept: unknown = JSON.parse(storage.get() ?? '[]')
      for (const theme of Array.isArray(kept) ? kept : []) {
        try { themes.push(checkTheme(theme, 'A kept theme')) } catch (error) {
          console.error(error)
          problems.push({ file: String((theme as { id?: unknown })?.id ?? 'theme'), message: (error as Error).message })
        }
      }
    } catch (error) {
      console.error('The imported themes kept in this browser don’t read:', error)
      problems.push({ file: 'themes', message: (error as Error).message })
    }
  }
  const keep = () => storage?.set(JSON.stringify(themes))
  return {
    list: () => ({ themes, problems }),
    async save(theme) { themes = [...themes.filter((t) => t.id !== theme.id), theme]; keep() },
    async remove(id) { themes = themes.filter((t) => t.id !== id); keep() },
  }
}
