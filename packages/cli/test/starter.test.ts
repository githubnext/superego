// The starter: `superego extension new` makes an extension that checks and passes its own tests as made, in each shape
// (a tool, a pane, a sidebar mark, a tool with a pane), and adds itself to the profile it's in.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newExtension, testExtension } from '../src/extensions.ts'
import { sharedAuthorTypes } from './author-types.ts'
import { addPaneToProfile, addToProfile, starterKind } from '../src/starter.ts'

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

describe('describing a pane in a profile', () => {
  it('adds to its panes, or panes where there are none, once', () => {
    const plain = `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: 'x' })\n`
    const one = addPaneToProfile(plain, 'a', 'the a pane')!
    expect(one).toContain(`defineProfile({\n  panes: { 'a': "the a pane" },`)
    const two = addPaneToProfile(one, 'b', "b's")!
    expect(two).toContain(`panes: { 'b': "b's", 'a': "the a pane" },`)
    expect(addPaneToProfile(two, 'b', 'again')).toBe(two)
    expect(addPaneToProfile(`defineProfile({ panes: {} })`, 'a', 'A')).toBe(`defineProfile({ panes: { 'a': "A" } })`)
    expect(addPaneToProfile(`export default spec`, 'a', 'A')).toBeUndefined()
  })
})

describe('the shape flags ask for', () => {
  it('is a tool unless told otherwise, and a badge on its own', () => {
    expect(starterKind({})).toBe('tool')
    expect(starterKind({ tool: true })).toBe('tool')
    expect(starterKind({ ui: true })).toBe('ui')
    expect(starterKind({ tool: true, ui: true })).toBe('tool-ui')
    expect(starterKind({ badge: true })).toBe('badge')
    expect(() => starterKind({ badge: true, ui: true })).toThrow(/--badge/)
  })
})

describe('a new extension', () => {
  let dir: string
  let types: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'superego-starter-'))
    types = await sharedAuthorTypes()
  }, 240_000)
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('is a tool, a pane, a mark or a tool with a pane, and type-checks and passes its tests as made', async () => {
    const profile = join(dir, 'profiles', 'default')
    const tool = newExtension(profile, 'words', 'tool', types)
    expect(tool.madeProfile).toBe(true)
    for (const [name, kind] of [['peek', 'ui'], ['failed', 'badge'], ['notes', 'tool-ui']] as const) expect(newExtension(profile, name, kind, types).missing).toEqual([])
    const spec = await readFile(join(profile, 'profile.ts'), 'utf8')
    expect(spec).toContain(`extensions: ['./words/daemon.ts', './failed/daemon.ts', './notes/daemon.ts']`)
    expect(spec).toContain(`ui: ['./peek/ui.tsx', './failed/ui.tsx', './notes/ui.tsx']`)
    expect(spec).toContain(`panes: { 'peek': `)
    expect(await readFile(join(profile, 'notes', 'shared.ts'), 'utf8')).toMatch(/version: '0\.1\.0', api: '\^5\.\d+'/)
    expect(() => newExtension(profile, 'words', 'ui', types)).toThrow(/there already/)
    expect(await testExtension(profile, undefined, types)).toBe(0)
  }, 240_000)
})
