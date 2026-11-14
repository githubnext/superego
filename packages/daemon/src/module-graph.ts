// What a profile's module runs: the module and the local files it imports, each and every one, as they are now. A
// profile's modules load by URLs versioned by that, `file:///…/vault.ts?superego-v=<hash>`, and the modules they import
// (their own files, not packages) the same way, each by its own: an edit to a helper versions it and everything that
// imports it, so the next load runs the new code rather than Node's cached copy; a helper two extensions share, at one
// version, is one module, as it would be without versions.
//
// Imports are found by reading the source: `import … from`, `export … from`, `import '…'` and `import('…')` with a
// literal path. A path worked out as it runs isn't seen: it loads at the version of the module importing it, so an edit
// to it alone isn't. Packages (bare names, and anything under node_modules) aren't versioned: they load once.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The query parameter a module's version goes in. */
export const VERSION_PARAM = 'superego-v'

const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*(['"])([^'"\n]+)\1/g
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx']

const isFile = (path: string) => existsSync(path) && statSync(path).isFile()
const isPackage = (path: string) => /[\\/]node_modules[\\/]/.test(path)

/** The local file `specifier` names, imported from `from`: tried as given, then with an extension, then as a folder's index. */
export function resolveLocal(from: string, specifier: string): string | undefined {
  const bare = specifier.replace(/[?#].*$/, '')
  if (!/^(\.{1,2}\/|\/|file:)/.test(bare)) return undefined
  const base = bare.startsWith('file:') ? fileURLToPath(bare) : resolve(dirname(from), bare)
  const found = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => resolve(base, `index${ext}`))].find(isFile)
  return found && !isPackage(found) ? found : undefined
}

/** The local files `entries` import, they included, each once, in the order first met. */
export function graphOf(entries: string[]): string[] {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    let source: string
    try { source = readFileSync(file, 'utf8') } catch { return }
    for (const [, , specifier] of source.matchAll(IMPORT)) {
      const imported = resolveLocal(file, specifier!)
      if (imported) visit(imported)
    }
  }
  for (const entry of entries) visit(resolve(entry))
  return [...seen]
}

/**
 * A module's version: a hash of it and every local file it imports. Of one that imports none, of its contents alone (as
 * a file listed from outside a profile was always hashed).
 */
export function versionOf(file: string): string {
  const files = graphOf([file])
  const hash = createHash('sha256')
  if (files.length === 1) return hash.update(readFileSync(files[0]!)).digest('hex').slice(0, 16)
  for (const path of files) hash.update(path).update('\0').update(readFileSync(path)).update('\0')
  return hash.digest('hex').slice(0, 16)
}

/** A module's URL at its version now. */
export const versionedUrl = (file: string) => `${pathToFileURL(file).href}?${VERSION_PARAM}=${versionOf(file)}`

/**
 * The URL a module loads by, imported by `parent`: a versioned module's local imports versioned too, each by its own
 * graph. Anything else (a package, a module the daemon itself imports) as it was.
 */
export function versionedImport(url: string, parent: string | undefined): string {
  if (!parent || !parent.includes(`${VERSION_PARAM}=`) || !url.startsWith('file:') || url.includes(`${VERSION_PARAM}=`)) return url
  const path = fileURLToPath(url.replace(/[?#].*$/, ''))
  if (isPackage(path) || !isFile(path)) return url
  return versionedUrl(path)
}
