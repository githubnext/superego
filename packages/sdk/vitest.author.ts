// The vitest config `superego extension test` runs an author's tests with: from their profile's folder (no
// node_modules there), 'superego', 'superego/ui', 'superego/testing' and React resolved from this Superego's own, and a
// profile's modules loaded as the daemon loads them (each at its version, so a helper edited alone loads anew).
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig } from 'vitest/config'
import { versionedImport } from '../daemon/src/module-graph.ts'

const sdk = dirname(fileURLToPath(import.meta.url))
const repo = join(sdk, '..', '..')
const root = process.env.SUPEREGO_AUTHOR_DIR ?? process.cwd()
const from = createRequire(join(sdk, 'package.json'))
const exact = (name: string, path: string) => ({ find: new RegExp(`^${name.replace(/[/.]/g, '\\$&')}$`), replacement: path })

export default defineConfig({
  root,
  cacheDir: join(tmpdir(), 'superego-author-vitest'),
  resolve: {
    alias: [
      exact('superego', join(sdk, 'src', 'index.ts')),
      exact('superego/ui', join(sdk, 'src', 'ui.ts')),
      exact('superego/testing', join(sdk, 'src', 'testing.ts')),
      exact('superego/unstable', join(sdk, 'src', 'unstable.ts')),
      ...['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map((name) => exact(name, from.resolve(name))),
    ],
  },
  plugins: [{
    // What the daemon's Node hook does for a profile's modules (profiles.ts): their own imports at their versions now.
    name: 'superego-profile-versions',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer?.includes('superego-v=')) return null
      const resolved = await this.resolve(source, importer.replace(/[?#].*$/, ''), { skipSelf: true })
      if (!resolved || resolved.external || !resolved.id.startsWith('/')) return resolved
      const url = versionedImport(pathToFileURL(resolved.id).href, `file://${importer}`)
      return url.includes('superego-v=') ? `${resolved.id}?${url.split('?')[1]}` : resolved
    },
  }],
  server: { fs: { allow: [root, repo, tmpdir()] } },
  test: { include: ['**/*.test.{ts,tsx}'], exclude: ['**/node_modules/**'], testTimeout: 30_000, hookTimeout: 30_000 },
})
