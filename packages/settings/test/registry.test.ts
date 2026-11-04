import { describe, expect, it } from 'vitest'
import { MemorySettingsStore, SettingsRegistry } from '../src/index.ts'

const flush = () => new Promise((resolve) => setTimeout(resolve))

describe('SettingsRegistry', () => {
  it('reads defaults, validates and stores values, and notifies watchers', async () => {
    const store = new MemorySettingsStore()
    const settings = new SettingsRegistry(store)
    let changes = 0
    settings.onChange(() => changes++)
    let options = ['a', 'b']
    settings.register({ id: 's', title: 'S', settings: [
      { key: 'flag', title: 'Flag', default: false, type: { type: 'boolean' } },
      { key: 'pick', title: 'Pick', default: null, type: () => ({ type: 'choice', nullable: true, options: options.map((value) => ({ value, label: value })) }) },
      { key: 'n', title: 'N', default: 1, type: { type: 'number', min: 0, max: 3 } },
    ] })
    await flush()
    changes = 0
    expect(settings.get('flag')).toBe(false)

    await settings.set('flag', true)
    await settings.set('pick', 'b')
    await flush()
    expect(changes).toBeGreaterThan(0)
    expect(store.values).toEqual({ flag: true, pick: 'b' })

    await expect(settings.set('flag', 'yes')).rejects.toMatchObject({ kind: 'invalid_setting' })
    await expect(settings.set('n', 9)).rejects.toMatchObject({ kind: 'invalid_setting' })
    await expect(settings.set('pick', 'c')).rejects.toMatchObject({ kind: 'invalid_setting' })
    options = ['a', 'b', 'c']
    await settings.set('pick', 'c')
    await expect(settings.set('missing', 1)).rejects.toMatchObject({ kind: 'unknown_setting' })

    await settings.reset('flag')
    expect(settings.get('flag')).toBe(false)
    const snapshot = await settings.snapshot()
    expect(snapshot.values).toEqual({ flag: false, pick: 'c', n: 1 })
    expect(snapshot.sections[0]!.settings[1]).toMatchObject({ type: 'choice', options: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] })
  })

  it('keeps values of sections that are not registered yet, and refuses duplicate keys', async () => {
    const settings = new SettingsRegistry(new MemorySettingsStore({ later: 'kept' }))
    const off = settings.register({ id: 'x', title: 'X', settings: [{ key: 'later', title: 'Later', default: '', type: { type: 'string' } }] })
    expect(settings.get('later')).toBe('kept')
    expect(() => settings.register({ id: 'y', title: 'Y', settings: [{ key: 'later', title: 'Again', default: '', type: { type: 'string' } }] })).toThrow()
    off()
    expect((await settings.snapshot()).sections).toEqual([])
  })
})

describe('upsert', () => {
  it('replaces a section declared again, keeping stored values', async () => {
    const settings = new SettingsRegistry(new MemorySettingsStore({ 'threads.sort': 'status' }))
    const section = { id: 'threads', title: 'Sidebar', settings: [{ key: 'threads.sort', title: 'Sort', default: 'created', type: { type: 'choice' as const, options: [{ value: 'created', label: 'Newest' }, { value: 'status', label: 'Needs you' }] } }] }
    settings.upsert(section)
    settings.upsert({ ...section, title: 'Sessions' })
    const snapshot = await settings.snapshot()
    expect(snapshot.sections.map((s) => s.title)).toEqual(['Sessions'])
    expect(snapshot.values['threads.sort']).toBe('status')
  })

  it('takes keymaps of shortcuts by action id', async () => {
    const settings = new SettingsRegistry()
    settings.register({ id: 'k', title: 'K', settings: [{ key: 'keys', title: 'Shortcuts', default: {}, type: { type: 'keymap' } }] })
    await settings.set('keys', { 'threads.rail': 'mod+shift+r', 'app.palette': null, 'x.plus': 'mod++' })
    expect(settings.get('keys')).toEqual({ 'threads.rail': 'mod+shift+r', 'app.palette': null, 'x.plus': 'mod++' })
    await expect(settings.set('keys', ['mod+k'])).rejects.toMatchObject({ kind: 'invalid_setting' })
    await expect(settings.set('keys', { 'a.b': 'mod+ k' })).rejects.toMatchObject({ kind: 'invalid_setting' })
    await expect(settings.set('keys', { 'a.b': 3 })).rejects.toMatchObject({ kind: 'invalid_setting' })
  })
})

