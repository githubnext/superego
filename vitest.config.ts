import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'extensions/*/test/**/*.test.ts', 'packages/app/test/**/*.test.ts'], testTimeout: 20_000 } })
