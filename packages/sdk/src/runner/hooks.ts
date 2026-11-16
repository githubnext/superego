// How `superego extension test` loads an author's files, in a process of its own: as the daemon and the window load
// them. A .ts file is Node's own (its types stripped, as the daemon runs a profile's modules); a .tsx or .jsx file is
// compiled as the window compiles a UI half (profiles.ts's profileModule: types stripped, JSX turned into calls to
// 'react/jsx-runtime'). 'superego', 'superego/ui', 'superego/testing', 'vitest', React and the rest an author imports
// are this Superego's own modules (`provide`), not packages: there are none in a profile's folder. Each loads only for
// a file that imports it: a worker starts with none of them.
import { readFileSync, realpathSync } from 'node:fs'
import nodeModule from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'sucrase'
import { packagesOf } from '@superego/daemon/module-graph'

type Namespace = Record<string, unknown>
/** Each module an author imports by name, loaded when a file imports it (`ready`): most take far longer than the tests. */
const loaders: Record<string, () => Promise<Namespace>> = {}
/** What `ready` loaded, where the modules standing in for them find it. */
const KEY = '__superegoAuthorModules'
const provided: Record<string, Namespace> = {}
;(globalThis as unknown as Record<string, typeof provided>)[KEY] = provided

const identifier = /^[A-Za-z_$][\w$]*$/

/**
 * The author's modules, by URL: the test files, and the files they import (not packages). Only these get the modules
 * given to `provide` by name: Superego's own, loading, import React and vitest themselves.
 */
const authors = new Set<string>()
const bare = (url: string) => url.replace(/[?#].*$/, '')

/** A module that is `name`'s namespace as `ready` loaded it: its exports at the time it's first imported. */
function sourceOf(name: string): string {
  const module = provided[name]
  if (!module) throw new Error(`'${name}' wasn't loaded before a module imported it: import it by name, in an import or an import() of a literal`)
  const names = Object.keys(module).filter((key) => key !== 'default' && identifier.test(key))
  return [
    `const m = globalThis.${KEY}[${JSON.stringify(name)}];`,
    names.length ? `export const { ${names.join(', ')} } = m;` : '',
    'default' in module ? 'export default m.default;' : '',
  ].join('\n')
}

/** The modules an author imports by these names, each loaded as a file first needs it (`ready`). */
export function provide(modules: Record<string, () => Promise<Namespace>>) {
  Object.assign(loaders, modules)
}

/**
 * Load the modules given to `provide` that `file` and the local files it imports name: all of them when that can't be
 * told (an `import()` of a path worked out as it runs, or code that doesn't parse, which importing it then reports).
 */
export async function ready(file: string) {
  authors.add(pathToFileURL(realpathSync(file)).href)
  let names: string[]
  try {
    names = (await packagesOf([file])).filter((name) => Object.hasOwn(loaders, name))
  } catch {
    // Not an error of its own: importing the file does what it does, with every module it might name there.
    names = Object.keys(loaders)
  }
  await Promise.all(names.filter((name) => !provided[name]).map(async (name) => { provided[name] = await loaders[name]!() }))
}

/**
 * Load files as the daemon and the window do, from now on. CSS imported by a module of ours loads as nothing, and a
 * file imported by its URL (`./frame.html?url`) as its file: URL (in a checkout, where it isn't bundled).
 */
export function hook() {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (!context.parentURL || !authors.has(bare(context.parentURL))) return next(specifier, context)
      if (Object.hasOwn(loaders, specifier)) return { url: `data:text/javascript,${encodeURIComponent(sourceOf(specifier))}`, shortCircuit: true }
      const resolved = next(specifier, context)
      if (resolved.url.startsWith('file:') && !resolved.url.includes('/node_modules/')) authors.add(bare(resolved.url))
      return resolved
    },
    load(url, context, next) {
      if (!url.startsWith('file:')) return next(url, context)
      const path = url.replace(/[?#].*$/, '')
      if (/\?(.*&)?url(&|$)/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(path)}`, shortCircuit: true }
      if (path.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
      if (!/\.[jt]sx$/.test(path)) return next(url, context)
      const file = fileURLToPath(path)
      const { code } = transform(readFileSync(file, 'utf8'), {
        transforms: [...(path.endsWith('.tsx') ? ['typescript' as const] : []), 'jsx'],
        jsxRuntime: 'automatic', production: true, filePath: file, disableESTransforms: true,
      })
      return { format: 'module', source: code, shortCircuit: true }
    },
  })
}
