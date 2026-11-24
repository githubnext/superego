# Themes

Pick a light and a dark theme in Settings → Appearance; the window follows the system's appearance. A theme colours:

- code, in the editor, messages and rendered files;
- diffs' added and removed lines;
- the terminal: text, background, cursor, selection and 16 colours;
- the accent (focus rings, buttons), unless you chose your own accent colour.

**Match window to theme** colours the window too: background and text from `ui.bg` and `ui.fg` (else the terminal's
`bg` and `fg`), links from `ui.link` (else its blue), the accent from `accent` (else its blue). Superego derives the
rest (sidebar, lines, fields, secondary text) from the background and text, keeping them readable on low-contrast
themes.

## Built in

Superego (the default), GitHub Light and Dark, One Light and Dark, Tokyo Night and Tokyo Night Day, Catppuccin Latte
and Mocha, Solarized Light and Dark, Rosé Pine and Rosé Pine Dawn, Gruvbox Light and Dark, Zenbones Light and Dark.

## Import a theme

Settings → Appearance → Import theme… reads:

| File | Gives |
|---|---|
| VS Code colour theme (JSON, comments allowed) | code from its token colours; the terminal from `terminal.ansi*`, `editor.background`, `editor.foreground`, `terminalCursor.foreground`, `editor.selectionBackground`; the window (`ui`) from `editor.background`, `editor.foreground`, `textLink.foreground`, `button.foreground`; the accent from `button.background` |
| Ghostty theme (`palette = 0=#1d1f21`, `background = …`) | the terminal |
| iTerm2 preset (`.itermcolors`) | the terminal |
| Superego theme (below) | everything it sets |

It's chosen at once for its appearance, listed under Imported, and removable with the Remove button under the pickers.
The desktop app keeps imported themes in `~/.superego/themes/<id>.json`; a file you put there yourself is listed too,
and one that doesn't read says why under the pickers. A browser keeps its imported themes itself.

## The format

```json
{
  "name": "Paper Ink",
  "appearance": "light",
  "syntax": { "keyword": "#7a3e9d", "string": "#2f6f3e", "comment": "#8a8a80" },
  "terminal": { "bg": "#fbfaf5", "fg": "#2b2b28", "red": "#b3261e" },
  "accent": "#2f5bd3"
}
```

`name` and `appearance` (`light` or `dark`) are required; a colour left out keeps Superego's. In `~/.superego/themes/`
the file name is the id (`paper-ink.json`). Colours are hex (`#rrggbb`, `#rgb`, with alpha too) or CSS colour functions
(`rgb()`, `oklch()`, `color(display-p3 …)`).

| | Roles |
|---|---|
| `syntax` | `keyword`, `string`, `number` (and booleans, null), `comment`, `function`, `type`, `tag`, `attribute`, `definition` (a variable where it's defined), `meta` (annotations), `inserted` and `deleted` (a diff's lines), `invalid` |
| `terminal` | `fg`, `bg`, `cursor`, `selection`, `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and each of those eight as `bright-…` |
| `ui` | for Match window to theme: `bg` (the window's background), `fg` (its text), `link`, `accent-text` (text on the accent) |

## From extensions

An extension or profile adds themes with `superego.theme(theme)` in its UI half; they're listed under its name. See
[The UI half](../packages/cli/skill/ui.md#themes).
