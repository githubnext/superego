// The declarations a profile's author type-checks against outside this repo: `buildTypes(dir)` writes a node_modules
// of types only, made from the real sources at build time so they can't drift from them.
//
//   <dir>/node_modules/superego/          'superego', 'superego/ui', 'superego/unstable', 'superego/testing': this
//                                         package's entries, their declarations emitted by TypeScript
//   <dir>/node_modules/@superego/*/       the workspace packages those declarations reach, emitted the same way
//   <dir>/node_modules/<package>/         every outside package they reach (pi-durable, React's types, Node's, …):
//                                         its declaration files and package.json, copied as installed
//   <dir>/stamp.json                      a hash of all of it, to tell an old copy from this one
//
// A profile's folder links its node_modules to such a folder (cli: profile-types.ts), so 'superego' and 'react' resolve
// as any package would, with no paths in its tsconfig.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sdk = dirname(fileURLToPath(import.meta.url))
const repo = join(sdk, '..', '..')
const require = createRequire(join(sdk, 'package.json'))
const ENTRIES = ['index.ts', 'ui.ts', 'unstable.ts', 'testing.ts']
/** Outside packages an author's files import themselves, beyond what the declarations reach. */
const ALSO = ['@types/react', '@types/react-dom', '@types/node']

/** `hash`: of the declarations; `source`: of what they were made from (`sourceHash`). */
export type Stamp = { hash: string; source: string }

/** The stamp of the declarations in `dir`, if there are any. */
export function stampOf(dir: string): Stamp | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'stamp.json'), 'utf8')) as Stamp } catch { return undefined }
}

/** What the declarations are made from, hashed: the workspace's sources and its lockfile. A cheap key for a cache. */
export function sourceHash(): string {
  const hash = createHash('sha256')
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === 'node_modules' || entry.startsWith('.') || entry === 'test' || entry === 'out') continue
      const path = join(dir, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (/\.(ts|tsx|json)$/.test(entry)) hash.update(relative(repo, path)).update('\0').update(readFileSync(path)).update('\0')
    }
  }
  walk(join(repo, 'packages'))
  hash.update(readFileSync(join(repo, 'pnpm-lock.yaml')))
  return hash.digest('hex').slice(0, 16)
}

/** The nearest folder at or above `file` with a package.json, and that package.json. */
function packageOf(file: string): { dir: string; json: Record<string, unknown> } {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    if (existsSync(path)) return { dir, json: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
    if (dirname(dir) === dir) throw new Error(`No package.json above ${file}`)
  }
}

/** The folder of the installed package `file` is in: the one just inside its last node_modules. */
function installedPackage(file: string): string {
  const parts = file.split(sep)
  const at = parts.lastIndexOf('node_modules')
  return parts.slice(0, at + (parts[at + 1]!.startsWith('@') ? 3 : 2)).join(sep)
}

const inNodeModules = (file: string) => file.split(sep).includes('node_modules')
const declaration = (path: string) => path.replace(/\.tsx?$/, '.d.ts')

/** A workspace package's exports with its sources swapped for their declarations. */
function typesExports(exports: unknown): unknown {
  if (typeof exports === 'string') return /\.tsx?$/.test(exports) ? { types: declaration(exports) } : exports
  if (exports && typeof exports === 'object') return Object.fromEntries(Object.entries(exports).map(([key, value]) => [key, typesExports(value)]))
  return exports
}

/**
 * Write the declarations into `dir` (replacing what's there), and its stamp. Throws when TypeScript can't emit them
 * (a type an export uses that can't be named outside, say).
 */
export async function buildTypes(dir: string): Promise<Stamp> {
  const source = sourceHash()
  const ts = (await import('typescript')).default
  const config = ts.getParsedCommandLineOfConfigFile(join(sdk, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')) } })!
  const options: import('typescript').CompilerOptions = {
    ...config.options, noEmit: false, declaration: true, emitDeclarationOnly: true, declarationMap: false, incremental: false,
    composite: false, tsBuildInfoFile: undefined, outDir: join(repo, '.types-out'), rootDir: repo, skipLibCheck: true,
  }
  const host = ts.createCompilerHost(options)
  // The workspace's packages are reached through node_modules links, which TypeScript takes for installed libraries and
  // emits nothing for: they're ours, so they're emitted like the rest.
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, file) => literals.map((literal) => {
    const resolved = ts.resolveModuleName(literal.text, containingFile, compilerOptions, host, undefined, redirected, ts.getModeForUsageLocation(file, literal, compilerOptions))
    const module = resolved.resolvedModule
    if (module && !inNodeModules(module.resolvedFileName) && !module.resolvedFileName.endsWith('.d.ts')) return { ...resolved, resolvedModule: { ...module, isExternalLibraryImport: false } }
    return resolved
  })
  const program = ts.createProgram({ rootNames: ENTRIES.map((entry) => join(sdk, 'src', entry)), options, host })
  const emitted = new Map<string, string>()
  const result = program.emit(undefined, (file, text) => emitted.set(join(repo, relative(options.outDir!, file)), text), undefined, true)
  const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(`The SDK's declarations can't be emitted:\n${ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => repo, getNewLine: () => '\n' })}`)

  mkdirSync(dirname(dir), { recursive: true })
  const temp = join(realpathSync(dirname(dir)), `${basename(dir)}.${process.pid}.tmp`)
  rmSync(temp, { recursive: true, force: true })
  const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  const modules = join(temp, 'node_modules')

  // Ours: each workspace package as installed, with declarations where its sources were, and the declarations written
  // by hand that the program read (an ambient module standing in for a package's own types, say). The SDK is 'superego'.
  const ours = new Map<string, { name: string; json: Record<string, unknown> }>()
  const ambient: string[] = []
  const standIns = new Set<string>()
  const place = (source: string) => {
    const pkg = packageOf(source)
    const name = pkg.dir === sdk ? 'superego' : pkg.json.name as string
    ours.set(pkg.dir, { name, json: pkg.json })
    return join(modules, name, relative(pkg.dir, source))
  }
  for (const file of program.getSourceFiles()) {
    if (!file.isDeclarationFile || inNodeModules(file.fileName) || program.isSourceFileDefaultLibrary(file)) continue
    const at = place(file.fileName)
    write(at, file.text)
    ambient.push(at)
    for (const [, name] of file.text.matchAll(/^declare module ['"]([^'"*]+)['"]/gm)) standIns.add(name!)
  }
  for (const [source, text] of emitted) {
    const at = place(source)
    // Each entry brings the hand-written ones along: they declare what it relies on.
    const brings = at.startsWith(join(modules, 'superego', 'src') + sep) ? ambient.map((file) => `/// <reference path="${relative(dirname(at), file)}" />\n`).join('') : ''
    write(at, brings + text)
  }
  for (const { name, json } of ours.values()) {
    write(join(modules, name, 'package.json'), JSON.stringify({ name, version: json.version, type: 'module', exports: typesExports(json.exports) }, null, 2) + '\n')
  }

  // Theirs: the installed packages' declarations that ours reach (at the versions ours use), found by a program over
  // ours that resolves each name as the package it was emitted from would; and the packages an author's files import
  // themselves, whole, so a deep import of one ('react/jsx-runtime') resolves too.
  const origin = new Map([...ours].map(([from, { name }]) => [join(modules, name), from]))
  const check = ts.createCompilerHost({})
  check.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, file) => literals.map((literal) => {
    // A package declared by hand stands in for its own types: those aren't needed.
    if (standIns.has(literal.text)) return { resolvedModule: undefined }
    const resolve = (from: string) => ts.resolveModuleName(literal.text, from, compilerOptions, check, undefined, redirected, ts.getModeForUsageLocation(file, literal, compilerOptions))
    const here = resolve(containingFile)
    if (here.resolvedModule) return here
    const at = [...origin].find(([dir]) => containingFile.startsWith(dir + sep))
    return resolve(at ? join(at[1], relative(at[0], containingFile)) : join(sdk, 'package.json'))
  })
  // An author's tests import vitest (`superego extension test` runs them): its declarations come too.
  const probe = join(temp, 'probe.d.ts')
  write(probe, "import 'vitest'\n")
  const reached = ts.createProgram({
    rootNames: [...ENTRIES.map((entry) => join(modules, 'superego', 'src', declaration(entry))), probe],
    options: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, noEmit: true, types: [], allowImportingTsExtensions: true },
    host: check,
  })
  const theirs = new Map<string, { dir: string; files: Set<string> | 'all' }>()
  const add = (dir: string, file?: string) => {
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name as string
    const had = theirs.get(name) ?? { dir, files: new Set<string>() }
    if (had.dir !== dir) throw new Error(`Two versions of ${name} in the SDK's declarations: ${had.dir} and ${dir}`)
    if (!file) had.files = 'all'
    else if (had.files !== 'all') had.files.add(file)
    theirs.set(name, had)
  }
  const typescript = realpathSync(dirname(require.resolve('typescript/package.json')))
  for (const file of reached.getSourceFiles()) {
    const path = realpathSync(file.fileName)
    if (path.startsWith(temp + sep) || path.startsWith(typescript + sep) || !inNodeModules(path)) continue
    add(installedPackage(path), path)
  }
  rmSync(probe)
  for (const name of ALSO) add(realpathSync(dirname(require.resolve(`${name}/package.json`))))
  for (const [name, { dir: from, files }] of theirs) {
    const copy = (path: string) => write(join(modules, name, relative(from, path)), readFileSync(path, 'utf8'))
    copy(join(from, 'package.json'))
    if (files !== 'all') { for (const file of files) copy(file); continue }
    const walk = (at: string) => {
      for (const entry of readdirSync(at)) {
        const path = join(at, entry)
        if (entry === 'node_modules') continue
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.d\.[cm]?ts$/.test(entry)) copy(path)
      }
    }
    walk(from)
  }

  const hash = createHash('sha256')
  const walk = (at: string) => {
    for (const entry of readdirSync(at).sort()) {
      const path = join(at, entry)
      if (statSync(path).isDirectory()) walk(path)
      else hash.update(relative(temp, path)).update('\0').update(readFileSync(path)).update('\0')
    }
  }
  walk(temp)
  const stamp: Stamp = { hash: hash.digest('hex').slice(0, 16), source }
  writeFileSync(join(temp, 'stamp.json'), JSON.stringify(stamp, null, 2) + '\n')
  rmSync(dir, { recursive: true, force: true })
  renameSync(temp, dir)
  return stamp
}

// `node packages/sdk/types.ts <dir>`: build them there.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const started = Date.now()
  const stamp = await buildTypes(process.argv[2] ?? join(sdk, '.types'))
  console.log(`Built the author types (${stamp.hash}) in ${Date.now() - started}ms`)
}
