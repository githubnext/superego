import { describe, expect, it, vi } from 'vitest'
import { declaredSpec, MemorySecretStore, MemorySettingsStore, SettingsRegistry } from '../src/index.ts'

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
      { key: 'word', title: 'Word', default: '', type: { type: 'string' }, validate: (v) => / /.test(String(v)) ? 'one word' : undefined },
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
    await expect(settings.set('word', 'two words')).rejects.toMatchObject({ kind: 'invalid_setting', message: 'Word: one word' })
    options = ['a', 'b', 'c']
    await settings.set('pick', 'c')
    await expect(settings.set('missing', 1)).rejects.toMatchObject({ kind: 'unknown_setting' })

    const snapshot = await settings.snapshot()
    expect(snapshot.values).toEqual({ flag: true, pick: 'c', n: 1, word: '' })
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
    settings.upsert({ ...section, title: 'Threads' })
    const snapshot = await settings.snapshot()
    expect(snapshot.sections.map((s) => s.title)).toEqual(['Threads'])
    expect(snapshot.values['threads.sort']).toBe('status')
  })

  it('takes a colour as the CSS it is', async () => {
    const settings = new SettingsRegistry()
    settings.register({ id: 'a', title: 'A', settings: [{ key: 'accent', title: 'Accent', default: '#2f5bd3', type: { type: 'color' } }] })
    await settings.set('accent', 'color(display-p3 0.155 0.319 0.654)')
    expect(settings.get('accent')).toBe('color(display-p3 0.155 0.319 0.654)')
    await expect(settings.set('accent', ' ')).rejects.toMatchObject({ kind: 'invalid_setting' })
    await expect(settings.set('accent', 3)).rejects.toMatchObject({ kind: 'invalid_setting' })
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

  it('takes pins, each a thread by its machine and id', async () => {
    const settings = new SettingsRegistry()
    settings.register({ id: 'p', title: 'P', settings: [{ key: 'pins', title: 'Pinned threads', default: [], type: { type: 'pins' } }] })
    await settings.set('pins', [{ machine: 'local', thread: 'a' }, { machine: 'box', thread: 'b' }])
    expect(settings.get('pins')).toEqual([{ machine: 'local', thread: 'a' }, { machine: 'box', thread: 'b' }])
    await expect(settings.set('pins', { machine: 'local', thread: 'a' })).rejects.toMatchObject({ kind: 'invalid_setting' })
    await expect(settings.set('pins', [{ machine: 'local' }])).rejects.toMatchObject({ kind: 'invalid_setting' })
    await expect(settings.set('pins', [null])).rejects.toMatchObject({ kind: 'invalid_setting' })
  })

  it('keeps a secret in its store: everyone else sees only whether it is set, and only setSecret changes it', async () => {
    const store = new MemorySettingsStore()
    const secrets = new MemorySecretStore()
    const settings = new SettingsRegistry(store, secrets)
    settings.register({ id: 'mail', title: 'Mail', settings: [{ key: 'mail.token', title: 'Token', type: { type: 'secret', placeholder: 'fmu1-…' } }] })
    const heard: string[] = []
    settings.onSecretChange((key) => heard.push(key))
    expect(settings.get('mail.token')).toBe(false)
    expect(settings.isSet('mail.token')).toBe(false)

    await settings.setSecret('mail.token', 'fmu1-very-secret')
    expect(secrets.values.get('mail.token')).toBe('fmu1-very-secret')
    expect(await settings.secret('mail.token')).toBe('fmu1-very-secret')
    expect(settings.get('mail.token')).toBe(true)
    expect(store.values).toEqual({})
    const snapshot = await settings.snapshot()
    expect(snapshot.values).toEqual({ 'mail.token': true })
    // Always the user's to set, whatever the extension said.
    expect(snapshot.sections[0]!.settings[0]).toEqual({ type: 'secret', placeholder: 'fmu1-…', key: 'mail.token', title: 'Token', default: false, consent: true })
    expect(JSON.stringify(snapshot)).not.toContain('very-secret')

    await expect(settings.set('mail.token', 'other')).rejects.toMatchObject({ kind: 'secret' })
    await expect(settings.setSecret('mail.token', '  ')).rejects.toMatchObject({ kind: 'invalid_setting' })
    await expect(settings.setSecret('mail.other', 'x')).rejects.toMatchObject({ kind: 'unknown_setting' })
    await settings.setSecret('mail.token', null)
    expect(settings.get('mail.token')).toBe(false)
    expect(heard).toEqual(['mail.token', 'mail.token'])

    // One whose extension is gone can still be cleared, never set.
    await secrets.set('gone.token', 'left behind')
    await settings.setSecret('gone.token', null)
    expect(secrets.keys()).toEqual([])
  })

  it('refuses a secret where there is no secret store (a window\'s settings)', () => {
    const settings = new SettingsRegistry()
    expect(() => settings.register({ id: 'x', title: 'X', settings: [{ key: 'x.key', title: 'Key', type: { type: 'secret' } }] })).toThrow(/no secret store/)
    expect(() => declaredSpec({ id: 'y', title: 'Y', settings: [{ key: 'y.key', title: 'Key', type: 'secret', default: false }] })).toThrow(/machine's setting/)
  })

  it('moves a value kept with the settings into the secret store once its key is a secret (a masked string before)', async () => {
    const store = new MemorySettingsStore({ 'mail.token': 'fmu1-was-plain', 'mail.other': 'kept' })
    const secrets = new MemorySecretStore()
    const settings = new SettingsRegistry(store, secrets)
    const heard: string[] = []
    settings.onSecretChange((key) => heard.push(key))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    settings.register({ id: 'mail', title: 'Mail', settings: [{ key: 'mail.token', title: 'Token', type: { type: 'secret' } }] })
    await settings.close()
    log.mockRestore()
    expect(secrets.values.get('mail.token')).toBe('fmu1-was-plain')
    expect(store.values).toEqual({ 'mail.other': 'kept' })
    expect(settings.get('mail.token')).toBe(true)
    expect(heard).toEqual(['mail.token'])
  })
})
