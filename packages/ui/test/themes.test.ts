// Themes (src/themes): the format's check, Superego's defaults in step with styles.css, the built-ins, a light and a
// dark theme as the root's style, and themes imported from VS Code, Ghostty and iTerm2.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_THEMES, DEFAULTS, SYNTAX_ROLES, TERMINAL_ROLES, checkTheme, fromGhostty, fromITerm, fromVsCode, importTheme, parseJsonc, superegoTheme,
  themeAccent, themeProblems, themeStyle, type Theme,
} from '../src/themes/index.ts'
import { colourTokens } from '../src/tokens.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** A light-dark() value's two sides (split at its top-level comma); a plain value is both. */
function sides(value: string): [string, string] {
  const inner = value.match(/^light-dark\((.*)\)$/)?.[1]
  if (!inner) return [value, value]
  let depth = 0
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++
    else if (inner[i] === ')') depth--
    else if (inner[i] === ',' && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()]
  }
  throw new Error(`No comma in ${value}`)
}

describe('the format', () => {
  const good: Theme = { id: 'night', name: 'Night', appearance: 'dark', syntax: { keyword: '#ff00ff' }, terminal: { bg: 'oklch(0.2 0.02 270)' }, accent: '#3366ff' }

  it('takes a theme, every part but its name, id and appearance optional', () => {
    expect(checkTheme(good)).toBe(good)
    expect(themeProblems({ id: 'ext.plain', name: 'Plain', appearance: 'light' })).toEqual([])
  })

  it('says everything wrong with one, by where it is', () => {
    expect(themeProblems({ id: 'Bad Id', appearance: 'dim', syntax: { keywrd: '#fff', string: 'red' }, terminal: [], accent: 'var(--x)', extra: 1 })).toEqual([
      'extra: not part of a theme (id, name, appearance, syntax, terminal, accent)',
      'id: "Bad Id" isn\'t lowercase letters, digits and dashes (dots between an extension\'s name and the rest)',
      'name: missing',
      'appearance: "dim" is neither "light" nor "dark"',
      `syntax.keywrd: no such role (${SYNTAX_ROLES.join(', ')})`,
      'syntax.string: "red" isn\'t a colour',
      'terminal: an object of colours by role',
      'accent: "var(--x)" isn\'t a colour',
    ])
    expect(() => checkTheme(null, 'Extension x')).toThrow(/^Extension x: A theme is an object/)
  })

  it('has a role for each syntax and terminal token', () => {
    expect(SYNTAX_ROLES).toHaveLength(Object.keys(colourTokens.syntax).length)
    expect(TERMINAL_ROLES).toContain('bright-white')
  })
})

describe('Superego’s defaults', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const root = css.match(/:root\s*\{([^}]*)\}/)![1]!
  const declared = new Map([...root.matchAll(/(--superego-[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]))

  it('are styles.css’s, light and dark, for every syntax, terminal and diff token', () => {
    const themed = [...Object.keys(colourTokens.syntax), ...Object.keys(colourTokens.terminal), ...Object.keys(colourTokens.diff)]
    expect(Object.keys(DEFAULTS).sort()).toEqual(themed.sort())
    for (const token of themed) expect([token, DEFAULTS[token as keyof typeof DEFAULTS]]).toEqual([token, sides(declared.get(token)!)])
  })
})

describe('the built-in themes', () => {
  it('each read as a theme, with every role, and a light and a dark of each family', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(themeProblems(theme), theme.id).toEqual([])
      expect(Object.keys(theme.syntax!).sort(), theme.id).toEqual([...SYNTAX_ROLES].sort())
      expect(Object.keys(theme.terminal!).sort(), theme.id).toEqual([...TERMINAL_ROLES].sort())
    }
    expect(new Set(BUILTIN_THEMES.map((t) => t.id)).size).toBe(BUILTIN_THEMES.length)
    const families = ['github', 'one', 'tokyo-night', 'catppuccin', 'solarized', 'rose-pine', 'gruvbox', 'zenbones']
    for (const family of families) {
      const of = BUILTIN_THEMES.filter((t) => t.id === family || t.id.startsWith(`${family}-`))
      expect(of.map((t) => t.appearance).sort(), family).toEqual(['dark', 'light'])
    }
  })
})

describe('applying a light and a dark theme', () => {
  const light: Theme = { id: 'day', name: 'Day', appearance: 'light', syntax: { keyword: '#aa0000', inserted: '#00aa00' }, terminal: { bg: '#fafafa' }, accent: '#0000aa' }
  const dark: Theme = { id: 'night', name: 'Night', appearance: 'dark', syntax: { keyword: '#ff5555' } }

  it('sets each role either gives as light-dark(), the other side the default, and leaves the rest', () => {
    const style = themeStyle(light, dark)
    expect(style['--superego-syntax-keyword']).toBe('light-dark(#aa0000, #ff5555)')
    expect(style['--superego-terminal-bg']).toBe('light-dark(#fafafa, var(--superego-bg))')
    expect(style['--superego-syntax-inserted']).toBe('light-dark(#00aa00, #a5d68a)')
    expect(style['--superego-syntax-string']).toBeUndefined()
    expect(style['--superego-terminal-red']).toBeUndefined()
  })

  it('colours diffs by the inserted and deleted roles', () => {
    const style = themeStyle(light, dark)
    expect(style['--superego-diff-added-text']).toBe('light-dark(#00aa00, #a6f0b8)')
    expect(style['--superego-diff-added-bg']).toBe('light-dark(color-mix(in srgb, #00aa00 12%, transparent), rgb(48 209 88 / .11))')
    expect(style['--superego-diff-removed']).toBeUndefined()
  })

  it('sets nothing for Superego’s own, and an accent only where a theme gives one', () => {
    expect(themeStyle(superegoTheme('light'), superegoTheme('dark'))).toEqual({})
    expect(themeAccent(light, dark, '#007aff')).toBe('light-dark(#0000aa, #007aff)')
    expect(themeAccent(dark, dark, '#007aff')).toBeUndefined()
  })
})

describe('importing', () => {
  it('maps a VS Code theme’s scopes onto the syntax roles and its terminal colours onto the terminal’s', () => {
    const theme = fromVsCode(parseJsonc(fixture('vscode-theme.jsonc')), 'fallback')
    expect(theme.name).toBe('Fixture Night')
    expect(theme.appearance).toBe('dark')
    expect(theme.syntax).toEqual({
      keyword: '#cc66ff', // keyword.control: the most specific rule, over `keyword`
      string: '#00cc00', // a descendant selector (`source.js string`) doesn't count
      number: '#ff8800',
      comment: '#606070',
      function: '#4488ff',
      type: '#eeee00', // no entity.name.type: support.type, the next scope
      tag: '#ff4444',
      attribute: '#ffaa44',
      definition: '#88ccff',
      meta: '#999999',
      inserted: '#33dd33',
      deleted: '#dd3333',
      // invalid: `white` isn't a colour a theme gives, so the default stays
    })
    expect(theme.terminal).toEqual({
      'fg': '#d0d0e0', 'bg': '#101018', 'cursor': '#ffcc00', 'selection': '#33335580',
      'black': '#000000', 'red': '#ff0000', 'bright-white': '#ffffff',
    })
  })

  it('tells a VS Code theme’s appearance from its background when it has no type', () => {
    expect(fromVsCode({ colors: { 'editor.background': '#fdf6e3' } }, 'Paper').appearance).toBe('light')
    expect(() => fromVsCode({ tokenColors: [] }, 'Empty')).toThrow(/No colours found/)
  })

  it('reads a Ghostty theme’s palette into the terminal’s roles', () => {
    expect(fromGhostty(fixture('ghostty-theme'), 'Tomorrow')).toEqual({
      name: 'Tomorrow', appearance: 'dark',
      terminal: { 'black': '#1d1f21', 'red': '#cc6666', 'bright-white': '#ffffff', 'bg': '#1d1f21', 'fg': '#c5c8c6', 'cursor': '#c5c8c6', 'selection': '#373b41' },
    })
  })

  it('reads a Ghostty theme’s quoted colours', () => {
    expect(fromGhostty('foreground = "#2C363C"\nbackground = "#F0EDEC"\n# black\npalette = 0=#F0EDEC\n', 'Paper')).toEqual({
      name: 'Paper', appearance: 'light', terminal: { fg: '#2C363C', bg: '#F0EDEC', black: '#F0EDEC' },
    })
  })

  it('reads an iTerm2 preset, P3 colours as display-p3, alpha kept', () => {
    expect(fromITerm(fixture('iterm.itermcolors'), 'Paper')).toEqual({
      name: 'Paper', appearance: 'light',
      terminal: { black: '#000000', blue: 'color(display-p3 0.25 0.5 1)', bg: '#f8f8f8', selection: '#99ccff80' },
    })
  })

  it('tells each kind of file apart, naming it by the file where it has no name', () => {
    expect(importTheme(fixture('vscode-theme.jsonc'), 'x.json').name).toBe('Fixture Night')
    expect(importTheme(fixture('ghostty-theme'), '/Users/me/themes/Tomorrow Night').name).toBe('Tomorrow Night')
    expect(importTheme(fixture('iterm.itermcolors'), 'Paper.itermcolors').name).toBe('Paper')
    expect(importTheme(JSON.stringify({ name: 'Mine', appearance: 'light', syntax: { keyword: '#123456' } }), 'mine.json'))
      .toEqual({ name: 'Mine', appearance: 'light', syntax: { keyword: '#123456' } })
    expect(() => importTheme(JSON.stringify({ name: 'Mine', appearance: 'light', syntax: { keyword: 'blue' } }), 'mine.json')).toThrow(/syntax.keyword/)
    expect(() => importTheme('hello', 'notes.txt')).toThrow(/Not a theme this reads/)
    expect(() => importTheme('{ nope', 'broken.json')).toThrow(/^Not JSON/)
  })
})
