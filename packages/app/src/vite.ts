// The build of an app on Superego, for its electron.vite.config.ts: `export default superegoConfig(import.meta.dirname)`.
// Main and daemon come from the app's src/main.ts and src/daemon.ts, the preload from @superego/app, the renderer from
// src/renderer. Everything is bundled (only Electron itself stays out), so a packaged app carries no node_modules: the
// daemon, run by the app's own Electron as Node, finds all it needs in out/. Native modules can't be bundled: those
// the app depends on (NATIVE) stay out of it and are copied into out/node_modules, with the build for this platform.
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { writeCommit } from '@superego/daemon/client'
import { newPackages } from './dev-packages.ts'
import { buildStamp } from './main-build.ts'

export function superegoConfig(root: string) {
  // The app's command line, when it has one: in a packaged app, out/main/cli.js is what `<id>` runs (see command-line.ts).
  const cli = resolve(root, 'src/cli.ts')
  // With it, what `<id> extension test` runs (out/main/author-test.js): the SDK's type checker and test runner.
  const entries: Record<string, string> = existsSync(cli) ? { cli, 'author-test': authorTest(root) } : {}
  // The worker the daemon fits images for the model in (pi-durable's): beside the bundle, where it looks for it.
  entries['node-worker'] = resolve(dirname(imagesOf(root).resolve('@earendil-works/pi-durable/images/node')), 'node-worker.js')
  // Which build of the main process and preload a window runs beside (see main-build.ts).
  const stamp = buildStamp()
  return defineConfig({
    main: {
      build: {
        externalizeDeps: false,
        rolldownOptions: { external: ['electron', /^node:/, ...NATIVE] },
        lib: { entry: { main: resolve(root, 'src/main.ts'), daemon: resolve(root, 'src/daemon.ts'), ...entries } },
      },
      plugins: [
        stamp.main,
        // The commit it's built from, written in: a packaged app has no checkout to ask.
        { name: 'superego-commit', writeBundle: (options) => writeCommit(root, options.dir!) },
        { name: 'superego-native', writeBundle: (options) => copyNative(root, resolve(options.dir!, '../node_modules')) },
        // The `superego` skill (the CLI prints it, the daemon offers it to threads), where both look for it: out/skill.
        { name: 'superego-cli-skill', writeBundle: (options) => { if (existsSync(cli)) cpSync(skill(root), resolve(options.dir!, '../skill'), { recursive: true }) } },
        // Types for profile authors (out/types), which the app keeps current in <dataDir>/types and `<id> profile types`
        // links profiles to: built from the SDK's sources, again only when those changed.
        { name: 'superego-author-types', writeBundle: async (options) => { if (existsSync(cli)) await authorTypes(root, resolve(options.dir!, '../types')) } },
      ],
    },
    preload: {
      // Sandboxed preloads must be CommonJS.
      build: { externalizeDeps: false, rolldownOptions: { external: ['electron'] }, lib: { entry: fileURLToPath(new URL('./preload/preload.ts', import.meta.url)), formats: ['cjs'] } },
      plugins: [stamp.preload],
    },
    renderer: {
      root: resolve(root, 'src/renderer'),
      build: { rolldownOptions: { input: resolve(root, 'src/renderer/index.html') } },
      // In dev, packages linked after the server started resolve without restarting by hand (see dev-packages.ts).
      plugins: [react(), newPackages(root), stamp.renderer],
    },
  })
}

/** The SDK's runner for `<id> extension test`, of the @superego/cli the app at `root` depends on. */
const authorTest = (root: string) => createRequire(createRequire(resolve(root, 'package.json')).resolve('@superego/cli')).resolve('@superego/sdk/runner')

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

/** Native modules an app may depend on, loaded at run time from out/node_modules: the terminal's PTY. */
const NATIVE = ['@lydell/node-pty']

/** A `require` from where the daemon's images are fitted (pi-durable's, through @superego/daemon). */
const imagesOf = (root: string) => createRequire(createRequire(createRequire(resolve(root, 'package.json')).resolve('@superego/daemon')).resolve('@earendil-works/pi-durable/images/node'))

/**
 * Each native module the app at `root` depends on, and those of its optional dependencies installed here (the build for
 * this platform), copied into `into` as packages, so the bundle resolves them beside itself. Photon too, whose
 * WebAssembly the daemon's image worker reads from its package as it runs.
 */
function copyNative(root: string, into: string) {
  rmSync(into, { recursive: true, force: true })
  const photon = dirname(realpathSync(imagesOf(root).resolve('@silvia-odwyer/photon/photon_rs_bg.wasm')))
  cpSync(photon, resolve(into, '@silvia-odwyer/photon'), { recursive: true, dereference: true })
  const from = createRequire(resolve(root, 'package.json'))
  for (const name of NATIVE) {
    const dir = packageDir(from, name)
    if (!dir) continue
    cpSync(dir, resolve(into, name), { recursive: true, dereference: true })
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> }
    const own = createRequire(resolve(dir, 'package.json'))
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
      const found = packageDir(own, dependency)
      if (found) cpSync(found, resolve(into, dependency), { recursive: true, dereference: true })
    }
  }
}

/** Where package `name` is installed, as `require` finds it; nothing when it isn't (another platform's build). */
function packageDir(require: NodeJS.Require, name: string): string | undefined {
  let entry: string
  try { entry = realpathSync(require.resolve(name)) } catch { return undefined }
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = resolve(dir, 'package.json')
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === name) return dir
  }
  return undefined
}
