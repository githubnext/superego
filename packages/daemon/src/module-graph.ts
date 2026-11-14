// What a profile's module runs: the module and the local files it imports, each and every one, as they are now. One
// graph serves both what a reload loads and what allowing a project's profile vouches for (profiles.ts, hashProfile).
//
// A profile's modules load by URLs versioned by it, `file:///…/vault.ts?superego-v=<hash>`, and the modules they import
// (their own files, not packages) the same way, each by its own: an edit to a helper versions it and everything that
// imports it, so the next load runs the new code rather than Node's cached copy; a helper two extensions share, at one
// version, is one module, as it would be without versions.
//
// Imports are read as Node runs the module: types stripped as Node strips them (`import type` loads nothing), then its
// imports parsed (@superego/protocol's importsOf), so comments and strings are just that. Read are static imports,
// re-exports and `import()` of a literal path; an `import()` of a path worked out as it runs is refused (importsOf).
// A path resolves as Node resolves it (relative, absolute or file:, symlinks followed to the file itself); were that no
// file, as a runtime guessing extensions would (`./helper` → helper.ts, helper/index.ts), so that whatever loads is in
// it. Packages (bare names, `#imports`, anything under node_modules) aren't in it: they load once, and aren't vouched
// for. Nor is what a module loads other than by import (createRequire, a worker, a file it reads).
//
// A file is read once per version of it on disk (its size, its times and its inode): a profile checked again unchanged
// costs a stat per file.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'sucrase'
import { importsOf, RpcError } from '@superego/protocol'

/** The query parameter a module's version goes in. */
export const VERSION_PARAM = 'superego-v'

/** What a profile's code is written in: what's parsed for imports, and what in a profile's folder is a module that can run. */
export const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx']

const isFile = (path: string) => { try { return statSync(path).isFile() } catch { return false } }
const isPackage = (path: string) => /[\\/]node_modules[\\/]/.test(path)

/** Whether `file` is inside `dir`. */
export const within = (dir: string, file: string) => { const path = relative(resolve(dir), file); return Boolean(path) && !path.startsWith('..') && !isAbsolute(path) }

/** A file as read: a digest of its bytes, and the specifiers it imports (a module's), for the version of it on disk `stamp` names. */
type Read = { stamp: string; digest: string; imports: string[] }
const reads = new Map<string, Read>()

/** A module as Node runs it: TypeScript's types stripped (type-only imports with them), JSX turned into calls. */
function javascriptOf(file: string, source: string) {
  const typed = /\.[cm]?tsx?$/.test(file)
  const jsx = /x$/.test(file)
  if (!typed && !jsx) return source
  try {
    return transform(source, {
      transforms: [...(typed ? ['typescript' as const] : []), ...(jsx ? ['jsx' as const] : [])],
      // An import of values never used still loads, as Node's own type stripping keeps it.
      keepUnusedImports: true, jsxRuntime: 'automatic', production: true, filePath: file, disableESTransforms: true,
    }).code
  } catch (error) {
    throw new RpcError('invalid', `${file}: can't read its imports: ${(error as Error).message}`)
  }
}

/** `file` as it is on disk now: read again only if it changed. */
function read(file: string): Read {
  const stat = statSync(file, { bigint: true })
  const stamp = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`
  const known = reads.get(file)
  if (known?.stamp === stamp) return known
  const bytes = readFileSync(file)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const imports = CODE.test(file) && !isPackage(file) ? importsOf(javascriptOf(file, bytes.toString('utf8')), file).map((i) => i.specifier) : []
  const done = { stamp, digest, imports }
  reads.set(file, done)
  return done
}

/** A digest of `file`'s bytes as they are now. */
export const digestOf = (file: string) => read(file).digest

/**
 * The local file `specifier` names, imported from `from`, as Node resolves it (symlinks followed); were that no file, as
 * a runtime that guesses extensions would. None for a package, or a file that isn't there.
 */
export function resolveLocal(from: string, specifier: string): string | undefined {
  if (!/^(\.{0,2}\/|file:)/.test(specifier)) return undefined
  let base: string
  try { base = fileURLToPath(new URL(specifier, pathToFileURL(from))) } catch { return undefined }
  const found = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => resolve(base, `index${ext}`))].find(isFile)
  if (!found) return undefined
  const path = realpathSync(found)
  return isPackage(path) ? undefined : path
}

/**
 * The local files `entries` run: they, and every file they import, and those import, … each once (by its real path),
 * in the order first met. Throws where a module's imports can't be told (importsOf).
 */
export function graphOf(entries: string[]): string[] {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const specifier of read(file).imports) {
      const imported = resolveLocal(file, specifier)
      if (imported) visit(imported)
    }
  }
  for (const entry of entries) visit(realpathSync(resolve(entry)))
  return [...seen]
}

/** A module's version: a hash of it and every local file it imports, by path and contents. */
export function versionOf(file: string): string {
  const hash = createHash('sha256')
  for (const path of graphOf([file])) hash.update(path).update('\0').update(digestOf(path)).update('\0')
  return hash.digest('hex').slice(0, 16)
}

/** A module's URL at its version now. */
export const versionedUrl = (file: string) => `${pathToFileURL(file).href}?${VERSION_PARAM}=${versionOf(file)}`

/**
 * The URL a module loads by, imported by `parent`: a versioned module's local imports (those of its graph) versioned
 * too, each by its own graph. Anything else (a package, a name an alias points at a file) as it was.
 */
export function versionedImport(url: string, parent: string | undefined): string {
  if (!parent?.startsWith('file:') || !parent.includes(`${VERSION_PARAM}=`) || !url.startsWith('file:') || url.includes(`${VERSION_PARAM}=`)) return url
  const path = fileURLToPath(url.replace(/[?#].*$/, ''))
  if (isPackage(path) || !isFile(path)) return url
  const from = realpathSync(fileURLToPath(parent.replace(/[?#].*$/, '')))
  const file = realpathSync(path)
  return read(from).imports.some((specifier) => resolveLocal(from, specifier) === file) ? versionedUrl(file) : url
}
