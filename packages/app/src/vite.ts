// The build of an app on mu, for its electron.vite.config.ts: `export default muConfig(import.meta.dirname)`.
// Main and daemon come from the app's src/main.ts and src/daemon.ts, the preload from @mu/app, the renderer from
// src/renderer. Workspace packages (@mu/* and any listed) ship TypeScript, so they are bundled, not left external.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export function muConfig(root: string, { bundle = [] }: { bundle?: string[] } = {}) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const workspace = [
    ...Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@mu/')),
    '@mu/protocol', '@mu/settings', '@mu/daemon', '@mu/client', '@mu/ui', '@mu/app', ...bundle,
  ]
  const exclude = [...new Set(workspace)]
  return defineConfig({
    main: {
      build: {
        externalizeDeps: { exclude },
        lib: { entry: { main: resolve(root, 'src/main.ts'), daemon: resolve(root, 'src/daemon.ts') } },
      },
    },
    preload: {
      // Sandboxed preloads must be CommonJS.
      build: { externalizeDeps: { exclude }, lib: { entry: fileURLToPath(new URL('./preload/preload.ts', import.meta.url)), formats: ['cjs'] } },
    },
    renderer: {
      root: resolve(root, 'src/renderer'),
      build: { rolldownOptions: { input: resolve(root, 'src/renderer/index.html') } },
      plugins: [react()],
    },
  })
}
