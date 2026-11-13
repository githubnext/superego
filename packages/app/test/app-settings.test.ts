// The app's own settings: the sort the sidebar kept as `threads.sort` is the window's `app.sort` now, on the desktop, and
// a shortcut set for an action that moved is the new action's.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defineApp } from '@superego/protocol'
import { createAppSettings } from '../src/main/app-settings.ts'

it('reads the sort kept as threads.sort as app.sort, and saves it so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superego-app-settings-'))
  await writeFile(join(dir, 'app-settings.json'), JSON.stringify({ 'threads.sort': 'status' }))
  const settings = createAppSettings(dir, defineApp({ name: 'superego', id: 'superego' }))
  settings.register({ id: 'sessions', title: 'Sessions', settings: [{ key: 'app.sort', title: 'Sort', default: 'recent', type: { type: 'string' } }] })
  expect(settings.get('app.sort')).toBe('status')
  await settings.set('app.sort', 'status')
  const saved = JSON.parse(await readFile(join(dir, 'app-settings.json'), 'utf8'))
  expect(saved['app.sort']).toBe('status')
  expect(saved).not.toHaveProperty('threads.sort')
  await rm(dir, { recursive: true, force: true })
})

it("reads a shortcut set for an action's old id as the new one's, and saves it so", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superego-app-settings-'))
  await writeFile(join(dir, 'app-settings.json'), JSON.stringify({ 'app.keys': { 'panes.changes': 'mod+alt+d', 'thread.new': null } }))
  const settings = createAppSettings(dir, defineApp({ name: 'superego', id: 'superego' }))
  expect(settings.get('app.keys')).toEqual({ 'git.changes': 'mod+alt+d', 'thread.new': null })
  await settings.set('app.keys', { ...settings.get('app.keys') as object, 'thread.new': 'mod+n' })
  const saved = JSON.parse(await readFile(join(dir, 'app-settings.json'), 'utf8'))
  expect(saved['app.keys']).toEqual({ 'git.changes': 'mod+alt+d', 'thread.new': 'mod+n' })
  await rm(dir, { recursive: true, force: true })
})

it("reads settings that moved into extensions as theirs: whether to notify, where ⌘. looks, and the keys for ⌘. and Ego", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superego-app-settings-'))
  await writeFile(join(dir, 'app-settings.json'), JSON.stringify({ 'app.notifications': false, 'app.unread': 'session', 'app.keys': { 'thread.unread': 'mod+u', 'app.meta': 'mod+shift+m' } }))
  const settings = createAppSettings(dir, defineApp({ name: 'superego', id: 'superego' }))
  expect([settings.get('notifications.enabled'), settings.get('unread.scope'), settings.get('app.keys')]).toEqual([false, 'session', { 'unread.next': 'mod+u', 'ego.open': 'mod+shift+m' }])
  await rm(dir, { recursive: true, force: true })
})
