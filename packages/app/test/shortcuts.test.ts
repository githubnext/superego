import { afterEach, describe, expect, it, vi } from 'vitest'
import { bound, conflicts, keyLabel, normalize, safe, shortcutOf } from '../src/renderer/shortcuts.ts'

const press = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

afterEach(() => { vi.unstubAllGlobals() })

describe.each([['MacIntel', true], ['Win32', false]])('shortcuts on %s', (platform, mac) => {
  const stub = () => vi.stubGlobal('navigator', { platform })

  it('spells each shortcut one way', () => {
    stub()
    expect(normalize('Shift+Mod+K')).toBe('mod+shift+k')
    expect(normalize(mac ? 'cmd+k' : 'control+k')).toBe('mod+k')
    expect(normalize(mac ? 'ctrl+k' : 'meta+k')).toBe(mac ? 'ctrl+k' : 'meta+k')
    expect(normalize('mod++')).toBe('mod++')
    expect(normalize('mod+\\')).toBe('mod+\\')
  })

  it('turns a key press into the shortcut it is', () => {
    stub()
    expect(shortcutOf(press('K', mac ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true }))).toBe('mod+shift+k')
    expect(shortcutOf(press(' ', { altKey: true }))).toBe('alt+space')
    expect(shortcutOf(press('Meta', { metaKey: true }))).toBeUndefined()
    expect(shortcutOf(press('Shift', { shiftKey: true }))).toBeUndefined()
  })

  it('keeps plain typing out of shortcuts', () => {
    stub()
    expect(safe('k')).toBe(false)
    expect(safe('shift+k')).toBe(false)
    expect(safe('space')).toBe(false)
    expect(safe('mod+k')).toBe(true)
    expect(safe('f5')).toBe(true)
    expect(safe('arrowdown')).toBe(true)
  })

  it('labels shortcuts the platform’s way', () => {
    stub()
    expect(keyLabel('mod+shift+k')).toBe(mac ? '⌘⇧K' : 'Ctrl+Shift+K')
    expect(keyLabel('alt+arrowdown')).toBe(mac ? '⌥↓' : 'Alt+↓')
  })
})

describe('keymaps', () => {
  const actions = [{ id: 'a.one', keys: 'mod+k' }, { id: 'a.two', keys: 'mod+i' }, { id: 'a.three' }]

  it('takes the user’s shortcut over the action’s own, and null for none', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(bound(actions[0]!, undefined)).toBe('mod+k')
    expect(bound(actions[0]!, { 'a.one': 'mod+shift+K' })).toBe('mod+shift+k')
    expect(bound(actions[0]!, { 'a.one': null })).toBeUndefined()
    expect(bound(actions[2]!, { 'a.three': 'cmd+3' })).toBe('mod+3')
  })

  it('finds shortcuts that two actions share', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(conflicts(actions, undefined).size).toBe(0)
    expect([...conflicts(actions, { 'a.three': 'cmd+k' })]).toEqual([['mod+k', ['a.one', 'a.three']]])
    expect(conflicts(actions, { 'a.three': 'cmd+k', 'a.one': null }).size).toBe(0)
  })
})
