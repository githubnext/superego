import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Profiles import from 'superego'; under vitest that is the daemon's SDK through a shim (packages/daemon/src/profiles.ts).
  resolve: { alias: { superego: fileURLToPath(new URL('./packages/daemon/src/sdk-shim.ts', import.meta.url)) } },
  test: { include: ['packages/*/test/**/*.test.ts', 'extensions/*/test/**/*.test.ts', 'packages/app/test/**/*.test.ts'], testTimeout: 20_000 },
})
