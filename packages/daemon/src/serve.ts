import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readBuild } from './build.ts'
import { openDaemon } from './daemon.ts'
import { listen } from './server.ts'
import { appEnv, defaultDataDir, socketPath } from './paths.ts'
import type { AppConfig } from '@mu/protocol'
import type { DaemonExtension } from './extension.ts'

/** Run a daemon on `socket` until SIGINT/SIGTERM. Used by `mu daemon` and by the Electron app's daemon process. */
export async function serveDaemon({ app, dataDir = defaultDataDir(app), socket = socketPath(app, dataDir), defaultCwd, extensions = [], webRoot }: {
  app: AppConfig; dataDir?: string; socket?: string; defaultCwd?: string; extensions?: DaemonExtension[]
  /** The window's build, for Web access. */
  webRoot?: string
}) {
  const build = readBuild(import.meta.dirname)
  let stop = async () => {}
  const agentsDir = appEnv(app)('AGENTS')
  const daemon = await openDaemon({ app, dataDir, defaultCwd: appEnv(app)('CWD') ?? defaultCwd ?? process.cwd(), build, extensions, ...(webRoot ? { webRoot } : {}), ...(agentsDir ? { agentsDir } : {}), onRestart: () => void stop() })
  const server = await listen(daemon, socket)
  const pidFile = join(dataDir, 'daemon.pid')
  await writeFile(pidFile, String(process.pid))
  console.error(`${app.id} daemon ${process.pid} on ${socket}, build ${build}`)
  stop = async () => {
    server.close()
    await daemon.close()
    await rm(pidFile, { force: true })
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
