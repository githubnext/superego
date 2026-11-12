// The daemon: Electron's binary run as Node, started detached by the app or `superego`, so agents outlive the app.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { serveDaemon } from '@superego/daemon'
import askUser from '@superego/ask-user/daemon'
import files from '@superego/files/daemon'
import app from '../superego.config.ts'

// The window's build, for Web access: next to this file once built (out/main → out/renderer); from source, the last build.
const webRoot = [join(import.meta.dirname, '../renderer'), join(import.meta.dirname, '../out/renderer')].find((dir) => existsSync(join(dir, 'index.html')))

serveDaemon({ app, defaultCwd: homedir(), extensions: [askUser, files], ...(webRoot ? { webRoot } : {}) }).catch((error) => {
  console.error(error)
  process.exit(1)
})
