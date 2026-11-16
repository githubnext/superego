// The app's own settings, the ones about this client rather than any machine: how it looks, its shortcuts and layout,
// and on the desktop, how it sits there. Declared here once, for the desktop's main process (main/start.ts) and a
// browser's page (renderer/web-bridge.ts) alike; the window's extensions declare theirs beside them. They are served under the reserved machine id `APP` with the same settings methods a daemon answers.
import type { AppConfig } from '@superego/protocol'
import type { SettingSpec, SettingsRegistry } from '@superego/settings'
import { NOTIFICATION_SETTINGS } from './notifications.ts'

/** The machine id the app's own endpoint answers under: its settings, its actions, the desktop's methods. */
export const APP = 'app'

/** Shortcuts the user changed, by action id (`null`: none); see shared/shortcuts.ts. */
export const KEYMAP = 'app.keys'
export const INTERFACE_FONT = 'app.font.interface'
export const TEXT_SIZE = 'app.font.size'
export const MONO_FONT = 'app.font.mono'
export const ACCENT = 'app.accent'
/** Where the window's views go, as the user changed it; see shared/layout.ts. */
export const LAYOUT = 'app.layout'
/**
 * How a thread's panes are laid out beside it (see renderer/panes.tsx): `scroll`, a column each, the row scrolling past
 * the window's edge; `stack`, one column they share, one shown at a time. The pane strip's switch and an action change it.
 */
export const PANE_LAYOUT = 'app.panes.layout'
export type PaneLayout = 'scroll' | 'stack'
/** The desktop's: Superego in the menu bar, and the Dock icon hidden. */
export const MENU_BAR = 'app.menuBar'
export const HIDE_DOCK = 'app.hideDock'

/** Text sizes (Settings → Appearance), smallest first: each a step of 1px on the interface's 13px. */
export const TEXT_SIZES = ['xs', 'sm', 'base', 'lg', 'xl'] as const
/** How much a text size scales every size of text (--superego-text-scale); 1 for an unknown one. */
export const textScale = (size: unknown) => {
  const step = TEXT_SIZES.indexOf(size as (typeof TEXT_SIZES)[number])
  return step < 0 ? 1 : (11 + step) / 13
}

/**
 * Where the window's views go (see shared/layout.ts): edited as text (layout.json, see main/layout-file.ts; in a
 * browser, in the window) and from the views' own menus. In Settings, the way to both and back to the defaults, which
 * no layout can take away.
 */
export const LAYOUT_SETTING = {
  key: LAYOUT, title: 'Layout', default: {}, description: 'Where views go. Each view\'s menu moves it too.', type: { type: 'layout' },
} as const satisfies SettingSpec

export const PANE_LAYOUT_SETTING: SettingSpec = {
  key: PANE_LAYOUT, title: 'Panes', default: 'scroll', description: 'Stacked, they share one column, as tabs.',
  type: { type: 'choice', options: [{ value: 'scroll', label: 'Scroll' }, { value: 'stack', label: 'Stack' }] },
}

/**
 * Register the app's own sections in `settings`: Appearance, Keyboard and Notifications everywhere; on the desktop (`desktop`, with
 * whether it's macOS), Menu bar too.
 */
export function registerAppSettings(settings: SettingsRegistry, desktop?: { app: AppConfig; mac: boolean }) {
  settings.register({
    id: 'appearance', title: 'Appearance', order: 50,
    settings: [
      { key: INTERFACE_FONT, title: 'Interface font', default: null, type: { type: 'font', nullLabel: 'System' } },
      {
        key: TEXT_SIZE, title: 'Text size', default: 'base',
        type: { type: 'choice', slider: true, options: TEXT_SIZES.map((value) => ({ value, label: value })) },
      },
      {
        key: MONO_FONT, title: 'Monospace font', default: null, description: 'Code, tool output and paths.',
        type: { type: 'font', monospace: true, nullLabel: 'System monospace' },
      },
      {
        key: ACCENT, title: 'Accent colour', default: 'color(display-p3 0.155 0.319 0.654)',
        description: 'Focus rings, primary buttons, links and selection. Any CSS colour.', type: { type: 'color' },
      },
      PANE_LAYOUT_SETTING,
      LAYOUT_SETTING,
    ],
  })
  settings.register({
    id: 'keyboard', title: 'Keyboard', order: 65,
    settings: [{
      key: KEYMAP, title: 'Shortcuts', default: {},
      description: 'Every action that runs without asking for more. Click a shortcut and press new keys; ⌫ removes it, Esc keeps it.',
      type: { type: 'keymap' },
    }],
  })
  settings.register(NOTIFICATION_SETTINGS)
  if (!desktop) return
  const { app, mac } = desktop
  settings.register({
    id: 'menu-bar', title: 'Menu bar', order: 70,
    description: 'Agents run in the background either way; quitting the app never stops them.',
    settings: [
      {
        key: MENU_BAR, title: 'Show in menu bar', default: true,
        description: `${app.glyph ?? app.name} in the menu bar while ${app.name} runs, with the threads that need you. Closing the windows (or ⌘Q) leaves it there.`,
        type: { type: 'boolean' },
      },
      {
        key: HIDE_DOCK, title: 'Hide Dock icon', default: false,
        description: 'Live in the menu bar only.',
        type: { type: 'boolean' },
        hidden: () => !mac,
        disabled: () => settings.get<boolean>(MENU_BAR) ? undefined : `Needs “Show in menu bar”, or ${app.name} could not be reached.`,
      },
    ],
  })
}
