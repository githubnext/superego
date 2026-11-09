// Shortcuts as data. A shortcut is `[mod+][ctrl+][meta+][alt+][shift+]<key>`, with `mod` ⌘ on macOS and Ctrl elsewhere,
// and the key as the keyboard reports it (`k`, `,`, `\`, `arrowdown`, `space`, `f5`). Actions carry a default; the app
// setting `app.keys` holds what the user changed, by action id (`null`: no shortcut).
import type { ActionInfo } from '@mu/protocol'

export const KEYMAP = 'app.keys'
export type Keymap = Record<string, string | null>

const mac = () => typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
const MODIFIERS = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const

/** One spelling per shortcut: modifiers in a fixed order, `mod` for the platform's command key. */
export function normalize(keys: string): string {
  const parts = keys.toLowerCase().split('+')
  // `mod++` is mod and the plus key.
  const key = parts.at(-1) === '' && parts.at(-2) === '' ? (parts.splice(-2), '+') : parts.pop()!
  const set = new Set(parts.map((p) => p === 'cmd' || p === 'command' ? 'meta' : p === 'control' ? 'ctrl' : p === 'option' ? 'alt' : p))
  if (mac() ? set.delete('meta') : set.delete('ctrl')) set.add('mod')
  return [...MODIFIERS.filter((m) => set.has(m)), key === ' ' ? 'space' : key].join('+')
}

/** Punctuation by the key pressed, not the character it typed: ⌘⇧] is `mod+shift+]`, not `mod+shift+}`. */
const PUNCTUATION: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  Minus: '-', Equal: '=', Backquote: '`',
}

/** The shortcut a key press is, or undefined for a bare modifier. */
export function shortcutOf(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { code?: string }): string | undefined {
  if (['meta', 'control', 'alt', 'shift', 'os', 'capslock', 'fn', 'dead'].includes(event.key.toLowerCase())) return undefined
  const parts = [event.metaKey && 'meta', event.ctrlKey && 'ctrl', event.altKey && 'alt', event.shiftKey && 'shift'].filter(Boolean)
  const modified = event.metaKey || event.ctrlKey || event.altKey
  const key = (modified && event.code && PUNCTUATION[event.code]) || event.key
  return normalize([...parts, key].join('+'))
}

/** Whether a shortcut leaves plain typing alone: it has a modifier other than shift, or is a function or navigation key. */
export function safe(keys: string): boolean {
  const parts = normalize(keys).split('+')
  const key = parts.pop()!
  return parts.some((p) => p !== 'shift') || key.length > 1 && key !== 'space'
}

const GLYPH: Record<string, string> = {
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: '↩', escape: 'Esc', backspace: '⌫', delete: '⌦', tab: '⇥', space: 'Space',
}
/** How a shortcut looks: `⌘⇧K` on macOS, `Ctrl+Shift+K` elsewhere. */
export function keyLabel(keys: string): string {
  const parts = normalize(keys).split('+')
  const key = parts.pop()!
  const name = GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1))
  if (mac()) return parts.map((p) => ({ mod: '⌘', ctrl: '⌃', meta: '⌘', alt: '⌥', shift: '⇧' })[p]).join('') + name
  return [...parts.map((p) => ({ mod: 'Ctrl', ctrl: 'Ctrl', meta: 'Win', alt: 'Alt', shift: 'Shift' })[p]!), name].join('+')
}

/** An action's shortcut: the user's, else its own. */
export function bound(action: Pick<ActionInfo, 'id' | 'keys'>, keymap: Keymap | undefined): string | undefined {
  const keys = keymap && action.id in keymap ? keymap[action.id] : action.keys
  return keys ? normalize(keys) : undefined
}

/** The shortcuts that more than one action has, with those actions. */
export function conflicts(actions: Pick<ActionInfo, 'id' | 'keys'>[], keymap: Keymap | undefined): Map<string, string[]> {
  const by = new Map<string, string[]>()
  for (const action of actions) {
    const keys = bound(action, keymap)
    if (keys) by.set(keys, [...by.get(keys) ?? [], action.id])
  }
  return new Map([...by].filter(([, ids]) => ids.length > 1))
}
