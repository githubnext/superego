// The build of an app on Superego, for its electron.vite.config.ts: `export default superegoConfig(import.meta.dirname)`.
// Main and daemon come from the app's src/main.ts and src/daemon.ts, the preload from @superego/app, the renderer from
// src/renderer. Everything is bundled (only Electron itself stays out), so a packaged app carries no node_modules: the
// daemon, run by the app's own Electron as Node, finds all it needs in out/. The CLI is built too (cli.js): scripts/pack-remote.ts
// packs main/ and renderer/ for another machine, where plain Node runs them.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { newPackages } from './dev-packages.ts'

export function superegoConfig(root: string) {
  return defineConfig({
    main: {
      build: {
        externalizeDeps: false,
        rolldownOptions: { external: ['electron', /^node:/] },
        lib: { entry: { main: resolve(root, 'src/main.ts'), daemon: resolve(root, 'src/daemon.ts'), ...(existsSync(resolve(root, 'src/cli.ts')) ? { cli: resolve(root, 'src/cli.ts') } : {}) } },
      },
    },
    preload: {
      // Sandboxed preloads must be CommonJS.
      build: { externalizeDeps: false, rolldownOptions: { external: ['electron'] }, lib: { entry: fileURLToPath(new URL('./preload/preload.ts', import.meta.url)), formats: ['cjs'] } },
    },
    renderer: {
      root: resolve(root, 'src/renderer'),
      build: { rolldownOptions: { input: resolve(root, 'src/renderer/index.html') } },
      // In dev, packages linked after the server started resolve without restarting by hand (see dev-packages.ts).
      plugins: [react(), newPackages(root)],
    },
  })
}
