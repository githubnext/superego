// The window's own colours from a theme's, for when the window matches the theme (Settings → Appearance): its ground
// and text (`ui.bg`/`ui.fg`, else the terminal's; Superego's text on a ground given alone) and its links, the rest
// derived by the same few rules for every theme: each surface a step from the ground toward the text, each line a
// bigger one, secondary text most of the way (Superego's own steps, measured from styles.css). The theme sets the mood;
// the window's structure stays Superego's. A step that wouldn't stand out enough on a low-contrast theme is taken
// further until it does, so secondary text stays readable and lines visible; links too.
// A theme with no ground (Superego's own, one with only code colours) colours nothing here.
import type { ColourToken } from '../tokens.ts'
import type { Color, Theme } from './format.ts'
import { DEFAULTS } from './superego.ts'

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
 * `least` contrast with the ground. As CSS color-mix(), so a ground or text the math can't read still works, at
 * `percent`.
 */
type Step = { percent: number; least?: number; most?: number }

/** How far each token steps from the ground to the text, in light and in dark: Superego's own, measured. */
const STEPS: Partial<Record<ColourToken, [light: Step, dark: Step]>> = {
  // The window's side, and side lists in dialogs.
  '--superego-chrome': [{ percent: 6, least: 1.08 }, { percent: 5, least: 1.08 }],
  '--superego-sidebar-bg': [{ percent: 6, least: 1.08 }, { percent: 5, least: 1.08 }],
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

/** Every token `uiPalette` may set. */
export const PALETTE_TOKENS: readonly ColourToken[] = [
  '--superego-bg', '--superego-text', '--superego-ground', ...Object.keys(STEPS), ...Object.keys(TINTS), '--superego-link', '--superego-bubble',
] as ColourToken[]

/** A theme's ground and text: its own (`ui`), else its terminal's; Superego's text on a ground given alone. */
export function groundOf(theme: Theme): { bg: Color; fg: Color } | undefined {
  const bg = theme.ui?.bg ?? theme.terminal?.bg
  if (!bg) return undefined
  return { bg, fg: theme.ui?.fg ?? theme.terminal?.fg ?? DEFAULTS['--superego-text']![theme.appearance === 'dark' ? 1 : 0] }
}

/** The opaque colours of a ground and its text, where the math can read them. */
function readable(bg: Color, fg: Color, dark: boolean): { g: Rgba; t: Rgba } | undefined {
  const [ground, text] = [parseHex(bg), parseHex(fg)]
  if (!ground || !text) return undefined
  // A translucent ground is taken over the appearance's own extreme; translucent text over the ground.
  const g = over(ground, dark ? [0, 0, 0, 1] : [1, 1, 1, 1])
  return { g, t: over(text, g) }
}

/**
 * `colour`, or as little of the way from it to `toward` as it takes to have `least` contrast with the ground: as
 * color-mix(), the colour itself where it already has it (or the math can't read it).
 */
function lift(colour: Color, toward: Color, least: number, ground: Rgba | undefined): string {
  const c = parseHex(colour)
  const to = parseHex(toward)
  if (!c || !to || !ground) return colour
  let p = 0
  while (p < 100 && contrast(mix(over(to, ground), over(c, ground), p / 100), ground) < least) p++
  return p === 0 ? colour : `color-mix(in srgb, ${toward} ${p}%, ${colour})`
}

/** The window's colours for `theme`, by token: none for a theme with no ground of its own. */
export function uiPalette(theme: Theme): Partial<Record<ColourToken, string>> | undefined {
  const ground = groundOf(theme)
  if (!ground) return undefined
  const { bg, fg } = ground
  const dark = theme.appearance === 'dark'
  const math = readable(bg, fg, dark)
  const palette: Partial<Record<ColourToken, string>> = { '--superego-bg': bg, '--superego-text': fg }

  const step = ({ percent, least, most = 100 }: Step) => {
    let p = percent
    if (math && least) while (p < most && contrast(mix(math.t, math.g, p / 100), math.g) < least) p++
    return p === 0 ? bg : p === 100 ? fg : `color-mix(in srgb, ${fg} ${p}%, ${bg})`
  }
  for (const [token, [light, darkStep]] of Object.entries(STEPS) as [ColourToken, [Step, Step]][]) palette[token] = step(dark ? darkStep : light)
  // Behind the thread's columns: in the light a step toward the text, in the dark one toward black, so the sheets
  // stand on it either way (and the side, a step toward the text, stands apart from it).
  palette['--superego-ground'] = dark ? `color-mix(in srgb, #000 30%, ${bg})` : step({ percent: 8, least: 1.12 })
  for (const [token, percent] of Object.entries(TINTS) as [ColourToken, number][]) palette[token] = `color-mix(in srgb, ${fg} ${percent}%, transparent)`
  // Links: the theme's, else its blue (or its accent), lifted toward the text until they read (4.5:1).
  const link = theme.ui?.link ?? theme.terminal?.blue ?? theme.accent
  if (link) palette['--superego-link'] = lift(link, fg, 4.5, math?.g)
  // Your messages: the link colour, a touch, on the ground (on what floats, in the dark).
  palette['--superego-bubble'] = `color-mix(in oklab, ${palette['--superego-link'] ?? 'var(--superego-accent)'} ${dark ? 14 : 9}%, ${dark ? palette['--superego-raised'] : bg})`
  return palette
}

/** The theme's accent, when the window matches it: its own, else its blue. */
export const windowAccent = (theme: Theme): Color | undefined =>
  theme.accent ?? (groundOf(theme) ? theme.terminal?.blue ?? theme.syntax?.function : undefined)

/** Text on `accent`: the theme's, else white or the theme's dark, whichever reads better on it. */
export function accentText(theme: Theme, accent: Color): Color {
  if (theme.ui?.['accent-text']) return theme.ui['accent-text']
  const a = parseHex(accent)
  const ground = groundOf(theme)
  const darkOne = ground && (theme.appearance === 'dark' ? ground.bg : ground.fg)
  const d = parseHex(darkOne)
  if (!a || !d || !darkOne) return '#ffffff'
  const solid = over(a, d)
  return contrast(solid, over(d, solid)) > contrast(solid, [1, 1, 1, 1]) ? darkOne : '#ffffff'
}
