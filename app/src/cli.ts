// The command line as the remote bundle runs it: `node main/cli.js`, with its daemon (daemon.js) and the window's web
// build (../renderer) beside it. From source, `bin/superego.ts` is the same thing.
import { dirname, join } from 'node:path'
import { runCli } from '@superego/cli'
import app from '../superego.config.ts'

// The daemon by the path this was run by, not the real one: installed, that goes through the `app` link to the current
// build (see @superego/client's install.ts), so the daemon started, its successor and a service's unit all run whatever
// is installed when they start, while this process's own code stays the build it was.
const entry = process.argv[1]?.endsWith('cli.js') ? dirname(process.argv[1]) : import.meta.dirname

runCli(app, {
  appDir: join(import.meta.dirname, '../..'),
  bin: import.meta.filename,
  daemon: join(entry, 'daemon.js'),
})
