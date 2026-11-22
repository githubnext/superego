// Themes in the window: every theme there is to choose (Superego's, the built-ins, those imported and those extensions
// bring), the pair chosen applied to the root (code, diffs, the terminal, the accent unless the user chose one, and
// the window's own colours where it matches them),
// and Settings → Appearance's parts: a picker for each, a sample of both, and importing.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Button, Select } from '@superego/ui'
import {
  BUILTIN_THEMES, DEFAULT_THEME, THEMED_PROPERTIES, importTheme, superegoTheme, themeAccent, themeColor, themeStyle, type Appearance, type Theme,
} from '@superego/ui/themes'
import type { Json } from '@superego/protocol'
import { ACCENT, APP, DEFAULT_ACCENT } from '../shared/app-settings.ts'
import { THEME_DARK, THEME_LIGHT, THEME_WINDOW, type ImportedThemes } from '../shared/themes.ts'
import { useSettings } from './client.ts'
import { scopeIsOn, useRegistry, type Registry } from './registry.tsx'

/** A theme to choose, and the group the pickers list it in (none: the app's own). */
export type ThemeChoice = { theme: Theme; group?: string }

const NONE: ImportedThemes = { themes: [], problems: [] }

/** Where an extension's themes are listed: under its title, a profile's with the profile's name. */
function groupOf(registry: Registry, owner: Registry['themes'][number]['owner']) {
  const title = registry.extensions.find((e) => e.name === owner.extension)?.title ?? owner.extension
  if (!owner.profile) return title
  const [machine = '', dir = ''] = owner.profile.split('\u0000')
  const profile = dir.split('/').filter(Boolean).at(-1) ?? dir
  return `${title} (${profile} profile${scopeIsOn(owner.profile, 'local') ? '' : ` on ${machine}`})`
}

/** Every theme there is, the app's own first, then those imported, then the extensions'; and the imports that failed. */
export function useThemes(): { choices: ThemeChoice[]; imported: ImportedThemes } {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const snapshot = useSettings(APP, true)
  const imported = (snapshot?.sections.find((s) => s.id === 'appearance')?.data as ImportedThemes | undefined) ?? NONE
  const choices: ThemeChoice[] = [
    { theme: superegoTheme('light') }, { theme: superegoTheme('dark') },
    ...BUILTIN_THEMES.map((theme) => ({ theme })),
    ...imported.themes.map((theme) => ({ theme, group: 'Imported' })),
  ]
  // One per id: the first an extension (or a profile, on another machine) brings.
  for (const theme of registry.themes) {
    if (!choices.some((c) => c.theme.id === theme.id)) choices.push({ theme, group: groupOf(registry, theme.owner) })
  }
  return { choices, imported }
}

/** The theme of `id` for `appearance`, or Superego's when there's none (`missing` then, unless it's Superego's). */
export function themeFor(choices: ThemeChoice[], id: unknown, appearance: Appearance): { theme: Theme; missing?: string } {
  const found = choices.find((c) => c.theme.id === id && c.theme.appearance === appearance)?.theme
  if (found) return { theme: found }
  return { theme: superegoTheme(appearance), ...(typeof id === 'string' && id !== DEFAULT_THEME ? { missing: id } : {}) }
}

/**
 * The themes chosen for light and dark (Superego's for one that isn't there), whether the window matches them, and the
 * accent to show: the user's (the setting), or while that's left at its default, the themes' own if they have one
 * (`accentThemed`), and the text on it. One the browser can't read is none: styles.css's.
 */
export function useChosenThemes() {
  const { choices } = useThemes()
  const values = useSettings(APP, true)?.values
  const light = themeFor(choices, values?.[THEME_LIGHT], 'light').theme
  const dark = themeFor(choices, values?.[THEME_DARK], 'dark').theme
  const window = values?.[THEME_WINDOW] === true
  const chosen = values?.[ACCENT]
  const valid = typeof chosen === 'string' && CSS.supports('color', chosen) ? chosen : undefined
  const themed = valid === undefined || valid === DEFAULT_ACCENT ? themeAccent(light, dark, DEFAULT_ACCENT, window) : undefined
  return { light, dark, window, accent: themed?.accent ?? valid, accentText: themed?.text, accentThemed: Boolean(themed) }
}

/**
 * Apply the chosen themes to the window's root, in its style: each themed colour as light-dark() (read by code's
 * highlighting, diffs, the terminal, which watches the root's style, and the window, where it matches the themes),
 * and the accent. At once, with no reload.
 */
export function useThemeStyle() {
  const { light, dark, window, accent, accentText } = useChosenThemes()
  const style = themeStyle(light, dark, window)
  const key = JSON.stringify(style)
  useEffect(() => {
    const root = document.documentElement.style
    for (const property of THEMED_PROPERTIES) if (!(property in style)) root.removeProperty(property)
    for (const [property, value] of Object.entries(style)) root.setProperty(property, value)
  }, [key])
  useEffect(() => {
    const root = document.documentElement.style
    if (accent) root.setProperty('--superego-accent-base', accent)
    else root.removeProperty('--superego-accent-base')
    if (accentText) root.setProperty('--superego-accent-text', accentText)
    else root.removeProperty('--superego-accent-text')
  }, [accent, accentText])
}

/** A theme in a few colours on its terminal's background, drawn as its appearance whatever the window's. */
function Swatch({ theme }: { theme: Theme }) {
  const syntax = (role: string) => themeColor(theme, 'syntax', role)
  return (
    <span className="theme-swatch" aria-hidden style={{ colorScheme: theme.appearance, background: themeColor(theme, 'terminal', 'bg') }}>
      {['keyword', 'string', 'function', 'type', 'number'].map((role) => <span key={role} style={{ background: syntax(role) }} />)}
    </span>
  )
}

/** Settings → Appearance's picker for one appearance: the themes of it, by group, and the chosen one's swatch. */
export function ThemePicker({ label, appearance, value, disabled, onChange }: {
  label: string; appearance: Appearance; value: Json; disabled: boolean; onChange(value: string): void
}) {
  const { choices } = useThemes()
  const { theme, missing } = themeFor(choices, value, appearance)
  const options = choices.filter((c) => c.theme.appearance === appearance).map(({ theme, group }) => ({ value: theme.id, label: theme.name, ...(group ? { group } : {}) }))
  return (
    <span className="theme-picker">
      <Swatch theme={theme} />
      <Select aria-label={label} disabled={disabled} value={missing ?? theme.id} onChange={(id) => { if (id) onChange(id) }}
        options={missing ? [{ value: missing, label: `${missing} (not found: Superego shown)` }, ...options] : options} />
    </span>
  )
}

/** Code and a terminal line in the theme the window shows for `appearance`. */
function Sample({ appearance }: { appearance: Appearance }) {
  const s = (role: string) => ({ color: `var(--superego-syntax-${role})` }) satisfies CSSProperties
  const t = (role: string) => ({ color: `var(--superego-terminal-${role})` }) satisfies CSSProperties
  return (
    <div className="theme-sample" style={{ colorScheme: appearance }} aria-label={`${appearance === 'light' ? 'Light' : 'Dark'} theme sample`}>
      <pre className="theme-sample__code">
        <span style={s('comment')}>{'// Split the bill'}</span>{'\n'}
        <span style={s('keyword')}>export function</span> <span style={s('function')}>split</span>(<span style={s('definition')}>total</span>: <span style={s('type')}>number</span>, <span style={s('definition')}>people</span> = <span style={s('number')}>3</span>) {'{'}{'\n'}
        {'  '}<span style={s('keyword')}>return</span> {'{ '}<span style={s('attribute')}>each</span>: total / people, <span style={s('attribute')}>note</span>: <span style={s('string')}>"thanks!"</span>{' }'}{'\n'}
        {'}'}
      </pre>
      <pre className="theme-sample__terminal" style={t('fg')}>
        <span style={t('blue')}>~/ledger</span> <span style={t('magenta')}>main</span> <span style={t('green')}>❯</span> ls{'\n'}
        <span style={t('cyan')}>src</span>  <span style={t('yellow')}>notes.md</span>  <span style={t('red')}>old.log</span>  <span style={t('bright-black')}>.git</span>
      </pre>
    </div>
  )
}

/**
 * Under the pickers: both themes as they look, the imported ones (each to remove), the theme files that don't read,
 * and importing one: a VS Code theme, a Ghostty theme or an iTerm2 `.itermcolors` file.
 */
export function ThemeTools() {
  const dispatch = useRegistry().router.dispatch
  const { imported } = useThemes()
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const run = (id: string, params: Record<string, unknown>) => dispatch(id, params, { machine: APP, source: 'settings' })
  const pick = async (file: File) => {
    setError(undefined)
    try {
      const theme = importTheme(await file.text(), file.name)
      const kept = await run('app.themes.add', { theme }) as Theme
      // Imported to be used: it's chosen for its appearance.
      await run('app.settings.set', { key: kept.appearance === 'light' ? THEME_LIGHT : THEME_DARK, value: kept.id })
    } catch (e) {
      console.error(`Importing the theme ${file.name}:`, e)
      setError(`${file.name}: ${(e as Error).message}`)
    }
  }
  const remove = (theme: Theme) => {
    setError(undefined)
    run('app.themes.remove', { id: theme.id }).catch((e: Error) => {
      console.error(`Removing the theme ${theme.id}:`, e)
      setError(e.message)
    })
  }
  return (
    <div className="theme-tools">
      <div className="theme-samples"><Sample appearance="light" /><Sample appearance="dark" /></div>
      {imported.themes.map((theme) => (
        <div className="setting" key={theme.id}>
          <div className="setting__label">
            <div>{theme.name}</div>
            <div className="settings__note">Imported, {theme.appearance}</div>
          </div>
          <div className="setting__control"><Button onClick={() => remove(theme)}>Remove</Button></div>
        </div>
      ))}
      {imported.problems.map((problem) => <p key={problem.file} className="setting__error">{problem.file}: {problem.message}</p>)}
      {error && <p className="setting__error">{error}</p>}
      <div className="theme-tools__import">
        <Button onClick={() => input.current?.click()}>Import theme…</Button>
        <span className="settings__note">VS Code themes, Ghostty and iTerm2 colour files.</span>
        <input ref={input} type="file" hidden onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void pick(file)
        }} />
      </div>
    </div>
  )
}
