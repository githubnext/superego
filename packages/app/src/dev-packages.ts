// Dev only: packages that arrive while the window's dev server runs (a new workspace extension, after `pnpm install`)
// stay "Failed to resolve import", because Vite's resolver caches what it looked up and its watcher skips node_modules.
// This notices installs (pnpm rewrites node_modules/.modules.yaml at the end of each) and new links beside the app, and
// restarts the dev server in place: the resolver starts fresh and the window reloads. The window's "Reload, picking up
// new packages" action asks for the same restart.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from 'vite'

/** Where the window asks for the restart; the window gets it as `__SUPEREGO_DEV_SERVER__`, defined only in dev. */
export const RELOAD_PATH = '/__superego/reload-packages'

/** The packages linked in a node_modules folder, scopes opened: `@superego/tasks`, `react`, …, sorted. */
export function linkedPackages(nodeModules: string): string[] {
  const list = (dir: string) => { try { return readdirSync(dir).filter((name) => !name.startsWith('.')) } catch { return [] } }
  return list(nodeModules).flatMap((name) => name.startsWith('@') ? list(join(nodeModules, name)).map((inner) => `${name}/${inner}`) : [name]).sort()
}

/** What an install looks like from here: the packages linked beside the app, and when pnpm last finished an install. */
export type PackagesState = { linked: string[]; installed: number }

export function packagesState(root: string): PackagesState {
  let installed = 0
  try { installed = statSync(join(workspaceRoot(root), 'node_modules/.modules.yaml')).mtimeMs } catch {}
  return { linked: linkedPackages(join(root, 'node_modules')), installed }
}

/** Packages linked in `after` that weren't in `before`, or null when nothing changed that needs a restart. */
export function packagesChange(before: PackagesState, after: PackagesState): { added: string[] } | null {
  const known = new Set(before.linked)
  const added = after.linked.filter((name) => !known.has(name))
  return added.length || after.installed !== before.installed || after.linked.length !== before.linked.length ? { added } : null
}

/** The pnpm workspace `root` is in (the nearest folder up with pnpm-workspace.yaml), else `root` itself. */
function workspaceRoot(root: string) {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    if (dirname(dir) === dir) return root
  }
}

export function newPackages(root: string, { every = 1000 } = {}): Plugin {
  return {
    name: 'superego:new-packages',
    apply: 'serve',
    config: () => ({ define: { __SUPEREGO_DEV_SERVER__: JSON.stringify(RELOAD_PATH) } }),
    configureServer(server) {
      const log = server.config.logger
      let known = packagesState(root)
      let restarting = false
      const restart = async (why: string) => {
        if (restarting) return
        restarting = true
        log.info(`superego: ${why}; restarting the window's dev server`, { timestamp: true })
        await server.restart()
      }
      const poll = setInterval(() => {
        const now = packagesState(root)
        const change = packagesChange(known, now)
        known = now
        if (!change) return
        // The daemon is its own process: its half of a new extension needs it restarted.
        if (change.added.length) log.info(`superego: new packages ${change.added.join(', ')}; for their daemon side, restart the daemon (daemon restart)`, { timestamp: true })
        void restart(change.added.length ? 'new packages linked' : 'packages installed')
      }, every)
      poll.unref()
      // A restart closes this server and makes another, which runs this again with its own poll.
      server.httpServer?.once('close', () => clearInterval(poll))
      server.middlewares.use(RELOAD_PATH, (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        res.end('restarting')
        void restart('asked from the window')
      })
    },
  }
}
