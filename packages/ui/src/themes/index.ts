// Themes for code and the terminal: the format and its check, Superego's own and the built-ins, importing VS Code,
// Ghostty and iTerm2 themes, and applying a light and a dark one to the window.
export { SYNTAX_ROLES, TERMINAL_ROLES, checkTheme, isColor, themeProblems, type Appearance, type Color, type SyntaxRole, type TerminalRole, type Theme, type UiRole, UI_ROLES } from './format.ts'
export { DEFAULT_THEME, DEFAULTS, superegoTheme } from './superego.ts'
export { PALETTE_TOKENS, accentText, contrast, groundOf, parseHex, uiPalette, windowAccent } from './palette.ts'
export { BUILTIN_THEMES } from './builtin.ts'
export { THEMED_PROPERTIES, themeAccent, themeColor, themeStyle } from './apply.ts'
export { SCOPES, fromGhostty, fromITerm, fromVsCode, importTheme, isLight, parseJsonc, type ImportedTheme } from './import.ts'
