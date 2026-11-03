// The app's own settings, the ones about this client rather than any machine: how it looks and whether it notifies.
// They are served under the reserved machine id "app" with the same settings methods a daemon answers.
import { join } from 'node:path'
import { SettingsRegistry } from '@mu/settings'
import { FileSettingsStore } from '@mu/settings/file'

export const APP = 'app'
export const APP_KEYS = { interfaceFont: 'app.font.interface', monoFont: 'app.font.mono', notifications: 'app.notifications' } as const

export function createAppSettings(dataDir: string) {
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
  return settings
}
