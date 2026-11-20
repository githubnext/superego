// The app's daemon.js: what the app, its command line and a restarting daemon start. It runs the daemon proper,
// daemon-main.js (the app's src/daemon.ts), from a snapshot of the build, so rebuilding the app can't take code from
// under a daemon running (see @superego/daemon's snapshot.ts). It loads little itself, from the build on disk.
import app from 'superego:app-config'
import { launchDaemon } from '@superego/daemon/snapshot'

launchDaemon(app, import.meta.url, 'daemon-main.js').catch((error) => {
  console.error(error)
  process.exit(1)
})
