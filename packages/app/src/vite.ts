// The build of an app on Superego, for its electron.vite.config.ts: `export default superegoConfig(import.meta.dirname)`.
// Main and daemon come from the app's src/main.ts and src/daemon.ts, the preload from @superego/app, the renderer from
// src/renderer. Everything is bundled (only Electron itself stays out), so a packaged app carries no node_modules: the
// daemon, run by the app's own Electron as Node, finds all it needs in out/.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { writeCommit } from '@superego/daemon/client'
import { newPackages } from './dev-packages.ts'

export function superegoConfig(root: string) {
  // The app's command line, when it has one: in a packaged app, out/main/cli.js is what `<id>` runs (see command-line.ts).
  const cli = resolve(root, 'src/cli.ts')
  return defineConfig({
    main: {
      build: {
        externalizeDeps: false,
        rolldownOptions: { external: ['electron', /^node:/] },
        lib: { entry: { main: resolve(root, 'src/main.ts'), daemon: resolve(root, 'src/daemon.ts'), ...(existsSync(cli) ? { cli } : {}) } },
      },
      plugins: [
        // The commit it's built from, written in: a packaged app has no checkout to ask.
        { name: 'superego-commit', writeBundle: (options) => writeCommit(root, options.dir!) },
        // The CLI's skill pages, where its build looks for them (out/main/cli.js → out/skill).
        { name: 'superego-cli-skill', writeBundle: (options) => { if (existsSync(cli)) cpSync(skill(root), resolve(options.dir!, '../skill'), { recursive: true }) } },
        // Types for profile authors (out/types), which the app keeps current in <dataDir>/types and `<id> profile types`
        // links profiles to: built from the SDK's sources, again only when those changed.
        { name: 'superego-author-types', writeBundle: async (options) => { if (existsSync(cli)) await authorTypes(root, resolve(options.dir!, '../types')) } },
      ],
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

/** Build the author types (@superego/sdk/types.ts, through the app's @superego/cli) into `to`, unless they're there. */
async function authorTypes(root: string, to: string) {
  const cliRequire = createRequire(createRequire(resolve(root, 'package.json')).resolve('@superego/cli'))
  const { builtTypes, stampOf } = await import(pathToFileURL(cliRequire.resolve('@superego/sdk/types')).href) as { builtTypes(): Promise<string>; stampOf(dir: string): { hash: string } | undefined }
  const from = await builtTypes()
  if (stampOf(to)?.hash === stampOf(from)?.hash) return
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}

/** The skill pages of the @superego/cli the app at `root` depends on. */
const skill = (root: string) => resolve(dirname(createRequire(resolve(root, 'package.json')).resolve('@superego/cli')), '../skill')
