// The daemon process the app starts: Electron's binary run as Node (ELECTRON_RUN_AS_NODE), detached, so agents keep
// working after the app quits.
import { homedir } from 'node:os'
import { serveDaemon } from '@mu/daemon'
import { defaultDataDir, socketPath } from '@mu/daemon/client'

const dataDir = defaultDataDir()
serveDaemon({ dataDir, socket: socketPath(dataDir), defaultCwd: process.env.MU_CWD ?? homedir() }).catch((error) => {
  console.error(error)
  process.exit(1)
})
