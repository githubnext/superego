import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig } from 'vitest/config'
import { versionedImport } from './packages/daemon/src/module-graph.ts'

// Where ssh's master sockets go when a test's data dir is too long for one (see @superego/client's ssh.ts): a
// directory of this run's own, not the shared /tmp.
const runtime = mkdtempSync(join(tmpdir(), 'superego-test-run-'))
process.on('exit', () => rmSync(runtime, { recursive: true, force: true }))

export default defineConfig({
  // Profiles import from 'superego'; under vitest that is the daemon's SDK through a shim (packages/daemon/src/profiles.ts).
  resolve: { alias: { superego: fileURLToPath(new URL('./packages/daemon/src/sdk-shim.ts', import.meta.url)) } },
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
  test: {
    include: ['packages/*/test/**/*.test.ts', 'extensions/*/test/**/*.test.ts'], testTimeout: 20_000,
    // The author types tests share (packages/cli/test/author-types.ts): a data dir to install them in, once a run.
    env: { XDG_RUNTIME_DIR: runtime, SUPEREGO_TEST_AUTHOR_TYPES: join(runtime, 'author') },
  },
})
