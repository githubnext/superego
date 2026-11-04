// The daemon process the app starts: Electron's binary run as Node (ELECTRON_RUN_AS_NODE), detached, so agents keep
// working after the app quits.
import { homedir } from 'node:os'
import { serveDaemon } from '@mu/daemon'

import app from '../../mu.config.ts'

serveDaemon({ app, defaultCwd: homedir() }).catch((error) => {
  console.error(error)
  process.exit(1)
})
