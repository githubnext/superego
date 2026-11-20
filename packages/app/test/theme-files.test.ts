// Imported themes on the desktop: files in <dataDir>/themes, each named by its id; kept, listed, removed, and a file
// that doesn't read noted rather than dropped in silence. And the actions over them: an id from the name, never a
// built-in's, and a picker left on a removed theme back to Superego's.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsRegistry } from '@superego/settings'
import { themeFiles } from '../src/main/theme-files.ts'
import { registerAppSettings } from '../src/shared/app-settings.ts'
import { THEME_DARK, importedId, themeActions } from '../src/shared/themes.ts'

let dir: string
let store: ReturnType<typeof themeFiles>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'themes-'))
  store = themeFiles(dir, () => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

it('keeps a theme as <id>.json, lists it, and removes it', async () => {
  await store.save({ id: 'paper', name: 'Paper', appearance: 'light', syntax: { keyword: '#7a3e9d' } })
  expect(JSON.parse(readFileSync(join(dir, 'themes', 'paper.json'), 'utf8'))).toEqual({ id: 'paper', name: 'Paper', appearance: 'light', syntax: { keyword: '#7a3e9d' } })
  expect(await store.list()).toEqual({ themes: [{ id: 'paper', name: 'Paper', appearance: 'light', syntax: { keyword: '#7a3e9d' } }], problems: [] })
  await store.remove('paper')
  expect(await store.list()).toEqual({ themes: [], problems: [] })
})

it('takes a hand-written file’s id from its name, and notes the files that don’t read', async () => {
  await store.save({ id: 'placeholder', name: 'x', appearance: 'dark' })
  await store.remove('placeholder')
  writeFileSync(join(dir, 'themes', 'ink.json'), JSON.stringify({ name: 'Ink', appearance: 'dark', terminal: { bg: '#101010' } }))
  writeFileSync(join(dir, 'themes', 'broken.json'), '{ nope')
  writeFileSync(join(dir, 'themes', 'other.json'), JSON.stringify({ id: 'else', name: 'Other', appearance: 'dark' }))
  writeFileSync(join(dir, 'themes', 'github-dark.json'), JSON.stringify({ name: 'Mine', appearance: 'dark' }))
  writeFileSync(join(dir, 'themes', 'loud.json'), JSON.stringify({ name: 'Loud', appearance: 'dark', syntax: { keyword: 'red' } }))
  const { themes, problems } = await store.list()
  expect(themes).toEqual([{ id: 'ink', name: 'Ink', appearance: 'dark', terminal: { bg: '#101010' } }])
  expect(problems.map((p) => p.file)).toEqual(['broken.json', 'github-dark.json', 'loud.json', 'other.json'])
  expect(problems.find((p) => p.file === 'other.json')!.message).toBe('its id is "else", not its file\'s name')
  expect(problems.find((p) => p.file === 'github-dark.json')!.message).toBe('"github-dark" is a built-in theme\'s id')
  expect(problems.find((p) => p.file === 'loud.json')!.message).toBe('syntax.keyword: "red" isn\'t a colour')
  expect(console.error).toHaveBeenCalled()
})

it('names an import by its name, never a built-in’s, and puts a picker that had it back to Superego’s', async () => {
  expect(importedId('Rosé Pine Moon!')).toBe('rose-pine-moon')
  expect(importedId('GitHub Dark')).toBe('github-dark-imported')
  expect(importedId('')).toBe('theme')
  const settings = new SettingsRegistry()
  registerAppSettings(settings, { themes: store })
  const actions = themeActions(store, settings)
  const kept = await actions.add({ theme: { name: 'Night Owl', appearance: 'dark', syntax: { keyword: '#c792ea' } } })
  expect(kept.id).toBe('night-owl')
  await settings.set(THEME_DARK, 'night-owl')
  expect((await settings.snapshot()).sections.find((s) => s.id === 'appearance')!.data).toEqual({ themes: [kept], problems: [] })
  await actions.remove({ id: 'night-owl' })
  expect(settings.get(THEME_DARK)).toBe('superego')
  await expect(actions.add({ theme: { name: 'Bad', appearance: 'dim' } })).rejects.toThrow('Imported theme: appearance: "dim" is neither "light" nor "dark"')
})
