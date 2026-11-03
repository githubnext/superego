import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Workspace packages ship TypeScript source, so they are bundled; published deps stay external.
const workspace = ['@mu/daemon', '@mu/protocol', '@mu/settings', '@mu/ui']

export default defineConfig({
  main: {
    // main.js is the app; daemon.js is the daemon the app starts, run by Electron as Node so it outlives windows.
    build: {
      externalizeDeps: { exclude: workspace },
      lib: { entry: { main: resolve(import.meta.dirname, 'src/main/main.ts'), daemon: resolve(import.meta.dirname, 'src/main/daemon.ts') } },
    },
  },
  preload: {
    // Sandboxed preloads must be CommonJS.
    build: { externalizeDeps: { exclude: workspace }, lib: { entry: resolve(import.meta.dirname, 'src/preload/preload.ts'), formats: ['cjs'] } },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: { rolldownOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    plugins: [react()],
  },
})
