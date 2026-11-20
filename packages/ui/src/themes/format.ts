// A theme: colours for code (the 13 syntax roles), the terminal (its 20) and the accent, for light or for dark. What it
// leaves out keeps the default (Superego's own, superego.ts). The window takes one theme for light and one for dark
// (Settings → Appearance) and sets each role as light-dark(<light's>, <dark's>) on its root (`themeStyle`). Checked
// as it's loaded (`checkTheme`): from a file in <dataDir>/themes, an import, or an extension's `superego.theme`.
import { colourTokens } from '../tokens.ts'

const roles = <P extends string>(group: Record<string, string>, prefix: P) =>
  Object.keys(group).map((name) => name.slice(prefix.length))

export const SYNTAX_ROLES = roles(colourTokens.syntax, '--superego-syntax-') as SyntaxRole[]
export const TERMINAL_ROLES = roles(colourTokens.terminal, '--superego-terminal-') as TerminalRole[]

type Strip<T, P extends string> = T extends `${P}${infer R}` ? R : never
/** A colour of code's: `keyword`, `string`, `number`, `comment`, `function`, `type`, `tag`, `attribute`, `definition`, `meta`, `inserted`, `deleted`, `invalid`. */
export type SyntaxRole = Strip<keyof typeof colourTokens.syntax, '--superego-syntax-'>
/** A colour of the terminal's: `fg`, `bg`, `cursor`, `selection`, and the 16 ANSI colours (`black` … `white`, `bright-black` … `bright-white`). */
export type TerminalRole = Strip<keyof typeof colourTokens.terminal, '--superego-terminal-'>
/** Which of the two pickers a theme is for: the window shows the light theme in light mode, the dark one in dark. */
export type Appearance = 'light' | 'dark'

/** A CSS colour: `#rrggbb`, `#rgb`, with alpha, or a colour function (`rgb()`, `oklch()`, `color(display-p3 …)`). */
export type Color = string

/**
 * A theme for code and the terminal (`superego.theme`, or a file in Settings → Appearance's Import theme…): colours by
 * role, each optional, a role left out keeping Superego's own.
 */
export type Theme = {
  /** Its own: built-ins' are plain (`github-dark`), an extension's start with its name (`dracula.night`). */
  id: string
  name: string
  appearance: Appearance
  syntax?: Partial<Record<SyntaxRole, Color>>
  terminal?: Partial<Record<TerminalRole, Color>>
  /** The accent (focus rings, primary buttons, links), unless the user chose their own. */
  accent?: Color
}

const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/
const FUNCTION = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;{}()]*\)$/i
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Whether `value` reads as a colour a theme may give: hex, or a colour function (no var(), no named colours). */
export const isColor = (value: unknown): value is Color => typeof value === 'string' && (HEX.test(value.trim()) || FUNCTION.test(value.trim()))

/** Why `value` isn't a theme, one line each; empty when it is. */
export function themeProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['A theme is an object: { id, name, appearance, syntax?, terminal?, accent? }']
  const problems: string[] = []
  const theme = value as Record<string, unknown>
  for (const key of Object.keys(theme)) {
    if (!['id', 'name', 'appearance', 'syntax', 'terminal', 'accent', '$schema'].includes(key)) problems.push(`${key}: not part of a theme (id, name, appearance, syntax, terminal, accent)`)
  }
  if (typeof theme.id !== 'string' || !ID.test(theme.id)) problems.push(`id: ${JSON.stringify(theme.id)} isn't lowercase letters, digits and dashes (dots between an extension's name and the rest)`)
  if (typeof theme.name !== 'string' || !theme.name.trim()) problems.push('name: missing')
  if (theme.appearance !== 'light' && theme.appearance !== 'dark') problems.push(`appearance: ${JSON.stringify(theme.appearance)} is neither "light" nor "dark"`)
  const colours = (group: 'syntax' | 'terminal', known: readonly string[]) => {
    const given = theme[group]
    if (given === undefined) return
    if (!given || typeof given !== 'object' || Array.isArray(given)) return void problems.push(`${group}: an object of colours by role`)
    for (const [role, colour] of Object.entries(given)) {
      if (!known.includes(role)) problems.push(`${group}.${role}: no such role (${known.join(', ')})`)
      else if (!isColor(colour)) problems.push(`${group}.${role}: ${JSON.stringify(colour)} isn't a colour`)
    }
  }
  colours('syntax', SYNTAX_ROLES)
  colours('terminal', TERMINAL_ROLES)
  if (theme.accent !== undefined && !isColor(theme.accent)) problems.push(`accent: ${JSON.stringify(theme.accent)} isn't a colour`)
  return problems
}

/** `value` as a theme, or an error saying all that's wrong with it (`where`: whose it is, to start the message). */
export function checkTheme(value: unknown, where = 'Theme'): Theme {
  const problems = themeProblems(value)
  if (problems.length) throw new Error(`${where}: ${problems.join('; ')}`)
  return value as Theme
}
