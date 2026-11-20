// Themes from elsewhere, as ours (format.ts): a VS Code colour theme (its TextMate scopes onto our syntax roles, its
// `terminal.ansi*` colours onto the terminal's), a Ghostty theme or an iTerm2 `.itermcolors` file (the terminal alone),
// or a theme of ours. `importTheme` tells which from the text. What comes back has no id yet: the app gives it one as it
// keeps it.
import { SYNTAX_ROLES, isColor, themeProblems, type Appearance, type SyntaxRole, type TerminalRole, type Theme } from './format.ts'

export type ImportedTheme = Omit<Theme, 'id'>

/**
 * Which TextMate scopes stand for each syntax role, most telling first: a role takes the colour of the theme's rule
 * that matches the first of them any rule does (the most specific selector wins, as in VS Code; a tie, the later rule).
 */
export const SCOPES: Record<SyntaxRole, string[]> = {
  keyword: ['keyword.control', 'keyword', 'storage.type'],
  string: ['string.quoted', 'string'],
  number: ['constant.numeric', 'constant.language'],
  comment: ['comment.line', 'comment'],
  function: ['entity.name.function', 'support.function'],
  type: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  tag: ['entity.name.tag'],
  attribute: ['entity.other.attribute-name', 'support.type.property-name', 'variable.other.property'],
  definition: ['variable.other.readwrite', 'variable', 'entity.name.variable'],
  meta: ['meta.decorator', 'storage.type.annotation', 'meta.preprocessor', 'meta'],
  inserted: ['markup.inserted'],
  deleted: ['markup.deleted'],
  invalid: ['invalid.illegal', 'invalid'],
}

/** VS Code's colour keys for each terminal role, the first one given winning. */
const TERMINAL_KEYS: Record<TerminalRole, string[]> = {
  'fg': ['terminal.foreground', 'editor.foreground', 'foreground'],
  'bg': ['terminal.background', 'editor.background'],
  'cursor': ['terminalCursor.foreground', 'editorCursor.foreground'],
  'selection': ['terminal.selectionBackground', 'editor.selectionBackground'],
  'black': ['terminal.ansiBlack'], 'red': ['terminal.ansiRed'], 'green': ['terminal.ansiGreen'], 'yellow': ['terminal.ansiYellow'],
  'blue': ['terminal.ansiBlue'], 'magenta': ['terminal.ansiMagenta'], 'cyan': ['terminal.ansiCyan'], 'white': ['terminal.ansiWhite'],
  'bright-black': ['terminal.ansiBrightBlack'], 'bright-red': ['terminal.ansiBrightRed'], 'bright-green': ['terminal.ansiBrightGreen'],
  'bright-yellow': ['terminal.ansiBrightYellow'], 'bright-blue': ['terminal.ansiBrightBlue'], 'bright-magenta': ['terminal.ansiBrightMagenta'],
  'bright-cyan': ['terminal.ansiBrightCyan'], 'bright-white': ['terminal.ansiBrightWhite'],
}

/** The 16 ANSI colours' roles, by number. */
const ANSI: TerminalRole[] = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow', 'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
]

/** JSON with comments and trailing commas, as VS Code writes its themes. */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      out += text.slice(start, i + 1)
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** Whether a colour is light, by its relative luminance: a #rgb(a) or #rrggbb(aa) only; undefined for any other. */
export function isLight(colour: string | undefined): boolean | undefined {
  const hex = colour?.trim().match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (!hex || ![3, 4, 6, 8].includes(hex.length)) return undefined
  const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex.slice(0, 6)
  const [r, g, b] = [0, 2, 4].map((at) => {
    const c = parseInt(full.slice(at, at + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.4
}

const appearanceOf = (background: string | undefined): Appearance => isLight(background) ? 'light' : 'dark'

/** A selector of a rule: plain dotted scopes only (a descendant selector, `a b`, or an exclusion, `a - b`, is skipped). */
const selectorsOf = (scope: unknown): string[] =>
  (Array.isArray(scope) ? scope : typeof scope === 'string' ? scope.split(',') : [])
    .filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s && !/\s/.test(s))

/** A VS Code colour theme (its JSON) as ours. */
export function fromVsCode(json: unknown, fallbackName: string): ImportedTheme {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('A VS Code theme is a JSON object')
  const theme = json as { name?: unknown; type?: unknown; colors?: Record<string, unknown>; tokenColors?: unknown }
  const colors = theme.colors && typeof theme.colors === 'object' ? theme.colors : {}
  const rules = (Array.isArray(theme.tokenColors) ? theme.tokenColors : [])
    .filter((rule): rule is { scope?: unknown; settings: { foreground?: unknown } } => Boolean(rule?.settings && typeof rule.settings === 'object'))
    .flatMap((rule) => isColor(rule.settings.foreground) ? [{ selectors: selectorsOf(rule.scope), foreground: rule.settings.foreground as string }] : [])
  const syntax: Theme['syntax'] = {}
  for (const role of SYNTAX_ROLES) {
    for (const scope of SCOPES[role]) {
      let best: { length: number; foreground: string } | undefined
      for (const rule of rules) {
        for (const selector of rule.selectors) {
          if ((scope === selector || scope.startsWith(`${selector}.`)) && selector.length >= (best?.length ?? 0)) best = { length: selector.length, foreground: rule.foreground }
        }
      }
      if (best) { syntax[role] = best.foreground; break }
    }
  }
  const terminal: Theme['terminal'] = {}
  for (const [role, keys] of Object.entries(TERMINAL_KEYS) as [TerminalRole, string[]][]) {
    const colour = keys.map((key) => colors[key]).find(isColor)
    if (colour) terminal[role] = colour
  }
  if (!Object.keys(syntax).length && !Object.keys(terminal).length) throw new Error('No colours found: neither tokenColors nor terminal colours')
  const type = theme.type
  const appearance: Appearance = type === 'light' || type === 'hcLight' ? 'light' : type === 'dark' || type === 'hc' ? 'dark' : appearanceOf(terminal.bg)
  const name = typeof theme.name === 'string' && theme.name.trim() ? theme.name.trim() : fallbackName
  return { name, appearance, ...(Object.keys(syntax).length ? { syntax } : {}), ...(Object.keys(terminal).length ? { terminal } : {}) }
}

/** A Ghostty theme (`palette = 0=#1d1f21`, `background = 1d1f21`, `foreground = "#c5c8c6"`, …) as ours: the terminal's colours. */
export function fromGhostty(text: string, name: string): ImportedTheme {
  const terminal: Theme['terminal'] = {}
  const hex = (given: string) => {
    const value = given.replace(/^"(.*)"$/, '$1')
    const colour = /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : value
    return isColor(colour) ? colour : undefined
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([a-z-]+)\s*=\s*(.+?)\s*$/)
    if (!match) continue
    const [, key, value] = match as unknown as [string, string, string]
    if (key === 'palette') {
      const entry = value.match(/^(\d+)\s*=\s*(\S+)$/)
      const role = entry && ANSI[Number(entry[1])]
      const colour = entry && hex(entry[2]!)
      if (role && colour) terminal[role] = colour
      continue
    }
    const role = ({ 'foreground': 'fg', 'background': 'bg', 'cursor-color': 'cursor', 'selection-background': 'selection' } as const)[key]
    const colour = hex(value)
    if (role && colour) terminal[role] = colour
  }
  if (!Object.keys(terminal).length) throw new Error('No colours found: expected lines like "palette = 0=#1d1f21" and "background = #1d1f21"')
  return { name, appearance: appearanceOf(terminal.bg), terminal }
}

/** An iTerm2 colour preset (`.itermcolors`, a property list) as ours: the terminal's colours. */
export function fromITerm(text: string, name: string): ImportedTheme {
  const keys: Record<string, TerminalRole> = {
    'Foreground Color': 'fg', 'Background Color': 'bg', 'Cursor Color': 'cursor', 'Selection Color': 'selection',
    ...Object.fromEntries(ANSI.map((role, n) => [`Ansi ${n} Color`, role])),
  }
  const terminal: Theme['terminal'] = {}
  for (const [, key, body] of text.matchAll(/<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const role = keys[key!.trim()]
    if (!role) continue
    const part = (name: string) => body!.match(new RegExp(`<key>${name}</key>\\s*<(?:real|integer|string)>([^<]*)</`))?.[1]?.trim()
    const [r, g, b] = ['Red', 'Green', 'Blue'].map((c) => Number(part(`${c} Component`)))
    if (![r, g, b].every((c) => Number.isFinite(c) && c! >= 0 && c! <= 1)) continue
    const alpha = part('Alpha Component')
    const a = alpha === undefined ? 1 : Number(alpha)
    if (part('Color Space') === 'P3') {
      terminal[role] = `color(display-p3 ${[r, g, b].map((c) => +c!.toFixed(4)).join(' ')}${a < 1 ? ` / ${+a.toFixed(3)}` : ''})`
    } else {
      const byte = (c: number) => Math.round(c * 255).toString(16).padStart(2, '0')
      terminal[role] = `#${[r, g, b].map((c) => byte(c!)).join('')}${a < 1 ? byte(a) : ''}`
    }
  }
  if (!Object.keys(terminal).length) throw new Error('No colours found: expected an iTerm2 colour preset with "Ansi 0 Color" and so on')
  return { name, appearance: appearanceOf(terminal.bg), terminal }
}

/**
 * The theme in a file's text, of whichever kind it is: a theme of ours, a VS Code theme (JSON, with comments), an
 * iTerm2 preset (a property list), or a Ghostty theme. `file` is its name: the theme's, when the file doesn't name it.
 */
export function importTheme(text: string, file: string): ImportedTheme {
  const name = file.replace(/^.*[\\/]/, '').replace(/\.(json|jsonc|itermcolors|conf|txt)$/i, '') || 'Imported'
  const trimmed = text.trim()
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<plist') || trimmed.startsWith('<!DOCTYPE plist')) return fromITerm(text, name)
  if (/^(\{|\/\/|\/\*)/.test(trimmed)) {
    let json: unknown
    try { json = parseJsonc(text) } catch (error) { throw new Error(`Not JSON: ${(error as Error).message}`) }
    const ours = json as Record<string, unknown>
    if (ours && typeof ours === 'object' && ('syntax' in ours || 'terminal' in ours) && !('tokenColors' in ours) && !('colors' in ours)) {
      const { id: _id, ...rest } = ours
      const problems = themeProblems({ ...rest, id: 'imported' })
      if (problems.length) throw new Error(problems.join('; '))
      return rest as ImportedTheme
    }
    return fromVsCode(json, name)
  }
  if (/^\s*(palette|background|foreground)\s*=/m.test(text)) return fromGhostty(text, name)
  throw new Error('Not a theme this reads: a VS Code theme (JSON), a Ghostty theme or an iTerm2 .itermcolors file')
}
