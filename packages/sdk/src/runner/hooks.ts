// How `superego extension test` loads an author's files, in a process of its own: as the daemon and the window load
// them. A .ts file is Node's own (its types stripped, as the daemon runs a profile's modules); a .tsx or .jsx file is
// compiled as the window compiles a UI half (profiles.ts's profileModule: types stripped, JSX turned into calls to
// 'react/jsx-runtime'). 'superego', 'superego/ui', 'superego/testing', 'vitest', React and the rest an author imports
// are this Superego's own modules (`provide`), not packages: there are none in a profile's folder.
import { readFileSync } from 'node:fs'
import nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'
import { transform } from 'sucrase'

type Modules = Record<string, Record<string, unknown>>
/** What `provide` gave, where the modules standing in for them find it. */
const KEY = '__superegoAuthorModules'
const provided: Modules = {}
;(globalThis as unknown as Record<string, Modules>)[KEY] = provided

const identifier = /^[A-Za-z_$][\w$]*$/

/** A module that is `name`'s namespace as given to `provide`: its exports at the time it's first imported. */
function sourceOf(name: string): string {
  const module = provided[name]!
  const names = Object.keys(module).filter((key) => key !== 'default' && identifier.test(key))
  return [
    `const m = globalThis.${KEY}[${JSON.stringify(name)}];`,
    names.length ? `export const { ${names.join(', ')} } = m;` : '',
    'default' in module ? 'export default m.default;' : '',
  ].join('\n')
}

/** The modules an author imports by these names, as namespace objects. Until then, the names resolve as they would. */
export function provide(modules: Modules) {
  Object.assign(provided, modules)
}

/**
 * Load files as the daemon and the window do, from now on. CSS imported by a module of ours loads as nothing (in a
 * checkout, where it isn't bundled).
 */
export function hook() {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (Object.hasOwn(provided, specifier)) return { url: `data:text/javascript,${encodeURIComponent(sourceOf(specifier))}`, shortCircuit: true }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (!url.startsWith('file:')) return next(url, context)
      const path = url.replace(/[?#].*$/, '')
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
