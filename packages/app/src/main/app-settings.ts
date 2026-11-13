// The app's own settings, the ones about this client rather than any machine: how it looks, whether it notifies, and
// how it sits on the desktop.
// They are served under the reserved machine id "app" with the same settings methods a daemon answers.
import { join } from 'node:path'
import { SettingsRegistry, withMovedKeys } from '@superego/settings'
import { FileSettingsStore } from '@superego/settings/file'
import type { AppConfig } from '@superego/protocol'
import { APP_MOVED, TEXT_SIZES, withMovedActions } from '../shared.ts'

export const APP = 'app'
export const APP_KEYS = {
  keymap: 'app.keys', interfaceFont: 'app.font.interface', textSize: 'app.font.size', monoFont: 'app.font.mono', accent: 'app.accent', notifications: 'app.notifications', menuBar: 'app.menuBar', hideDock: 'app.hideDock',
} as const

export function createAppSettings(dataDir: string, app: AppConfig) {
  const settings = new SettingsRegistry(withMovedActions(withMovedKeys(new FileSettingsStore(join(dataDir, 'app-settings.json')), APP_MOVED)))
  settings.register({
    id: 'appearance', title: 'Appearance', order: 50,
    settings: [
      { key: APP_KEYS.interfaceFont, title: 'Interface font', default: null, type: { type: 'font', nullLabel: 'System' } },
      {
        key: APP_KEYS.textSize, title: 'Text size', default: 'base',
        type: { type: 'choice', slider: true, options: TEXT_SIZES.map((value) => ({ value, label: value })) },
      },
      {
        key: APP_KEYS.monoFont, title: 'Monospace font', default: null, description: 'Code, tool output and paths.',
        type: { type: 'font', monospace: true, nullLabel: 'System monospace' },
      },
      {
        key: APP_KEYS.accent, title: 'Accent colour', default: 'color(display-p3 0.155 0.319 0.654)',
        description: 'Focus rings, primary buttons, links and selection. Any CSS colour.', type: { type: 'color' },
      },
    ],
  })
  settings.register({
    id: 'notifications', title: 'Notifications', order: 60,
    settings: [{
      key: APP_KEYS.notifications, title: 'Notify when a thread needs a look', default: true,
      description: 'A system notification when a thread finishes, fails or needs you while superego is not focused.',
      type: { type: 'boolean' },
    }],
  })
  settings.register({
    id: 'keyboard', title: 'Keyboard', order: 65,
    settings: [{
      key: APP_KEYS.keymap, title: 'Shortcuts', default: {},
      description: 'Every action that runs without asking for more. Click a shortcut and press new keys; ⌫ removes it, Esc keeps it.',
      type: { type: 'keymap' },
    }],
  })
  const mac = process.platform === 'darwin'
  settings.register({
    id: 'menu-bar', title: 'Menu bar', order: 70,
    description: 'Agents run in the background either way; quitting the app never stops them.',
    settings: [
      {
        key: APP_KEYS.menuBar, title: 'Show in menu bar', default: true,
        description: `${app.glyph ?? app.name} in the menu bar while ${app.name} runs, with the threads that need you. Closing the windows (or ⌘Q) leaves it there.`,
        type: { type: 'boolean' },
      },
      {
        key: APP_KEYS.hideDock, title: 'Hide Dock icon', default: false,
        description: 'Live in the menu bar only.',
        type: { type: 'boolean' },
        hidden: () => !mac,
        disabled: () => settings.get<boolean>(APP_KEYS.menuBar) ? undefined : `Needs “Show in menu bar”, or ${app.name} could not be reached.`,
      },
    ],
  })
  return settings
}
