// The app's own settings: the sort the sidebar kept as `threads.sort` is the window's `app.sort` now, on the desktop.
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
