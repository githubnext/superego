// A remote machine's profile UI runs here only for the exact sources allowed: the hash is the client's, over what it got.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { collectProfileUi, filesOf, hashProfileUi, type ProfileModule } from '../src/profile-ui.ts'
import { UiAllowStore } from '../src/ui-allowed.ts'

const served = (files: Record<string, string>) => async (path: string): Promise<ProfileModule> => {
  const name = path.replace(/^\.\//, '')
  const found = [name, `${name}.ts`].find((p) => p in files)
  if (!found) throw new Error(`no ${path}`)
  return { path: found, code: files[found]! }
}

const profile = {
  'ui/badge.ts': `import { h } from 'superego/ui'\nimport { label } from './label.ts'\nexport default { name: 'badge', setup() {} }`,
  'ui/label.ts': `export const label = 'hi'`,
  'other.ts': `export const unused = 1`,
}

it('walks the imports, and hashes exactly what would run', async () => {
  const sources = await collectProfileUi(['./ui/badge.ts'], served(profile))
  expect([...sources.modules.keys()]).toEqual(['./ui/badge.ts', 'ui/label.ts'])
  expect(filesOf(sources)).toEqual([{ path: 'ui/badge.ts', size: profile['ui/badge.ts'].length }, { path: 'ui/label.ts', size: 25 }])
  const hash = await hashProfileUi(sources)
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  expect(await hashProfileUi(await collectProfileUi(['./ui/badge.ts'], served(profile)))).toBe(hash)
  // A file it doesn't import is no part of it.
  expect(await hashProfileUi(await collectProfileUi(['./ui/badge.ts'], served({ ...profile, 'other.ts': 'changed' })))).toBe(hash)
  // Any change to a module it runs is another hash, however deep.
  expect(await hashProfileUi(await collectProfileUi(['./ui/badge.ts'], served({ ...profile, 'ui/label.ts': `export const label = 'ho'` })))).not.toBe(hash)
  // So is another entry.
  expect(await hashProfileUi(await collectProfileUi(['./ui/badge.ts', './other.ts'], served(profile)))).not.toBe(hash)
})

it('refuses imports a profile UI cannot make', async () => {
  await expect(collectProfileUi(['./a.ts'], served({ 'a.ts': `import x from 'https://evil.example/x.js'` }))).rejects.toMatchObject({ kind: 'invalid' })
})

it('allows a profile for one hash, forgets it on a change, and revokes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-allowed-'))
  const store = new UiAllowStore(dir)
  const ref = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
  expect(store.allowed('m1', ref.dir, 'h1')).toBe(false)
  await store.allow({ machine: 'm1', profile: ref, hash: 'h1', files: [] })
  expect(store.allowed('m1', ref.dir, 'h1')).toBe(true)
  // Only from that machine, and only those sources.
  expect(store.allowed('m2', ref.dir, 'h1')).toBe(false)
  expect(store.allowed('m1', ref.dir, 'h2')).toBe(false)
  // Kept on disk, for the app and the CLI alike.
  expect(new UiAllowStore(dir).allowed('m1', ref.dir, 'h1')).toBe(true)
  expect(JSON.parse(readFileSync(join(dir, 'ui-allowed.json'), 'utf8'))).toHaveLength(1)
  // Allowing the changed sources replaces the old.
  await store.allow({ machine: 'm1', profile: ref, hash: 'h2', files: [] })
  expect(store.list()).toHaveLength(1)
  expect(store.allowed('m1', ref.dir, 'h1')).toBe(false)
  await store.revoke('m1', ref.dir)
  expect(store.allowed('m1', ref.dir, 'h2')).toBe(false)
  // A machine removed takes all of its with it.
  await store.allow({ machine: 'm1', profile: ref, hash: 'h3', files: [] })
  await store.allow({ machine: 'm1', profile: { ...ref, dir: '/other' }, hash: 'h3', files: [] })
  await store.revoke('m1')
  expect(store.list()).toEqual([])
})

it('remembers "Not now" for one hash, apart from the allowed list, until allowed or revoked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-declined-'))
  const store = new UiAllowStore(dir)
  const ref = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
  await store.decline({ machine: 'm1', profile: ref, hash: 'h1', files: [{ path: 'ui/a.ts', size: 3 }] })
  expect(store.declined('m1', ref.dir, 'h1')).toBe(true)
  // Declined is never allowed, and is kept in a file of its own: nothing reading the allowed list can mistake it.
  expect(store.allowed('m1', ref.dir, 'h1')).toBe(false)
  expect(store.list()).toEqual([])
  expect(JSON.parse(readFileSync(join(dir, 'ui-declined.json'), 'utf8'))).toMatchObject([{ machine: 'm1', hash: 'h1' }])
  // Kept on disk.
  expect(new UiAllowStore(dir).declined('m1', ref.dir, 'h1')).toBe(true)
  // Only for those sources: changed code is asked about again.
  expect(store.declined('m1', ref.dir, 'h2')).toBe(false)
  expect(store.declined('m2', ref.dir, 'h1')).toBe(false)
  // Allowing takes it out of the declined list, and declining again takes it out of the allowed one.
  await store.allow({ machine: 'm1', profile: ref, hash: 'h1', files: [] })
  expect(store.declinedList()).toEqual([])
  expect(store.allowed('m1', ref.dir, 'h1')).toBe(true)
  await store.decline({ machine: 'm1', profile: ref, hash: 'h2', files: [] })
  expect(store.list()).toEqual([])
  expect(store.declinedList()).toHaveLength(1)
  // Revoke clears it too: the window asks again.
  await store.revoke('m1', ref.dir)
  expect(store.declinedList()).toEqual([])
  expect(new UiAllowStore(dir).declined('m1', ref.dir, 'h2')).toBe(false)
})
