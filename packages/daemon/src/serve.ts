import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { readBuild } from './build.ts'
import { openDaemon } from './daemon.ts'
import { RESTART_EXIT, restartVia, saveRestartEnv, takeRestartEnv } from './service.ts'
import { listen } from './server.ts'
import { sweepSnapshots } from './snapshot.ts'
import { appEnv, defaultDataDir, pidPath, socketPath } from './paths.ts'
import type { AppConfig, MachineInfo } from '@superego/protocol'
import type { DaemonExtension } from './extension.ts'
import type { MachineReach } from './relay.ts'

/** Run a daemon on `socket` until SIGINT/SIGTERM. Used by `superego daemon` and by the Electron app's daemon process. */
export async function serveDaemon({ app, dataDir = defaultDataDir(app), socket = socketPath(app, dataDir), defaultCwd, extensions = [], webRoot, reach }: {
  app: AppConfig; dataDir?: string; socket?: string; defaultCwd?: string; extensions?: DaemonExtension[]
  /** The window's build, for Web access. */
  webRoot?: string
  /** The other machines this daemon reaches, from that same list (see relay.ts). */
  reach?: (dataDir: string, self: MachineInfo) => MachineReach
}) {
  const build = readBuild(import.meta.dirname)
  // What the restart that started this daemon brought, when a service started it (see restart below).
  const carried = takeRestartEnv(dataDir)
  Object.assign(process.env, carried)
  let restart = async (_env: Record<string, string>) => {}
  const agentsDir = appEnv(app)('AGENTS')
  const daemon = await openDaemon({ app, dataDir, defaultCwd: appEnv(app)('CWD') ?? defaultCwd ?? process.cwd(), build, extensions, ...(webRoot ? { webRoot } : {}), ...(agentsDir ? { agentsDir } : {}), ...(reach ? { reach: (self: MachineInfo) => reach(dataDir, self) } : {}), onRestart: (env) => void restart(env) })
  const server = await listen(daemon, socket)
  const pidFile = pidPath(dataDir)
  await writeFile(pidFile, String(process.pid))
  console.error(`${app.id} daemon ${process.pid} on ${socket}, build ${build}`)
  // This data dir's daemon now: the snapshots of builds it doesn't run are no one's (see snapshot.ts). Housekeeping, so
  // one that can't be removed is said here and left for the next start.
  try { sweepSnapshots(dataDir, import.meta.dirname) } catch (error) { console.error(`Could not remove old snapshots of the build: ${error instanceof Error ? error.message : String(error)}`) }
  const close = async () => {
    server.close()
    await daemon.close()
  }
  const stop = async () => {
    await close()
    await rm(pidFile, { force: true })
    process.exit(0)
  }
  // The successor is this same command with this same environment, so whatever the daemon was started with (API keys
  // from `box run`, say) outlives restarts, plus what the restart brought: `box run superego daemon restart` adds keys
  // to a daemon started without them, and a restart from a plain shell takes none away. The code it runs is whatever
  // is installed now. Clients wait meanwhile (see daemonStarting). A service starts its successor with the unit's
  // environment, so what this one had beyond it (what earlier restarts carried, and this one's) is left for it to take.
  restart = async (env) => {
    await writeFile(pidFile, String(process.pid))
    await close()
    const extra = { ...carried, ...env }
    await saveRestartEnv(dataDir, extra)
    const via = restartVia({ app })
    if (via === 'manager') { await rm(pidFile, { force: true }); process.exit(RESTART_EXIT) }
    if (via === 'service') { await rm(pidFile, { force: true }); process.exit(0) }
    takeRestartEnv(dataDir)
    const successor = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } })
    successor.unref()
    await writeFile(pidFile, String(successor.pid))
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
