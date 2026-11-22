// The themes Superego comes with, besides its own (superego.ts): each a light or a dark one, its colours taken from the
// project's published theme. Code's roles come from its VS Code theme (or a TextMate one), read as an import would read
// it (import.ts's SCOPES); the terminal's from that theme's `terminal.ansi*` colours, else the project's own terminal
// palette. Where a theme gives no colour for a role (a diff's lines, say) or one that doesn't read on our ground, the
// project's palette fills it in. The window's ground, text and links (`ui`) are the VS Code theme's editor and link
// colours, read as an import reads them (Tokyo Night Day and Zenbones have none: their terminal's). The accent is the
// palette's own, the VS Code theme's buttons' where there's no other. Each one's source and licence is noted above it.
import type { Theme } from './format.ts'

export const BUILTIN_THEMES: readonly Theme[] = [
  // GitHub Light Default, primer/github-vscode-theme 6.3.5 (MIT)
  {
    id: 'github-light', name: 'GitHub Light', appearance: 'light', accent: '#0969da',
    syntax: { keyword: '#cf222e', string: '#0a3069', number: '#0550ae', comment: '#6e7781', function: '#8250df', type: '#953800', tag: '#116329', attribute: '#0550ae', definition: '#1f2328', meta: '#cf222e', inserted: '#116329', deleted: '#82071e', invalid: '#82071e' },
    ui: { bg: '#ffffff', fg: '#1f2328', link: '#0969da' },
    terminal: { fg: '#1f2328', bg: '#ffffff', cursor: '#0969da', selection: '#0969da33', black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781', 'bright-black': '#57606a', 'bright-red': '#a40e26', 'bright-green': '#1a7f37', 'bright-yellow': '#633c01', 'bright-blue': '#218bff', 'bright-magenta': '#a475f9', 'bright-cyan': '#3192aa', 'bright-white': '#8c959f' },
  },
  // GitHub Dark Default, primer/github-vscode-theme 6.3.5 (MIT)
  {
    id: 'github-dark', name: 'GitHub Dark', appearance: 'dark', accent: '#1f6feb',
    syntax: { keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', comment: '#8b949e', function: '#d2a8ff', type: '#ffa657', tag: '#7ee787', attribute: '#79c0ff', definition: '#e6edf3', meta: '#ff7b72', inserted: '#7ee787', deleted: '#ffa198', invalid: '#ffa198' },
    ui: { bg: '#0d1117', fg: '#e6edf3', link: '#2f81f7' },
    terminal: { fg: '#e6edf3', bg: '#0d1117', cursor: '#2f81f7', selection: '#388bfd66', black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4', 'bright-black': '#6e7681', 'bright-red': '#ffa198', 'bright-green': '#56d364', 'bright-yellow': '#e3b341', 'bright-blue': '#79c0ff', 'bright-magenta': '#d2a8ff', 'bright-cyan': '#56d4dd', 'bright-white': '#ffffff' },
  },
  // akamud/vscode-theme-onelight 2.3.0 (MIT), Atom's One Light; the terminal's ANSI colours from One Half Light (sonph/onehalf, MIT)
  {
    id: 'one-light', name: 'One Light', appearance: 'light', accent: '#4078f2',
    syntax: { keyword: '#a626a4', string: '#50a14f', number: '#986801', comment: '#a0a1a7', function: '#4078f2', type: '#c18401', tag: '#e45649', attribute: '#986801', definition: '#e45649', meta: '#a626a4', inserted: '#50a14f', deleted: '#e45649', invalid: '#ca1243' },
    ui: { bg: '#fafafa', fg: '#383a42' },
    terminal: { fg: '#383a42', bg: '#fafafa', cursor: '#526fff', selection: '#e5e5e6', black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#bababa', 'bright-black': '#4f525e', 'bright-red': '#e06c75', 'bright-green': '#98c379', 'bright-yellow': '#d8b36e', 'bright-blue': '#61afef', 'bright-magenta': '#c678dd', 'bright-cyan': '#56b6c2', 'bright-white': '#ffffff' },
  },
  // One Dark Pro, Binaryify/OneDark-Pro 3.20.7 (MIT)
  {
    id: 'one-dark', name: 'One Dark', appearance: 'dark', accent: '#4d78cc',
    syntax: { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#7f848e', function: '#61afef', type: '#e5c07b', tag: '#e06c75', attribute: '#d19a66', definition: '#e06c75', meta: '#c678dd', inserted: '#98c379', deleted: '#e06c75', invalid: '#e06c75' },
    ui: { bg: '#282c34', fg: '#abb2bf', link: '#61afef' },
    terminal: { fg: '#abb2bf', bg: '#282c34', cursor: '#528bff', selection: '#abb2bf30', black: '#3f4451', red: '#e05561', green: '#8cc265', yellow: '#d18f52', blue: '#4aa5f0', magenta: '#c162de', cyan: '#42b3c2', white: '#d7dae0', 'bright-black': '#4f5666', 'bright-red': '#ff616e', 'bright-green': '#a5e075', 'bright-yellow': '#f0a45d', 'bright-blue': '#4dc4ff', 'bright-magenta': '#de73ff', 'bright-cyan': '#4cd1e0', 'bright-white': '#e6e6e6' },
  },
  // folke/tokyonight.nvim's Day: extras/sublime and extras/ghostty (Apache-2.0)
  {
    id: 'tokyo-night-day', name: 'Tokyo Night Day', appearance: 'light', accent: '#2e7de9',
    syntax: { keyword: '#9854f1', string: '#587539', number: '#b15c00', comment: '#848cb5', function: '#2e7de9', type: '#188092', tag: '#f52a65', attribute: '#9854f1', definition: '#3760bf', meta: '#9854f1', inserted: '#4197a4', deleted: '#c47981', invalid: '#f52a65' },
    terminal: { fg: '#3760bf', bg: '#e1e2e7', cursor: '#3760bf', selection: '#b7c1e3', black: '#b4b5b9', red: '#f52a65', green: '#587539', yellow: '#8c6c3e', blue: '#2e7de9', magenta: '#9854f1', cyan: '#007197', white: '#6172b0', 'bright-black': '#a1a6c5', 'bright-red': '#ff4774', 'bright-green': '#5c8524', 'bright-yellow': '#a27629', 'bright-blue': '#358aff', 'bright-magenta': '#a463ff', 'bright-cyan': '#007ea8', 'bright-white': '#3760bf' },
  },
  // enkia/tokyo-night-vscode-theme 1.1.2 (MIT)
  {
    id: 'tokyo-night', name: 'Tokyo Night', appearance: 'dark', accent: '#3d59a1',
    syntax: { keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64', comment: '#51597d', function: '#7aa2f7', type: '#0db9d7', tag: '#f7768e', attribute: '#bb9af7', definition: '#c0caf5', meta: '#bb9af7', inserted: '#73daca', deleted: '#f7768e', invalid: '#ff5370' },
    ui: { bg: '#1a1b26', fg: '#a9b1d6', link: '#6183bb' },
    terminal: { fg: '#787c99', bg: '#16161e', cursor: '#c0caf5', selection: '#515c7e4d', black: '#363b54', red: '#f7768e', green: '#73daca', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#787c99', 'bright-black': '#363b54', 'bright-red': '#f7768e', 'bright-green': '#73daca', 'bright-yellow': '#e0af68', 'bright-blue': '#7aa2f7', 'bright-magenta': '#bb9af7', 'bright-cyan': '#7dcfff', 'bright-white': '#acb0d0' },
  },
  // catppuccin/vscode 3.19.0 (MIT)
  {
    id: 'catppuccin-latte', name: 'Catppuccin Latte', appearance: 'light', accent: '#8839ef',
    syntax: { keyword: '#8839ef', string: '#40a02b', number: '#fe640b', comment: '#7c7f93', function: '#1e66f5', type: '#df8e1d', tag: '#1e66f5', attribute: '#df8e1d', definition: '#4c4f69', meta: '#fe640b', inserted: '#40a02b', deleted: '#d20f39', invalid: '#d20f39' },
    ui: { bg: '#eff1f5', fg: '#4c4f69', link: '#1e66f5', 'accent-text': '#dce0e8' },
    terminal: { fg: '#4c4f69', bg: '#eff1f5', cursor: '#dc8a78', selection: '#acb0be', black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be', 'bright-black': '#6c6f85', 'bright-red': '#de293e', 'bright-green': '#49af3d', 'bright-yellow': '#eea02d', 'bright-blue': '#456eff', 'bright-magenta': '#fe85d8', 'bright-cyan': '#2d9fa8', 'bright-white': '#bcc0cc' },
  },
  // catppuccin/vscode 3.19.0 (MIT)
  {
    id: 'catppuccin-mocha', name: 'Catppuccin Mocha', appearance: 'dark', accent: '#cba6f7',
    syntax: { keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387', comment: '#9399b2', function: '#89b4fa', type: '#f9e2af', tag: '#89b4fa', attribute: '#f9e2af', definition: '#cdd6f4', meta: '#fab387', inserted: '#a6e3a1', deleted: '#f38ba8', invalid: '#f38ba8' },
    ui: { bg: '#1e1e2e', fg: '#cdd6f4', link: '#89b4fa', 'accent-text': '#11111b' },
    terminal: { fg: '#cdd6f4', bg: '#1e1e2e', cursor: '#f5e0dc', selection: '#585b70', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#a6adc8', 'bright-black': '#585b70', 'bright-red': '#f37799', 'bright-green': '#89d88b', 'bright-yellow': '#ebd391', 'bright-blue': '#74a8fc', 'bright-magenta': '#f2aede', 'bright-cyan': '#6bd7ca', 'bright-white': '#bac2de' },
  },
  // VS Code's built-in Solarized Light (microsoft/vscode, MIT), Ethan Schoonover's palette
  {
    id: 'solarized-light', name: 'Solarized Light', appearance: 'light', accent: '#268bd2',
    syntax: { keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#93a1a1', function: '#268bd2', type: '#cb4b16', tag: '#268bd2', attribute: '#93a1a1', definition: '#268bd2', meta: '#586e75', inserted: '#859900', deleted: '#dc322f', invalid: '#dc322f' },
    ui: { bg: '#fdf6e3', fg: '#657b83' },
    terminal: { fg: '#657b83', bg: '#fdf6e3', cursor: '#657b83', selection: '#eee8d5', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', 'bright-black': '#002b36', 'bright-red': '#cb4b16', 'bright-green': '#586e75', 'bright-yellow': '#657b83', 'bright-blue': '#839496', 'bright-magenta': '#6c71c4', 'bright-cyan': '#93a1a1', 'bright-white': '#fdf6e3' },
  },
  // VS Code's built-in Solarized Dark (microsoft/vscode, MIT), Ethan Schoonover's palette
  {
    id: 'solarized-dark', name: 'Solarized Dark', appearance: 'dark', accent: '#268bd2',
    syntax: { keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#586e75', function: '#268bd2', type: '#cb4b16', tag: '#268bd2', attribute: '#93a1a1', definition: '#268bd2', meta: '#93a1a1', inserted: '#859900', deleted: '#dc322f', invalid: '#dc322f' },
    ui: { bg: '#002b36', fg: '#839496' },
    terminal: { fg: '#839496', bg: '#002b36', cursor: '#d30102', selection: '#274642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', 'bright-black': '#002b36', 'bright-red': '#cb4b16', 'bright-green': '#586e75', 'bright-yellow': '#657b83', 'bright-blue': '#839496', 'bright-magenta': '#6c71c4', 'bright-cyan': '#93a1a1', 'bright-white': '#fdf6e3' },
  },
  // rose-pine/vscode 2.15.2 (MIT)
  {
    id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', appearance: 'light', accent: '#286983',
    syntax: { keyword: '#286983', string: '#ea9d34', number: '#d7827e', comment: '#9893a5', function: '#d7827e', type: '#56949f', tag: '#56949f', attribute: '#907aa9', definition: '#575279', meta: '#286983', inserted: '#56949f', deleted: '#b4637a', invalid: '#b4637a' },
    ui: { bg: '#faf4ed', fg: '#575279', link: '#907aa9' },
    terminal: { fg: '#575279', bg: '#faf4ed', cursor: '#9893a5', selection: '#6e6a8614', black: '#f2e9e1', red: '#b4637a', green: '#286983', yellow: '#ea9d34', blue: '#56949f', magenta: '#907aa9', cyan: '#d7827e', white: '#575279', 'bright-black': '#797593', 'bright-red': '#b4637a', 'bright-green': '#286983', 'bright-yellow': '#ea9d34', 'bright-blue': '#56949f', 'bright-magenta': '#907aa9', 'bright-cyan': '#d7827e', 'bright-white': '#575279' },
  },
  // rose-pine/vscode 2.15.2 (MIT)
  {
    id: 'rose-pine', name: 'Rosé Pine', appearance: 'dark', accent: '#31748f',
    syntax: { keyword: '#31748f', string: '#f6c177', number: '#ebbcba', comment: '#6e6a86', function: '#ebbcba', type: '#9ccfd8', tag: '#9ccfd8', attribute: '#c4a7e7', definition: '#e0def4', meta: '#31748f', inserted: '#9ccfd8', deleted: '#eb6f92', invalid: '#eb6f92' },
    ui: { bg: '#191724', fg: '#e0def4', link: '#c4a7e7' },
    terminal: { fg: '#e0def4', bg: '#191724', cursor: '#6e6a86', selection: '#6e6a8633', black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4', 'bright-black': '#908caa', 'bright-red': '#eb6f92', 'bright-green': '#31748f', 'bright-yellow': '#f6c177', 'bright-blue': '#9ccfd8', 'bright-magenta': '#c4a7e7', 'bright-cyan': '#ebbcba', 'bright-white': '#e0def4' },
  },
  // jdinhlife/vscode-theme-gruvbox 1.29.2, Light Medium (MIT), morhetz/gruvbox palette
  {
    id: 'gruvbox-light', name: 'Gruvbox Light', appearance: 'light', accent: '#076678',
    syntax: { keyword: '#9d0006', string: '#79740e', number: '#8f3f71', comment: '#928374', function: '#b57614', type: '#b57614', tag: '#427b58', attribute: '#b57614', definition: '#076678', meta: '#076678', inserted: '#79740e', deleted: '#9d0006', invalid: '#cc241d' },
    ui: { bg: '#fbf1c7', fg: '#3c3836', link: '#076678' },
    terminal: { fg: '#3c3836', bg: '#fbf1c7', cursor: '#3c3836', selection: '#689d6a40', black: '#ebdbb2', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64', 'bright-black': '#928374', 'bright-red': '#9d0006', 'bright-green': '#79740e', 'bright-yellow': '#b57614', 'bright-blue': '#076678', 'bright-magenta': '#8f3f71', 'bright-cyan': '#427b58', 'bright-white': '#3c3836' },
  },
  // jdinhlife/vscode-theme-gruvbox 1.29.2, Dark Medium (MIT), morhetz/gruvbox palette
  {
    id: 'gruvbox-dark', name: 'Gruvbox Dark', appearance: 'dark', accent: '#458588',
    syntax: { keyword: '#fb4934', string: '#b8bb26', number: '#d3869b', comment: '#928374', function: '#fabd2f', type: '#fabd2f', tag: '#8ec07c', attribute: '#fabd2f', definition: '#83a598', meta: '#83a598', inserted: '#b8bb26', deleted: '#fb4934', invalid: '#cc241d' },
    ui: { bg: '#282828', fg: '#ebdbb2', link: '#83a598' },
    terminal: { fg: '#ebdbb2', bg: '#282828', cursor: '#ebdbb2', selection: '#689d6a40', black: '#3c3836', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984', 'bright-black': '#928374', 'bright-red': '#fb4934', 'bright-green': '#b8bb26', 'bright-yellow': '#fabd2f', 'bright-blue': '#83a598', 'bright-magenta': '#d3869b', 'bright-cyan': '#8ec07c', 'bright-white': '#ebdbb2' },
  },
  // zenbones-theme/zenbones.nvim 8304d8d (MIT): the terminal's from extras/ghostty, code's from colors/zenbones.vim's groups
  // (Statement, String, Number, Comment, Function, Type, Special, Identifier, PreProc, Added, Removed, Error). Zenbones sets
  // keywords bold, and comments and strings italic, which our roles carry as colour only. No accent in the dark: its
  // blue (#6099c0) doesn't carry white text (where the window matches the theme, it's taken, with dark text on it).
  {
    id: 'zenbones-light', name: 'Zenbones Light', appearance: 'light', accent: '#286486',
    syntax: { keyword: '#2c363c', string: '#556570', number: '#556570', comment: '#948985', function: '#2c363c', type: '#6a5549', tag: '#4f5e68', attribute: '#44525b', definition: '#44525b', meta: '#2c363c', inserted: '#4f6c31', deleted: '#a8334c', invalid: '#a8334c' },
    terminal: { fg: '#2c363c', bg: '#f0edec', cursor: '#2c363c', selection: '#cbd9e3', black: '#f0edec', red: '#a8334c', green: '#4f6c31', yellow: '#944927', blue: '#286486', magenta: '#88507d', cyan: '#3b8992', white: '#2c363c', 'bright-black': '#cfc1ba', 'bright-red': '#94253e', 'bright-green': '#3f5a22', 'bright-yellow': '#803d1c', 'bright-blue': '#1d5573', 'bright-magenta': '#7b3b70', 'bright-cyan': '#2b747c', 'bright-white': '#4f5e68' },
  },
  // zenbones-theme/zenbones.nvim 8304d8d (MIT): the terminal's from extras/ghostty, code's from colors/zenbones.vim's groups
  {
    id: 'zenbones-dark', name: 'Zenbones Dark', appearance: 'dark',
    syntax: { keyword: '#b4bdc3', string: '#868c91', number: '#868c91', comment: '#6e6763', function: '#b4bdc3', type: '#a1938c', tag: '#8d9499', attribute: '#979fa4', definition: '#979fa4', meta: '#b4bdc3', inserted: '#819b69', deleted: '#de6e7c', invalid: '#de6e7c' },
    terminal: { fg: '#b4bdc3', bg: '#1c1917', cursor: '#c4cacf', selection: '#3d4042', black: '#1c1917', red: '#de6e7c', green: '#819b69', yellow: '#b77e64', blue: '#6099c0', magenta: '#b279a7', cyan: '#66a5ad', white: '#b4bdc3', 'bright-black': '#403833', 'bright-red': '#e8838f', 'bright-green': '#8bae68', 'bright-yellow': '#d68c67', 'bright-blue': '#61abda', 'bright-magenta': '#cf86c1', 'bright-cyan': '#65b8c1', 'bright-white': '#888f94' },
  },
]
