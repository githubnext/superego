// Run with a Superego checkout's vitest: `pnpm exec vitest run --config ~/.superego/profiles/chief-of-staff/test/vitest.config.mjs`
// from the checkout (SUPEREGO_REPO, if not ~/dev/gh/superego, for the daemon test). No imports: this folder has no node_modules.
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = process.env.SUPEREGO_REPO ?? process.cwd()
const here = dirname(fileURLToPath(import.meta.url))
export default {
  root: here,
  cacheDir: join(tmpdir(), 'chief-of-staff-vitest'),
  resolve: {
    alias: {
      superego: join(repo, 'packages/daemon/src/sdk-shim.ts'),
      '@superego/daemon': join(repo, 'packages/daemon/src/index.ts'),
      '@superego/protocol': join(repo, 'packages/protocol/src/index.ts'),
    },
  },
  server: { fs: { allow: [here, repo, homedir()] } },
  test: { include: ['*.test.ts'], testTimeout: 30_000 },
}
