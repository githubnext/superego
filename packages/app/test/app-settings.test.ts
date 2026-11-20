// The app's own settings, declared once for the desktop and a browser (shared/app-settings.ts).
import { expect, it } from 'vitest'
import { SettingsRegistry } from '@superego/settings'
import { HIDE_DOCK, KEYMAP, MENU_BAR, registerAppSettings, TEXT_SIZE } from '../src/shared/app-settings.ts'

const keys = async (settings: SettingsRegistry) => (await settings.snapshot()).sections.flatMap((s) => s.settings.map((setting) => setting.key))

it('gives a browser the same Appearance and Keyboard as the desktop, and the desktop its Menu bar', async () => {
  const web = new SettingsRegistry()
  registerAppSettings(web)
  const desktop = new SettingsRegistry()
  registerAppSettings(desktop, { desktop: { app: { id: 'superego', name: 'Superego' }, mac: true } })
  expect(await keys(web)).toContain(TEXT_SIZE)
  expect(await keys(web)).toContain(KEYMAP)
  expect(await keys(web)).not.toContain(MENU_BAR)
  expect(await keys(desktop)).toEqual([...await keys(web), MENU_BAR, HIDE_DOCK])
})

it('keeps the Dock icon until the menu bar has Superego', async () => {
  const desktop = new SettingsRegistry()
  registerAppSettings(desktop, { desktop: { app: { id: 'superego', name: 'Superego' }, mac: true } })
  await desktop.set(MENU_BAR, false)
  await expect(desktop.set(HIDE_DOCK, true)).rejects.toThrow(/Needs “Show in menu bar”/)
})
