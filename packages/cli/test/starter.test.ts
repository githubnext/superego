// The starter: `superego extension new` makes an extension that checks and passes its own tests as made, data-only or
// with a UI half, and adds itself to the profile it's in.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newExtension, testExtension } from '../src/extensions.ts'
import { addToProfile } from '../src/starter.ts'

describe('adding to a profile', () => {
  it('adds to its list, or the list where there is none, once', () => {
    const plain = `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'x' })\n`
    const one = addToProfile(plain, 'extensions', './a/daemon.ts')!
    expect(one).toContain(`defineProfile({\n  extensions: ['./a/daemon.ts'],`)
    const two = addToProfile(one, 'extensions', './b/daemon.ts')!
    expect(two).toContain(`extensions: ['./a/daemon.ts', './b/daemon.ts']`)
    expect(addToProfile(two, 'extensions', './b/daemon.ts')).toBe(two)
    expect(addToProfile(`export default { extensions: [] }`, 'extensions', './a.ts')).toBe(`export default { extensions: ['./a.ts'] }`)
    expect(addToProfile(`export default spec`, 'ui', './a.tsx')).toBeUndefined()
  })
})

describe('a new extension', () => {
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-starter-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('is data-only, or has a UI half, and type-checks and passes its tests as made', async () => {
    const profile = join(dir, 'profiles', 'default')
    const data = newExtension(profile, 'builds', 'data-only')
    expect(data.madeProfile).toBe(true)
    const ui = newExtension(profile, 'notes', 'ui')
    expect(ui.missing).toEqual([])
    const spec = await readFile(join(profile, 'profile.ts'), 'utf8')
    expect(spec).toContain(`extensions: ['./builds/daemon.ts', './notes/daemon.ts']`)
    expect(spec).toContain(`ui: ['./notes/ui.tsx']`)
    expect(await readFile(join(profile, 'notes', 'shared.ts'), 'utf8')).toMatch(/version: '0\.1\.0', api: '\^1\.\d+'/)
    expect(() => newExtension(profile, 'builds', 'ui')).toThrow(/there already/)
    expect(await testExtension(profile)).toBe(0)
  }, 240_000)
})
