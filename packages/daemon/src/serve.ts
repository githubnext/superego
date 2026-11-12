import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { readBuild } from './build.ts'
import { openDaemon } from './daemon.ts'
import { serviceInstalled, startService } from './service.ts'
import { listen } from './server.ts'
import { appEnv, defaultDataDir, pidPath, socketPath } from './paths.ts'
import type { AppConfig } from '@superego/protocol'
import type { DaemonExtension } from './extension.ts'
import type { MachineDirectory } from './meta.ts'
import type { MachineReach } from './relay.ts'
import type { MachineInfo } from '@superego/protocol'

/** Run a daemon on `socket` until SIGINT/SIGTERM. Used by `superego daemon` and by the Electron app's daemon process. */
export async function serveDaemon({ app, dataDir = defaultDataDir(app), socket = socketPath(app, dataDir), defaultCwd, extensions = [], webRoot, machines, reach }: {
  app: AppConfig; dataDir?: string; socket?: string; defaultCwd?: string; extensions?: DaemonExtension[]
  /** The window's build, for Web access. */
  webRoot?: string
  /** The machines this computer reaches (the app's list, in `dataDir`), for the meta agent. */
  machines?: (dataDir: string) => MachineDirectory
  /** The other machines this daemon reaches, from that same list (see relay.ts). */
  reach?: (dataDir: string, self: MachineInfo) => MachineReach
}) {
  const build = readBuild(import.meta.dirname)
  let restart = async (_env: Record<string, string>) => {}
  const agentsDir = appEnv(app)('AGENTS')
  const daemon = await openDaemon({ app, dataDir, defaultCwd: appEnv(app)('CWD') ?? defaultCwd ?? process.cwd(), build, extensions, ...(webRoot ? { webRoot } : {}), ...(agentsDir ? { agentsDir } : {}), ...(machines ? { machines: () => machines(dataDir) } : {}), ...(reach ? { reach: (self: MachineInfo) => reach(dataDir, self) } : {}), onRestart: (env) => void restart(env) })
  const server = await listen(daemon, socket)
  const pidFile = pidPath(dataDir)
  await writeFile(pidFile, String(process.pid))
  console.error(`${app.id} daemon ${process.pid} on ${socket}, build ${build}`)
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
  // is installed now. Clients wait meanwhile (see daemonStarting).
  restart = async (env) => {
    await writeFile(pidFile, String(process.pid))
    await close()
    // With a service installed it is the one to bring the daemon back (or, already the one running it, to restart us).
    if (serviceInstalled({ app })) {
      await rm(pidFile, { force: true })
      startService({ app })
      process.exit(0)
    }
    const successor = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } })
    successor.unref()
    await writeFile(pidFile, String(successor.pid))
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
