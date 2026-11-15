// The terminal's look, from the window's own: its sheet and text colours, the accent for the cursor, the monospace font
// and size (Settings → Appearance), and an ANSI palette for light and one for dark. ghostty-web takes colours as hex,
// so the window's (any CSS colour: light-dark(), display-p3, with alpha over the sheet) are read back as drawn.
import type { ITheme } from 'ghostty-web'

const DARK = {
  black: '#48484a', red: '#ff6961', green: '#4cd964', yellow: '#ffd60a', blue: '#64a8ff', magenta: '#da8fff', cyan: '#5ac8fa', white: '#d1d1d6',
  brightBlack: '#8e8e93', brightRed: '#ff8f88', brightGreen: '#7ee08f', brightYellow: '#ffe066', brightBlue: '#8cc0ff', brightMagenta: '#e5b0ff', brightCyan: '#8ad8fb', brightWhite: '#ffffff',
}
const LIGHT = {
  black: '#1d1d1f', red: '#c9241b', green: '#1a7f37', yellow: '#946200', blue: '#0a5fd6', magenta: '#a23ec4', cyan: '#0a7c8c', white: '#8e8e93',
  brightBlack: '#636366', brightRed: '#e0382d', brightGreen: '#24963f', brightYellow: '#b07800', brightBlue: '#2f7cf6', brightMagenta: '#bf5af2', brightCyan: '#1695a8', brightWhite: '#c7c7cc',
}

/** `color` as drawn over `under` (opaque): #rrggbb. */
function hex(color: string, under = '#ffffff'): string {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return under
  context.fillStyle = under
  context.fillRect(0, 0, 1, 1)
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, '0')).join('')}`
}

/** The look for a terminal drawn in `host` (styled with the window's tokens in styles.css), light or dark. */
export function lookOf(host: HTMLElement, dark: boolean): { theme: ITheme; fontFamily: string; fontSize: number } {
  const style = getComputedStyle(host)
  const background = hex(style.backgroundColor, dark ? '#1d1d1f' : '#ffffff')
  const accent = hex(style.textDecorationColor, background)
  return {
    theme: {
      background, foreground: hex(style.color, background), cursor: accent, cursorAccent: background,
      selectionBackground: hex(`color-mix(in srgb, ${style.textDecorationColor} ${dark ? 45 : 25}%, ${background})`, background),
      ...(dark ? DARK : LIGHT),
    },
    fontFamily: style.fontFamily,
    fontSize: Math.round(parseFloat(style.fontSize) || 12),
  }
}
