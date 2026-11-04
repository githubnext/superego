// The app's own settings, the ones about this client rather than any machine: how it looks, whether it notifies, and
// how it sits on the desktop.
// They are served under the reserved machine id "app" with the same settings methods a daemon answers.
import { join } from 'node:path'
import { SettingsRegistry } from '@mu/settings'
import { FileSettingsStore } from '@mu/settings/file'
import type { AppConfig } from '@mu/protocol'

export const APP = 'app'
export const APP_KEYS = {
  keymap: 'app.keys', interfaceFont: 'app.font.interface', monoFont: 'app.font.mono', notifications: 'app.notifications', menuBar: 'app.menuBar', hideDock: 'app.hideDock',
} as const

export function createAppSettings(dataDir: string, app: AppConfig) {
  const settings = new SettingsRegistry(new FileSettingsStore(join(dataDir, 'app-settings.json')))
  settings.register({
    id: 'appearance', title: 'Appearance', order: 50,
    settings: [
      { key: APP_KEYS.interfaceFont, title: 'Interface font', default: null, type: { type: 'font', nullLabel: 'System' } },
      {
        key: APP_KEYS.monoFont, title: 'Monospace font', default: null, description: 'Code, tool output and paths.',
        type: { type: 'font', monospace: true, nullLabel: 'System monospace' },
      },
    ],
  })
  settings.register({
    id: 'notifications', title: 'Notifications', order: 60,
    settings: [{
      key: APP_KEYS.notifications, title: 'Notify when a session needs a look', default: true,
      description: 'A system notification when a session finishes, fails or needs you while mu is not focused.',
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
        description: `${app.glyph ?? app.name} in the menu bar while ${app.name} runs, with the sessions that need you. Closing the windows (or ⌘Q) leaves it there.`,
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
