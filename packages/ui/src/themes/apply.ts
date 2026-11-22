// A light theme and a dark one, as the window's root takes them: each role the two give as light-dark(<light>, <dark>),
// the side a theme leaves out from the default (superego.ts). Diffs take their colours from the syntax roles `inserted`
// and `deleted`. Roles neither theme gives aren't set, so styles.css's own stay. Where the window matches the theme
// (`window`, Settings → Appearance), its own colours too (palette.ts), and the terminal sits on its ground.
import type { ColourToken } from '../tokens.ts'
import { SYNTAX_ROLES, TERMINAL_ROLES, type SyntaxRole, type TerminalRole, type Theme } from './format.ts'
import { PALETTE_TOKENS, accentText, uiPalette, windowAccent } from './palette.ts'
import { DEFAULTS } from './superego.ts'

/** Where a token's colour comes from in a theme; `window`: whether the window matches the theme. */
type Source = (theme: Theme, window: boolean) => string | undefined
const mix = (percent: number, of: Source): Source => (theme, window) => {
  const colour = of(theme, window)
  return colour && `color-mix(in srgb, ${colour} ${percent}%, transparent)`
}
const inserted: Source = (theme) => theme.syntax?.inserted
const deleted: Source = (theme) => theme.syntax?.deleted

/** Every token a theme colours, and where in a theme its colour comes from. */
const SOURCES: [ColourToken, Source][] = [
  ...SYNTAX_ROLES.map((role): [ColourToken, Source] => [`--superego-syntax-${role}`, (theme) => theme.syntax?.[role]]),
  // The terminal's ground and text: the window's (styles.css's) where the window matches the theme.
  ...TERMINAL_ROLES.map((role): [ColourToken, Source] => [`--superego-terminal-${role}`, (theme, window) =>
    window && (role === 'bg' || role === 'fg') ? undefined : theme.terminal?.[role]]),
  ['--superego-diff-added', inserted],
  ['--superego-diff-added-text', inserted],
  ['--superego-diff-added-bg', mix(12, inserted)],
  ['--superego-diff-edit-added-bg', mix(14, inserted)],
  ['--superego-diff-fence-added-bg', mix(14, inserted)],
  ['--superego-diff-removed', deleted],
  ['--superego-diff-removed-text', deleted],
  ['--superego-diff-removed-bg', mix(10, deleted)],
  ['--superego-diff-edit-removed-bg', mix(12, deleted)],
  ['--superego-diff-fence-removed-bg', mix(12, deleted)],
  // The window's own, where it matches the theme: derived from the theme's ground and text (palette.ts).
  ...PALETTE_TOKENS.map((token): [ColourToken, Source] => [token, (theme, window) => window ? uiPalette(theme)?.[token] : undefined]),
]

/** Every custom property `themeStyle` may set: what to clear before setting a new pair's. */
export const THEMED_PROPERTIES: readonly string[] = SOURCES.map(([token]) => token)

/**
 * The custom properties for `light` and `dark` together, to set on the root; those left out keep their defaults.
 * `window`: the window matches the themes, its own colours theirs.
 */
export function themeStyle(light: Theme, dark: Theme, window = false): Record<string, string> {
  const style: Record<string, string> = {}
  for (const [token, source] of SOURCES) {
    const [lightValue, darkValue] = [source(light, window), source(dark, window)]
    if (lightValue === undefined && darkValue === undefined) continue
    const [lightDefault, darkDefault] = DEFAULTS[token]!
    style[token] = `light-dark(${lightValue ?? lightDefault}, ${darkValue ?? darkDefault})`
  }
  return style
}

/**
 * The accent the two themes give, light and dark, and the text on it (`fallback` for one that gives none); none when
 * neither does. Where the window matches the themes, one with no accent of its own gives its blue.
 */
export function themeAccent(light: Theme, dark: Theme, fallback: string, window = false): { accent: string; text: string } | undefined {
  const accentOf = (theme: Theme) => window ? windowAccent(theme) : theme.accent
  const [l, d] = [accentOf(light), accentOf(dark)]
  if (!l && !d) return undefined
  const text = (theme: Theme, accent: string | undefined) => accent ? accentText(theme, accent) : '#ffffff'
  return { accent: `light-dark(${l ?? fallback}, ${d ?? fallback})`, text: `light-dark(${text(light, l)}, ${text(dark, d)})` }
}

/** A role's colour in `theme`, its default's where it gives none: for a preview drawn with its own colour-scheme. */
export function themeColor(theme: Theme, group: 'syntax' | 'terminal', role: string): string {
  const given = group === 'syntax' ? theme.syntax?.[role as SyntaxRole] : theme.terminal?.[role as TerminalRole]
  return given ?? DEFAULTS[`--superego-${group}-${role}` as ColourToken]![theme.appearance === 'light' ? 0 : 1]
}

