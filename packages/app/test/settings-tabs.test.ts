// Settings' tabs (renderer/settings/tabs.ts): the app's sections each on the tab they name (General when they name none
// or one the app hasn't), and the tab kept from last time, General for one that's gone or from before the tabs.
import { expect, it } from 'vitest'
import { SettingsRegistry } from '@superego/settings'
import { registerAppSettings } from '../src/shared/app-settings.ts'
import { ALL, appTab, appTarget, GENERAL, MACHINES, openTarget, sectionTab } from '../src/renderer/settings/tabs.ts'

it('puts the app’s sections on their tabs: Appearance and Hotkeys their own, the rest on General', async () => {
  const settings = new SettingsRegistry()
  registerAppSettings(settings, { desktop: { app: { id: 'superego', name: 'Superego' }, mac: true } })
  settings.register({ id: 'orders', title: 'Orders', settings: [] })
  const tabs = Object.fromEntries((await settings.snapshot()).sections.map((s) => [s.id, sectionTab(s)]))
  expect(tabs).toEqual({ appearance: 'appearance', hotkeys: 'hotkeys', notifications: 'general', 'menu-bar': 'general', orders: 'general' })
  expect(sectionTab({ tab: 'nowhere' as never })).toBe('general')
})

it('opens on the tab kept, or General for one gone or from before the app’s tabs', () => {
  const machines = [{ id: 'local' }]
  for (const kept of [appTarget('appearance'), appTarget('hotkeys'), GENERAL, MACHINES, ALL, 'local']) expect(openTarget(kept, machines)).toBe(kept)
  expect(openTarget('app', machines)).toBe(GENERAL)
  expect(openTarget('gone', machines)).toBe(GENERAL)
  expect(appTab(openTarget('app', machines))).toBe('general')
  expect(appTab('local')).toBeUndefined()
})
