// The window's own colours from a theme's: its workbench colours (`ui`) where it has them, as it has them, and the rest
// derived from its ground and text (`ui.bg`/`ui.fg`, else the terminal's; Superego's text on a ground given alone) by a few fixed steps: each surface a step
// from the ground toward the text, each line a bigger one, secondary text most of the way (Superego's own steps,
// measured from styles.css). The theme's contrast is kept as it is: one that's low stays low.
// A theme with no ground (Superego's own, one with only code colours) colours nothing here but its accent, if it has one.
import type { ColourToken } from '../tokens.ts'
import type { Color, Theme, UiRole } from './format.ts'
import { isLight } from './import.ts'
import { DEFAULTS } from './superego.ts'

type Ground = { theme: Theme; bg: Color; fg: Color; dark: boolean }

/** `percent` of the text on the ground. */
const step = ({ bg, fg }: Ground, percent: number) => percent === 0 ? bg : `color-mix(in srgb, ${fg} ${percent}%, ${bg})`
/** `percent` of the text over whatever it's on. */
const tint = ({ fg }: Ground, percent: number) => `color-mix(in srgb, ${fg} ${percent}%, transparent)`
/** The theme's own colour for `role`, else `otherwise`. */
const own = (role: UiRole, otherwise: (g: Ground) => string) => (g: Ground) => g.theme.ui?.[role] ?? otherwise(g)
/** In light and in dark. */
const by = (light: (g: Ground) => string, dark: (g: Ground) => string) => (g: Ground) => (g.dark ? dark : light)(g)

const chrome = own('sidebar', by((g) => step(g, 6), (g) => step(g, 5)))
const link = (g: Ground) => g.theme.ui?.link ?? g.theme.terminal?.blue ?? accentOf(g.theme) ?? 'var(--superego-accent)'
const raised = own('raised', by((g) => g.bg, (g) => step(g, 8)))

/** Each token the palette sets, and how. */
const RULES: Partial<Record<ColourToken, (g: Ground) => string>> = {
  '--superego-bg': (g) => g.bg,
  '--superego-text': (g) => g.fg,
  '--superego-muted': own('muted', (g) => step(g, 62)),
  // Meta and placeholders: the theme's comments.
  '--superego-faint': (g) => g.theme.syntax?.comment ?? step(g, g.dark ? 38 : 40),
  // The window's side, and the rail a shade under it.
  '--superego-chrome': chrome,
  '--superego-sidebar-bg': chrome,
  '--superego-rail-bg': (g) => `color-mix(in srgb, #000 ${g.dark ? 13 : 3}%, ${chrome(g)})`,
  '--superego-rail-tab': (g) => `color-mix(in srgb, #000 ${g.dark ? 26 : 5}%, ${chrome(g)})`,
  // Wells, a pane's tab, what floats, fields and the composer.
  '--superego-surface': own('surface', (g) => step(g, 5)),
  '--superego-pane-tab': (g) => step(g, 3),
  '--superego-raised': raised,
  '--superego-composer': own('field', by((g) => g.bg, (g) => step(g, 4))),
  '--superego-field-bg': own('field', by((g) => g.bg, (g) => step(g, 6))),
  // Lines and frames.
  '--superego-line': own('border', (g) => step(g, 14)),
  '--superego-border': own('border', (g) => step(g, 20)),
  '--superego-field-edge': by((g) => step(g, 30), (g) => step(g, 28)),
  '--superego-track': by((g) => step(g, 18), (g) => step(g, 22)),
  // Controls.
  '--superego-control': by((g) => g.bg, (g) => step(g, 30)),
  '--superego-control-active': by((g) => step(g, 13), (g) => step(g, 41)),
  // Rows and quiet fills.
  '--superego-selected': own('selected', (g) => tint(g, 8)),
  '--superego-hover': own('hover', (g) => tint(g, 5)),
  '--superego-fill': (g) => tint(g, 6),
  '--superego-code-chip': (g) => tint(g, 7),
  // Links, and your messages tinted by them.
  '--superego-link': link,
  '--superego-bubble': (g) => `color-mix(in oklab, ${link(g)} ${g.dark ? 14 : 9}%, ${g.dark ? raised(g) : g.bg})`,
}

/** Every token `uiPalette` may set, the accent's too. */
export const PALETTE_TOKENS: readonly ColourToken[] = [...Object.keys(RULES) as ColourToken[], '--superego-accent-base', '--superego-accent-text']

/** A theme's accent: its own, else (with a ground of its own) its blue. */
function accentOf(theme: Theme): Color | undefined {
  if (theme.accent) return theme.accent
  if (!(theme.ui?.bg ?? theme.terminal?.bg)) return undefined
  return theme.terminal?.blue ?? theme.syntax?.function
}

/** The window's colours for `theme`, by token: none for a theme with no ground or accent of its own. */
export function uiPalette(theme: Theme): Partial<Record<ColourToken, string>> {
  const palette: Partial<Record<ColourToken, string>> = {}
  const dark = theme.appearance === 'dark'
  const bg = theme.ui?.bg ?? theme.terminal?.bg
  // A ground with no text given (a terminal theme with a background alone): Superego's text on it.
  const fg = theme.ui?.fg ?? theme.terminal?.fg ?? DEFAULTS['--superego-text']![dark ? 1 : 0]
  if (bg) {
    const ground: Ground = { theme, bg, fg, dark }
    for (const [token, rule] of Object.entries(RULES) as [ColourToken, (g: Ground) => string][]) palette[token] = rule(ground)
  }
  const accent = accentOf(theme)
  if (accent) {
    palette['--superego-accent-base'] = accent
    // Text on it: the theme's, else white, or on a light accent, the theme's dark (its ground in the dark, its text in the light).
    palette['--superego-accent-text'] = theme.ui?.['accent-text'] ?? (isLight(accent) ? (dark && bg ? bg : fg) : '#ffffff')
  }
  return palette
}
