// The author types' 'superego', 'superego/ui' and 'superego/testing', as an author (or their agent) reads them in
// node_modules: one file each, nothing in it pointing into Superego's own packages, and the API documented.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { beforeAll, expect, it } from 'vitest'
import { compiler } from '../src/runner/check.ts'
import { builtTypes } from '../types.ts'

let dir: string
beforeAll(async () => { dir = join(await builtTypes(), 'node_modules', 'superego') }, 240_000)

const ENTRIES = { superego: 'index.d.ts', 'superego/ui': 'ui.d.ts', 'superego/testing': 'testing.d.ts', 'superego/unstable': 'unstable.d.ts' }
const read = (file: string) => readFileSync(join(dir, file), 'utf8')

/** Each export declared in `file`, by name, and the doc comment of its first declaration ('' for none). */
function documented(file: string): Map<string, string> {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
  const docs = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    const node = ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]! : statement
    const name = (node as ts.NamedDeclaration).name?.getText(source)
    if (name && !docs.has(name)) docs.set(name, ts.getJSDocCommentsAndTags(node).map((doc) => doc.getText(source)).join('\n'))
  }
  return docs
}

it('has one file per entry, as the package exports them', () => {
  const exports = JSON.parse(read('package.json')).exports as Record<string, { types: string }>
  expect(exports).toEqual({ '.': { types: './index.d.ts' }, './ui': { types: './ui.d.ts' }, './testing': { types: './testing.d.ts' }, './unstable': { types: './unstable.d.ts' } })
})

for (const [entry, file] of Object.entries(ENTRIES)) {
  it(`${entry} points into none of Superego's own packages`, () => {
    const text = read(file)
    expect(text).not.toMatch(/@superego\/|packages\/|<reference path=/)
    const imports = [...text.matchAll(/\bfrom '([^']+)'/g)].map(([, from]) => from!)
    expect(imports.filter((from) => from.startsWith('.') || from.startsWith('/'))).toEqual([])
  })
}

it('documents every export of the stable entries', () => {
  for (const file of ['index.d.ts', 'ui.d.ts', 'testing.d.ts']) {
    const missing = [...documented(file)].filter(([name, doc]) => !doc && !name.endsWith('Icon')).map(([name]) => name)
    expect(missing, file).toEqual([])
  }
})

it('opens with what the entry is for, then the main API', () => {
  const docs = documented('ui.d.ts')
  expect(read('ui.d.ts')).toMatch(/^\/\/ 'superego\/ui': what an extension's UI half imports/)
  expect([...docs.keys()].slice(0, 3)).toEqual(['defineUiExtension', 'UiExtension', 'UiApi'])
  expect(docs.get('useValue')).toContain('A live value an extension\'s daemon half publishes')
  expect(docs.get('PaneHeader')).toBeTruthy()

  const daemon = documented('index.d.ts')
  expect([...daemon.keys()].slice(0, 3)).toEqual(['defineDaemonExtension', 'defineAction', 'DaemonExtension'])
  expect(daemon.get('DaemonApi')).toContain('What a daemon half\'s `setup` gets')
  expect(daemon.get('defineProfile')).toBeTruthy()
  // The agent's tools and the schema builders are pi-durable's and pi-schema's, named at the top.
  expect(read('index.d.ts')).toMatch(/^export \{[^}]*\bdefineTool\b[^}]*\} from '@earendil-works\/pi-durable';$/m)
  expect(read('index.d.ts')).toMatch(/^export \{[^}]*\bobj\b[^}]*\} from '@earendil-works\/pi-schema';$/m)

  const testing = documented('testing.d.ts')
  expect([...testing.keys()][0]).toBe('testDaemon')
  expect(testing.get('mountUi')).toContain('const ui = await mountUi(')
})

it("takes the entries' types for each other's: a profile's extension from 'superego' goes to testDaemon, a test window's registry to 'superego/unstable'", () => {
  const profile = mkdtempSync(join(tmpdir(), 'superego-entries-'))
  try {
    symlinkSync(join(dir, '..'), join(profile, 'node_modules'))
    writeFileSync(join(profile, 'a.test.ts'), `import { defineDaemonExtension } from 'superego'
import { mountUi, testDaemon, testThread } from 'superego/testing'
import { fileKind } from 'superego/unstable'

const extension = defineDaemonExtension({ name: 'mine', setup(superego) { superego.channel('mine', (channel) => channel.end()) } })
export const daemon = await testDaemon({ extensions: [extension] })
const ui = await mountUi()
export const kind = fileKind(ui.registry, { machine: 'local', thread: testThread() }, 'a.md')
`)
    const options = { module: 'esnext', moduleResolution: 'bundler', target: 'es2023', strict: true, noEmit: true, types: [], lib: ['es2023', 'dom'], skipLibCheck: true }
    writeFileSync(join(profile, 'tsconfig.json'), JSON.stringify({ compilerOptions: options, files: ['a.test.ts'] }))
    const run = spawnSync(compiler(), ['-p', join(profile, 'tsconfig.json'), '--pretty', 'false'], { cwd: profile, encoding: 'utf8' })
    expect(run.stdout + run.stderr).toBe('')
    expect(run.status).toBe(0)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

// A class with private members is nominal: two entries each declaring their own copy of one would take neither's for the
// other's. Such a type is an interface (or a type) in what an author sees.
it('declares no class with private members in more than one entry', () => {
  const classes = new Map<string, string[]>()
  for (const file of Object.values(ENTRIES)) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue
      const nominal = statement.members.some((m) => (m.name && ts.isPrivateIdentifier(m.name))
        || (ts.canHaveModifiers(m) && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword)))
      if (nominal) classes.set(statement.name.text, [...classes.get(statement.name.text) ?? [], file])
    }
  }
  expect([...classes].filter(([, files]) => files.length > 1)).toEqual([])
})
