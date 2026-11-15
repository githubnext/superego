// `superego` inside the packaged app: this file, built to out/main/cli.js, run on the app's own Electron as Node by the
// script Settings → Command line installs. From a checkout, bin/superego.ts runs instead.
import { join } from 'node:path'
import { runCli } from '@superego/cli'
import app from '../superego.config.ts'

const appDir = join(import.meta.dirname, '..', '..')
runCli(app, { appDir, bin: join(import.meta.dirname, 'cli.js'), daemon: join(import.meta.dirname, 'daemon.js'), executable: process.execPath })
