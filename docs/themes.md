# Themes

The window takes its colours from a theme: one for light, one for dark. Pick them in Settings → Appearance, under
Light theme and Dark theme; the window follows the system's appearance and switches between the two at once. A theme
colours:

- the window itself: its backgrounds, text, lines, fields, rows, links and the accent (focus rings, primary buttons,
  switches). What the theme gives (`ui`, and `accent`) is used as it is; the rest is derived from its ground and text
  (`ui.bg` and `ui.fg`, else the terminal's `bg` and `fg`): each surface a small step from the ground toward the text,
  each line a bigger one, secondary text most of the way, meta and placeholders in its comments' colour. A theme's
  contrast is kept: for more, pick a theme with more. With no accent of its own, a theme's blue is its accent;
- code: in the editor, in messages, and in rendered files;
- diffs: the lines a change added and removed, in messages and the Diff pane;
- the terminal: its cursor, selection and 16 colours, on the window's own ground and text.

Superego's own theme (the default) has no colours of its own: the window keeps its look.

## Built in

Superego (the default), GitHub Light and Dark, One Light and Dark, Tokyo Night and Tokyo Night Day, Catppuccin Latte
and Mocha, Solarized Light and Dark, Rosé Pine and Rosé Pine Dawn, Gruvbox Light and Dark, Zenbones Light and Dark.
Each is taken from its project's published theme.

## Importing

Settings → Appearance → Import theme… reads:

- **a VS Code colour theme** (its JSON, comments and all): its token colours become code's colours, and its
  `terminal.ansi*`, `editor.background`, `editor.foreground`, `terminalCursor.foreground` and
  `editor.selectionBackground` the terminal's; its workbench colours the window's (`ui`: `editor.background`,
  `editor.foreground`, `descriptionForeground`, `sideBar.background`, `editorWidget.background`, `panel.border`,
  `textCodeBlock.background`, `input.background`, `list.inactiveSelectionBackground`, `list.hoverBackground`,
  `textLink.foreground`, `button.foreground`), and its `button.background` the accent;
- **a Ghostty theme** (`palette = 0=#1d1f21`, `background = …`): the terminal's colours;
- **an iTerm2 colour preset** (`.itermcolors`): the terminal's colours;
- **a theme of Superego's own** (below).

An imported theme is chosen for its appearance (light or dark) at once, and listed in that picker under Imported, with
a Remove button under the pickers. The desktop app keeps imported themes as files in `~/.superego/themes/`, one
`<id>.json` each; a theme file you put there yourself is listed too, and one that doesn't read says why under the
pickers. In a browser, imported themes are kept in that browser.

## The format

A theme is JSON:

```json
{
  "name": "Paper Ink",
  "appearance": "light",
  "syntax": { "keyword": "#7a3e9d", "string": "#2f6f3e", "comment": "#8a8a80" },
  "terminal": { "bg": "#fbfaf5", "fg": "#2b2b28", "red": "#b3261e" },
  "accent": "#2f5bd3"
}
```

`name` and `appearance` (`light` or `dark`) are needed; everything else is optional, and a colour left out keeps
Superego's. In `~/.superego/themes/`, the file's name is the theme's id (`paper-ink.json`). Colours are hex (`#rrggbb`,
`#rgb`, with alpha too) or CSS colour functions (`rgb()`, `oklch()`, `color(display-p3 …)`).

| | Roles |
|---|---|
| `syntax` | `keyword`, `string`, `number` (and booleans, null), `comment`, `function`, `type`, `tag`, `attribute`, `definition` (a variable where it's defined), `meta` (annotations), `inserted` and `deleted` (a diff's lines), `invalid` |
| `terminal` | `fg`, `bg`, `cursor`, `selection`, `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and each of those eight as `bright-…` |
| `ui` | `bg` (the sheet, and the terminal's), `fg` (text), `muted` (secondary text), `sidebar`, `raised` (menus, popovers), `border`, `surface` (code, output), `field` (fields, the composer), `selected` and `hover` (rows), `link`, `accent-text` (text on the accent): the rest derived from `bg` and `fg` |

## From extensions

An extension or a profile can bring themes of its own with `superego.theme(theme)` in its UI half: they're listed in
the pickers under its name. See [The UI half](../packages/cli/skill/ui.md#themes).
