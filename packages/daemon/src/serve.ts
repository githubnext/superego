import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readBuild } from './build.ts'
import { openDaemon } from './daemon.ts'
import { listen } from './server.ts'
import { appEnv, defaultDataDir, socketPath } from './paths.ts'
import type { AppConfig } from '@mu/protocol'

/** Run a daemon on `socket` until SIGINT/SIGTERM. Used by `mu daemon` and by the Electron app's daemon process. */
export async function serveDaemon({ app, dataDir = defaultDataDir(app), socket = socketPath(app, dataDir), defaultCwd }: {
  app: AppConfig; dataDir?: string; socket?: string; defaultCwd?: string
}) {
  const build = readBuild(import.meta.dirname)
  let stop = async () => {}
  const daemon = await openDaemon({ app, dataDir, defaultCwd: defaultCwd ?? appEnv(app)('CWD') ?? process.cwd(), build, onRestart: () => void stop() })
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
