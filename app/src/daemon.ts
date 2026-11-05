// The daemon: Electron's binary run as Node, started detached by the app or `mu`, so agents outlive the app.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { serveDaemon } from '@mu/daemon'
import askUser from '@mu/ask-user/daemon'
import app from '../mu.config.ts'

// The window's build, for Web access: next to this file once built (out/main → out/renderer); from source, the last build.
const webRoot = [join(import.meta.dirname, '../renderer'), join(import.meta.dirname, '../out/renderer')].find((dir) => existsSync(join(dir, 'index.html')))

serveDaemon({ app, defaultCwd: homedir(), extensions: [askUser], ...(webRoot ? { webRoot } : {}) }).catch((error) => {
  console.error(error)
  process.exit(1)
})
