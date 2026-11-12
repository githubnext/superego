// The command line as the remote bundle runs it: `node main/cli.js`, with its daemon (daemon.js) and the window's web
// build (../renderer) beside it. From source, `bin/superego.ts` is the same thing.
import { join } from 'node:path'
import { runCli } from '@superego/cli'
import app from '../superego.config.ts'

runCli(app, {
  appDir: join(import.meta.dirname, '../..'),
  bin: import.meta.filename,
  daemon: join(import.meta.dirname, 'daemon.js'),
})
