import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Where ssh's master sockets go when a test's data dir is too long for one (see @superego/client's ssh.ts): a
// directory of this run's own, not the shared /tmp.
const runtime = mkdtempSync(join(tmpdir(), 'superego-test-run-'))
process.on('exit', () => rmSync(runtime, { recursive: true, force: true }))

export default defineConfig({
  // Profiles import from 'superego'; under vitest that is the daemon's SDK through a shim (packages/daemon/src/profiles.ts).
  resolve: { alias: { superego: fileURLToPath(new URL('./packages/daemon/src/sdk-shim.ts', import.meta.url)) } },
  test: {
    include: ['app/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'extensions/*/test/**/*.test.ts', 'packages/app/test/**/*.test.ts'], testTimeout: 20_000,
    env: { XDG_RUNTIME_DIR: runtime },
  },
})
