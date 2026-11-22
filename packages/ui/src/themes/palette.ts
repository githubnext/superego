// The window's own colours from a theme's: its ground and its text (`ui.bg`/`ui.fg`, else the terminal's), and the
// workbench colours it has (`ui`). Every surface is a step from the ground toward the text, every line a bigger one,
// secondary text most of the way: the same few rules for every theme, Superego's own steps measured from styles.css.
// A step that wouldn't stand out enough from the ground on a low-contrast theme is taken further, until it does.
// A theme with no ground (Superego's own, one with only code colours) colours nothing here: styles.css's stay.
import type { ColourToken } from '../tokens.ts'
import type { Color, Theme } from './format.ts'

type Rgba = [r: number, g: number, b: number, a: number]

/** A #rgb(a) or #rrggbb(aa) colour's channels, 0–1; undefined for anything else (a colour function). */
export function parseHex(colour: string | undefined): Rgba | undefined {
  const hex = colour?.trim().match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (!hex || ![3, 4, 6, 8].includes(hex.length)) return undefined
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
  const at = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255
  return [at(0), at(1), at(2), full.length === 8 ? at(3) : 1]
}

/** `a` mixed with `b`, `p` (0–1) of `a`, in sRGB as CSS's color-mix(in srgb, …) mixes them (both taken opaque). */
const mix = (a: Rgba, b: Rgba, p: number): Rgba => [0, 1, 2].map((i) => a[i]! * p + b[i]! * (1 - p)).concat(1) as Rgba

/** `top` drawn over `base`: what a translucent colour looks like on it. */
const over = (top: Rgba, base: Rgba): Rgba => mix(top, base, top[3])

const luminance = ([r, g, b]: Rgba) => {
  const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG's contrast ratio between two opaque colours, 1–21. */
export function contrast(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

/**
 * A step from the ground toward the text: `percent` of the text, or more (up to `most`, else all of it) until it has
 * `least` contrast with the ground. The colour as CSS: color-mix(), so a ground or text the math can't read still
 * works, at `percent`.
 */
type Step = { percent: number; least?: number; most?: number }

/** How far each token steps from the ground to the text, in light and in dark: Superego's own, measured. */
const STEPS: Partial<Record<ColourToken, [light: Step, dark: Step]>> = {
  // The window's side, the rail beside it and its tabs.
  '--superego-chrome': [{ percent: 6, least: 1.08 }, { percent: 5, least: 1.08 }],
  '--superego-sidebar-bg': [{ percent: 6, least: 1.08 }, { percent: 5, least: 1.08 }],
  '--superego-rail-bg': [{ percent: 9, least: 1.1 }, { percent: 2 }],
  '--superego-rail-tab': [{ percent: 11, least: 1.13 }, { percent: 0 }],
  // Wells (code, output), a pane's tab, what floats, the composer.
  '--superego-surface': [{ percent: 5, least: 1.07 }, { percent: 5, least: 1.08 }],
  '--superego-pane-tab': [{ percent: 3 }, { percent: 3 }],
  '--superego-raised': [{ percent: 0 }, { percent: 8, least: 1.12 }],
  '--superego-composer': [{ percent: 0 }, { percent: 4 }],
  // Lines and frames.
  '--superego-line': [{ percent: 14, least: 1.3 }, { percent: 14, least: 1.35 }],
  '--superego-border': [{ percent: 21, least: 1.5 }, { percent: 20, least: 1.7 }],
  // Controls and fields.
  '--superego-control': [{ percent: 0 }, { percent: 30 }],
  '--superego-control-active': [{ percent: 13 }, { percent: 41 }],
  '--superego-field-bg': [{ percent: 0 }, { percent: 6 }],
  '--superego-field-edge': [{ percent: 30, least: 1.9 }, { percent: 28, least: 2.1 }],
  '--superego-track': [{ percent: 18, least: 1.35 }, { percent: 22, least: 1.6 }],
  // Text below the text: secondary words readable (4.5:1, WCAG AA), meta and placeholders at least Superego's own.
  // On a theme whose text itself is barely that (Solarized), secondary words stay a step under the text, below AA.
  '--superego-muted': [{ percent: 62, least: 4.5, most: 85 }, { percent: 62, least: 4.5, most: 85 }],
  '--superego-faint': [{ percent: 40, least: 2.5 }, { percent: 38, least: 2.5 }],
}

/** Tints of the text over whatever they're on: rows hovered and selected, quiet fills, inline code. */
const TINTS: Partial<Record<ColourToken, number>> = {
  '--superego-selected': 8,
  '--superego-hover': 5,
  '--superego-fill': 6,
  '--superego-code-chip': 7,
}

/** Which of a theme's workbench colours (`ui`) stands for a token, kept where it reads well enough on the ground. */
const GIVEN: Partial<Record<ColourToken, { role: keyof NonNullable<Theme['ui']>; least?: number }>> = {
  '--superego-muted': { role: 'muted', least: 4.5 },
  '--superego-chrome': { role: 'sidebar' },
  '--superego-sidebar-bg': { role: 'sidebar' },
  '--superego-raised': { role: 'raised' },
  '--superego-border': { role: 'border', least: 1.5 },
}

/** Every token `uiPalette` may set. */
export const PALETTE_TOKENS: readonly ColourToken[] = [
  '--superego-bg', '--superego-text', ...Object.keys(STEPS), ...Object.keys(TINTS), '--superego-bubble',
] as ColourToken[]

/** A theme's ground and text: its own (`ui`), else its terminal's. */
const groundOf = (theme: Theme): { bg?: Color; fg?: Color } => ({ bg: theme.ui?.bg ?? theme.terminal?.bg, fg: theme.ui?.fg ?? theme.terminal?.fg })

/**
 * The window's colours for `theme`, by token; none for a theme without a ground and text of its own (its window keeps
 * Superego's).
 */
export function uiPalette(theme: Theme): Partial<Record<ColourToken, string>> | undefined {
  const { bg, fg } = groundOf(theme)
  if (!bg || !fg) return undefined
  const dark = theme.appearance === 'dark'
  const [ground, text] = [parseHex(bg), parseHex(fg)]
  // A translucent ground or text is taken as it shows: over the opposite of the appearance's own.
  const base: Rgba = dark ? [0, 0, 0, 1] : [1, 1, 1, 1]
  const g = ground && over(ground, base)
  const t = text && g && over(text, g)
  const palette: Partial<Record<ColourToken, string>> = { '--superego-bg': bg, '--superego-text': fg }

  const step = ({ percent, least, most = 100 }: Step) => {
    let p = percent
    if (g && t && least) while (p < most && contrast(mix(t, g, p / 100), g) < least) p++
    return p === 0 ? bg : p === 100 ? fg : `color-mix(in srgb, ${fg} ${p}%, ${bg})`
  }
  for (const [token, [light, darkStep]] of Object.entries(STEPS) as [ColourToken, [Step, Step]][]) {
    const given = GIVEN[token]
    const colour = given && theme.ui?.[given.role]
    const parsed = parseHex(colour)
    const readable = !given?.least || !parsed || !g || contrast(over(parsed, g), g) >= given.least
    palette[token] = colour && readable ? colour : step(dark ? darkStep : light)
  }
  for (const [token, percent] of Object.entries(TINTS) as [ColourToken, number][]) {
    palette[token] = `color-mix(in srgb, ${fg} ${percent}%, transparent)`
  }
  // Your messages: the accent, a touch, on the window's side.
  palette['--superego-bubble'] = `color-mix(in oklab, var(--superego-accent) ${dark ? 14 : 9}%, ${dark ? palette['--superego-raised'] : bg})`
  return palette
}
