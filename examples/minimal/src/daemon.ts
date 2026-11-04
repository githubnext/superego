// The daemon: Electron's binary run as Node, started detached by the app or `mu-minimal`, so agents outlive the app.
import { homedir } from 'node:os'
import { serveDaemon } from '@mu/daemon'
import app from '../mu.config.ts'

serveDaemon({ app, defaultCwd: homedir(), extensions: [] }).catch((error) => {
  console.error(error)
  process.exit(1)
})
