// Which build of the main process a window runs beside. The main process and its preload are built once as the app
// starts; the window's code can move on without them (`pnpm dev`'s server reloads it onto new sources; in a built app,
// out/ rebuilt under it), and then it calls what the main process doesn't know. So both carry a hash of the sources the
// main process and its preload were built from: the main process its own, written as out/main/build.json when they're
// built, the window the hash of those same files as it loads (renderer/window-build.ts, written anew). They differ
// once any of those files changed since the main process was built; the window then offers a restart.
//
// Sources only: the workspace's own files, not what's in node_modules (that changes with `pnpm install`, which restarts
// the dev server anyway).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'
import { BUILD_FILE } from './main/build.ts'

/** The window's module that has its build, which the renderer's build writes anew. */
export const BUILD_MODULE = fileURLToPath(new URL('./renderer/window-build.ts', import.meta.url))
/** The dev server's word to a window that the hash of the main process's sources is now another. */
export const BUILD_EVENT = 'superego:build'

type Chunk = { type: 'chunk'; name: string; isEntry: boolean; imports: string[]; dynamicImports: string[]; moduleIds: string[] }
type Bundle = Record<string, Chunk | { type: 'asset' }>

/** The source files a bundle's chunks are made of, from `entry` (a chunk's name) on, or from every chunk. */
export function bundleSources(bundle: Bundle, entry?: string): string[] {
  const chunks = new Map(Object.entries(bundle).flatMap(([file, out]) => out.type === 'chunk' ? [[file, out] as const] : []))
  const start = [...chunks].filter(([, chunk]) => entry === undefined || (chunk.isEntry && chunk.name === entry)).map(([file]) => file)
  const seen = new Set<string>()
  const files = new Set<string>()
  for (let file; (file = start.pop()) !== undefined;) {
    const chunk = chunks.get(file)
    if (!chunk || seen.has(file)) continue
    seen.add(file)
    start.push(...chunk.imports, ...chunk.dynamicImports)
    for (const id of chunk.moduleIds) {
      const path = id.replace(/[?#].*$/, '')
      if (path.startsWith('/') && !path.includes('/node_modules/')) files.add(path)
    }
  }
  return [...files].sort()
}

/** The hash of `files` as they are on disk now: one gone counts as such. */
export function hashSources(files: string[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    hash.update(`${file}\0`)
    try { hash.update(readFileSync(file)) } catch { hash.update('\0gone') }
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * The plugins that stamp a build: `main` and `preload` note what they were built from, and the preload (built after the
 * main process) writes the hash next to the main process; `renderer` gives the window the hash of those files now,
 * and in dev tells it as soon as one changes. Builds of all three in one process share what they noted.
 */
export function buildStamp(): { main: Plugin; preload: Plugin; renderer: Plugin } {
  let main: string[] = []
  let sources: string[] | undefined
  /** The hash the window was last given or told. */
  let given: string | undefined
  let dev = false
  return {
    main: {
      name: 'superego:build-main',
      generateBundle(_options, bundle) { main = bundleSources(bundle as unknown as Bundle, 'main') },
    },
    preload: {
      name: 'superego:build-preload',
      generateBundle(_options, bundle) { sources = [...new Set([...main, ...bundleSources(bundle as unknown as Bundle)])].sort() },
      writeBundle(options) {
        writeFileSync(resolve(options.dir!, '../main', BUILD_FILE), `${JSON.stringify({ build: hashSources(sources!) })}\n`)
      },
    },
    renderer: {
      name: 'superego:build-renderer',
      configResolved(config) { dev = config.command === 'serve' },
      load(id) {
        if (id.replace(/[?#].*$/, '') !== BUILD_MODULE) return
        // Unknown without a main process built in this run (`electron-vite dev --rendererOnly`): nothing to compare.
        given = sources && hashSources(sources)
        return buildModule(given, dev)
      },
      configureServer(server) { watchSources(server, () => sources, (build) => {
        if (build === given) return
        given = build
        // The next load of the page is given it afresh, and the one open now is told.
        for (const module of server.moduleGraph.getModulesByFile(BUILD_MODULE) ?? []) server.moduleGraph.invalidateModule(module)
        server.ws.send({ type: 'custom', event: BUILD_EVENT, data: { build } })
      }) },
    },
  }
}

/** The window's module: its build, and (in dev) word of the next. */
function buildModule(build: string | undefined, dev: boolean) {
  return `export const build = ${JSON.stringify(build)}\n` + (dev
    ? `export function onBuild(listener) {
  const hot = import.meta.hot
  if (!hot) return () => {}
  const on = (data) => listener(data.build)
  hot.on(${JSON.stringify(BUILD_EVENT)}, on)
  return () => hot.off(${JSON.stringify(BUILD_EVENT)}, on)
}\n`
    : 'export function onBuild() { return () => {} }\n')
}

/** Watch the main process's sources: `changed` with their hash, a moment after any of them changes. */
function watchSources(server: ViteDevServer, sources: () => string[] | undefined, changed: (build: string) => void) {
  const files = sources()
  if (!files) return
  const watched = new Set(files)
  server.watcher.add(files)
  let timer: ReturnType<typeof setTimeout> | undefined
  const look = (path: string) => {
    if (!watched.has(path)) return
    clearTimeout(timer)
    timer = setTimeout(() => changed(hashSources(sources() ?? files)), 100)
  }
  server.watcher.on('change', look)
  server.watcher.on('add', look)
  server.watcher.on('unlink', look)
}
