import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { generate } from '../src/generate.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it.each(['full', 'minimal'] as const)('makes a %s app with its own identity, linked to the checkout', (template) => {
  dir = mkdtempSync(join(tmpdir(), 'mu-new-'))
  const made = generate({ root, dir: join(dir, 'Field Notes'), template, name: 'Field Notes' })
  expect(made.app).toEqual({ name: 'Field Notes', id: 'field-notes', glyph: 'f' })
  const read = (file: string) => readFileSync(join(made.dir, file), 'utf8')

  expect(read('mu.config.ts')).toContain("defineApp({ name: 'Field Notes', id: 'field-notes', glyph: 'f' })")
  const pkg = JSON.parse(read('package.json'))
  expect(pkg.name).toBe('field-notes')
  expect(pkg.bin).toEqual({ 'field-notes': './bin/field-notes.ts' })
  for (const [name, spec] of Object.entries(pkg.dependencies as Record<string, string>)) {
    if (name.startsWith('@mu/')) expect(spec).toMatch(new RegExp(`^link:${root}(packages|extensions)/`))
  }
  expect(existsSync(join(made.dir, 'bin/field-notes.ts'))).toBe(true)
  expect(existsSync(join(made.dir, 'node_modules')) || existsSync(join(made.dir, 'out'))).toBe(false)
  expect(read('test/smoke.sh')).toContain('FIELD_NOTES_HOME')
  expect(read('test/smoke.sh')).not.toMatch(/\bMU_(MINIMAL_)?HOME/)
  expect(JSON.parse(read('tsconfig.json')).compilerOptions.strict).toBe(true)
  expect(read('pnpm-workspace.yaml')).toContain('allowBuilds')
  if (template === 'full') expect(Object.keys(pkg.dependencies)).toEqual(expect.arrayContaining(['@mu/threads', '@mu/ask-user']))
  else expect(Object.keys(pkg.dependencies)).not.toContain('@mu/threads')

  expect(() => generate({ root, dir: made.dir, template })).toThrow(/isn't empty/)
})
