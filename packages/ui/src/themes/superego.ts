// Superego's own colours for the window, code, the terminal and diffs, light and dark: the defaults styles.css declares, as data,
// for a theme to fall back on where it leaves a role out (test/themes.test.ts keeps the two in step). The default theme,
// "Superego", is these and nothing else: choosing it sets nothing on the window's root.
import type { ColourToken } from '../tokens.ts'
import type { Appearance, Theme } from './format.ts'

/** The default theme's id: chosen, the window keeps styles.css's colours. */
export const DEFAULT_THEME = 'superego'

/** The default theme, for either picker: it has no colours of its own. */
export const superegoTheme = (appearance: Appearance): Theme => ({ id: DEFAULT_THEME, name: 'Superego', appearance })

type Pair = [light: string, dark: string]
const same = (value: string): Pair => [value, value]

/** Each themed token's default, light and dark. */
export const DEFAULTS: Partial<Record<ColourToken, Pair>> = {
  // The window's own (palette.ts derives a theme's).
  '--superego-bg': ['#ffffff', '#1d1d1f'],
  '--superego-text': ['rgb(0 0 0 / .85)', 'rgb(255 255 255 / .88)'],
  '--superego-chrome': ['#f2f2f4', '#262628'],
  '--superego-sidebar-bg': ['#f2f2f4', '#262628'],
  '--superego-rail-bg': ['#ebebed', '#212123'],
  '--superego-rail-tab': ['#e6e6e9', '#1c1c1e'],
  '--superego-surface': ['#f3f3f6', '#262629'],
  '--superego-pane-tab': ['#f9f9fb', '#232325'],
  '--superego-raised': ['#ffffff', '#2c2c2e'],
  '--superego-composer': ['#ffffff', '#252527'],
  '--superego-line': ['#e3e3e6', '#333336'],
  '--superego-border': ['#d1d1d6', '#444446'],
  '--superego-control': ['#ffffff', '#5a5a5e'],
  '--superego-control-active': ['#e3e3e8', '#6e6e73'],
  '--superego-field-bg': ['#ffffff', '#2a2a2c'],
  '--superego-field-edge': ['#bdbdc2', '#545458'],
  '--superego-track': ['#d9d9de', '#48484a'],
  '--superego-muted': ['rgb(0 0 0 / .55)', 'rgb(255 255 255 / .56)'],
  '--superego-faint': ['rgb(0 0 0 / .36)', 'rgb(255 255 255 / .36)'],
  '--superego-selected': ['rgb(0 0 0 / .07)', 'rgb(255 255 255 / .08)'],
  '--superego-hover': ['rgb(0 0 0 / .04)', 'rgb(255 255 255 / .05)'],
  '--superego-fill': ['rgb(0 0 0 / .05)', 'rgb(255 255 255 / .06)'],
  '--superego-code-chip': ['rgb(0 0 0 / .055)', 'rgb(255 255 255 / .08)'],
  '--superego-bubble': ['color-mix(in oklab, var(--superego-link) 9%, #fff)', 'color-mix(in oklab, var(--superego-link) 14%, #2a2a2e)'],
  '--superego-link': same('var(--superego-accent)'),

  '--superego-syntax-keyword': ['#a626a4', '#c792ea'],
  '--superego-syntax-string': ['#50a14f', '#a5d68a'],
  '--superego-syntax-number': ['#b76b01', '#f2b46d'],
  '--superego-syntax-comment': same('var(--superego-faint)'),
  '--superego-syntax-function': ['#2f6fdb', '#82aaff'],
  '--superego-syntax-type': ['#c18401', '#ffcb6b'],
  '--superego-syntax-tag': ['#e45649', '#f07178'],
  '--superego-syntax-attribute': ['#986801', '#e0c08a'],
  '--superego-syntax-definition': ['#0f6e8a', '#89ddff'],
  '--superego-syntax-meta': same('var(--superego-muted)'),
  '--superego-syntax-inserted': ['#2f7d32', '#a5d68a'],
  '--superego-syntax-deleted': ['#c0392b', '#f07178'],
  '--superego-syntax-invalid': same('var(--superego-status-error)'),

  '--superego-terminal-fg': same('var(--superego-text)'),
  '--superego-terminal-bg': same('var(--superego-bg)'),
  '--superego-terminal-cursor': same('var(--superego-accent)'),
  '--superego-terminal-selection': ['color-mix(in srgb, var(--superego-accent) 25%, var(--superego-bg))', 'color-mix(in srgb, var(--superego-accent) 45%, var(--superego-bg))'],
  '--superego-terminal-black': ['#1d1d1f', '#48484a'],
  '--superego-terminal-red': ['#c9241b', '#ff6961'],
  '--superego-terminal-green': ['#1a7f37', '#4cd964'],
  '--superego-terminal-yellow': ['#946200', '#ffd60a'],
  '--superego-terminal-blue': ['#0a5fd6', '#64a8ff'],
  '--superego-terminal-magenta': ['#a23ec4', '#da8fff'],
  '--superego-terminal-cyan': ['#0a7c8c', '#5ac8fa'],
  '--superego-terminal-white': ['#8e8e93', '#d1d1d6'],
  '--superego-terminal-bright-black': ['#636366', '#8e8e93'],
  '--superego-terminal-bright-red': ['#e0382d', '#ff8f88'],
  '--superego-terminal-bright-green': ['#24963f', '#7ee08f'],
  '--superego-terminal-bright-yellow': ['#b07800', '#ffe066'],
  '--superego-terminal-bright-blue': ['#2f7cf6', '#8cc0ff'],
  '--superego-terminal-bright-magenta': ['#bf5af2', '#e5b0ff'],
  '--superego-terminal-bright-cyan': ['#1695a8', '#8ad8fb'],
  '--superego-terminal-bright-white': ['#c7c7cc', '#ffffff'],

  '--superego-diff-added': ['#248a3d', 'rgb(48 209 88 / .85)'],
  '--superego-diff-removed': ['#d70015', 'rgb(255 105 97 / .85)'],
  '--superego-diff-added-bg': ['rgb(52 199 89 / .12)', 'rgb(48 209 88 / .11)'],
  '--superego-diff-removed-bg': ['rgb(255 59 48 / .09)', 'rgb(255 69 58 / .12)'],
  '--superego-diff-added-text': ['#1d6e32', '#a6f0b8'],
  '--superego-diff-removed-text': ['#b3261e', '#ffb3ad'],
  '--superego-diff-edit-added-bg': ['rgb(52 199 89 / .14)', 'rgb(48 209 88 / .15)'],
  '--superego-diff-edit-removed-bg': ['rgb(255 59 48 / .11)', 'rgb(255 69 58 / .15)'],
  '--superego-diff-fence-added-bg': ['rgb(46 160 67 / .12)', 'rgb(46 160 67 / .18)'],
  '--superego-diff-fence-removed-bg': ['rgb(207 34 46 / .1)', 'rgb(248 81 73 / .16)'],
}
