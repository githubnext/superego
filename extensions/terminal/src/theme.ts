// The terminal's look, from the window's own: its --superego-terminal-* colours (@superego/ui's styles), the monospace
// font and size (Settings → Appearance). ghostty-web takes colours as hex, so the tokens (any CSS colour: light-dark(),
// display-p3, with alpha over the terminal's background) are read back as drawn.
import type { ITheme } from 'ghostty-web'

/** The theme's colours, each from the token of that name (`brightBlack` from --superego-terminal-bright-black). */
const COLOURS = {
  foreground: 'fg', background: 'bg', cursor: 'cursor', selectionBackground: 'selection',
  black: 'black', red: 'red', green: 'green', yellow: 'yellow', blue: 'blue', magenta: 'magenta', cyan: 'cyan', white: 'white',
  brightBlack: 'bright-black', brightRed: 'bright-red', brightGreen: 'bright-green', brightYellow: 'bright-yellow',
  brightBlue: 'bright-blue', brightMagenta: 'bright-magenta', brightCyan: 'bright-cyan', brightWhite: 'bright-white',
} as const satisfies Partial<Record<keyof ITheme, string>>

/** `color` as drawn over `under` (opaque): #rrggbb. */
function hex(context: CanvasRenderingContext2D, color: string, under: string): string {
  context.fillStyle = under
  context.fillRect(0, 0, 1, 1)
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, '0')).join('')}`
}

export type Look = { theme: ITheme; fontFamily: string; fontSize: number }

/**
 * The look for a terminal drawn in `host` (styles.css), as the window is now, light or dark. Each token is resolved on
 * a probe in `host` (a computed `color` has light-dark() and var() resolved), then flattened onto the background.
 */
export function lookOf(host: HTMLElement): Look {
  const style = getComputedStyle(host)
  const probe = document.createElement('span')
  probe.style.display = 'none'
  host.append(probe)
  const probed = getComputedStyle(probe)
  const resolved = (role: string) => {
    probe.style.color = `var(--superego-terminal-${role})`
    return probed.color
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('No 2D canvas to read the terminal’s colours with.')
  try {
    // The background over the sheet's white, in case a theme gives it alpha; everything else over the background.
    const background = hex(context, resolved(COLOURS.background), '#ffffff')
    const theme: ITheme = { cursorAccent: background }
    for (const [key, role] of Object.entries(COLOURS)) theme[key as keyof typeof COLOURS] = key === 'background' ? background : hex(context, resolved(role), background)
    return { theme, fontFamily: style.fontFamily, fontSize: Math.round(parseFloat(style.fontSize) || 12) }
  } finally {
    probe.remove()
  }
}

/** Two looks the same: a terminal needn't be made again. */
export const sameLook = (a: Look, b: Look) => JSON.stringify(a) === JSON.stringify(b)
