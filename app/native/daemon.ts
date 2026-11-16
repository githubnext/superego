// Separate spike entry: no Electron imports, no dependence on the source checkout at runtime.
import { openDaemon, listen } from '@superego/daemon'
import { serveWeb } from '../../packages/daemon/src/web.ts'
import { WebDevices } from '../../packages/daemon/src/web-devices.ts'
import { writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import askUser from '@superego/ask-user/daemon'
import ego from '@superego/ego/daemon'
import files from '@superego/files/daemon'
import git from '@superego/git/daemon'
import images from '@superego/images/daemon'
import paneUi from '@superego/pane-ui/daemon'
import answerUi from '@superego/answer-ui/daemon'
import skills from '@superego/skills/daemon'
import tasks from '@superego/tasks/daemon'
import terminal from '@superego/terminal/daemon'
import threadReports from '@superego/thread-reports/daemon'
import threadTools from '@superego/thread-tools/daemon'
import suggestions from '@superego/suggestions/daemon'
import webPanes from '@superego/web-panes/daemon'
import worktrees from '@superego/worktrees/daemon'
import app from '../superego.config.ts'

const dataDir = process.env.SUPEREGO_HOME
if (!dataDir) throw new Error('Native spike requires an explicit SUPEREGO_HOME')
const root = join(dirname(process.execPath), '../Resources/renderer')
const daemon = await openDaemon({ app, dataDir, defaultCwd: process.env.SUPEREGO_CWD ?? dataDir,
  agentsDir: process.env.SUPEREGO_AGENTS, extensions: [worktrees, askUser, ego, files, git, images, paneUi, answerUi, skills, tasks, terminal, threadTools, threadReports, suggestions, webPanes] })
const socket = await listen(daemon, join(dataDir, 'superego.sock'))
const devices = await WebDevices.open(dataDir)
const web = await serveWeb({ root, port: 0, devices, serve: (peer) => daemon.serve(peer) })
// The shell's web view pairs itself with a ticket; paired already (it keeps the cookie), it leaves the ticket unspent.
await writeFile(join(dataDir, 'native-endpoint.json'), JSON.stringify({ pid: process.pid, url: `${web.url}/#pair=${devices.pair().ticket}` }), { mode: 0o600 })
console.error(`Native daemon ${process.pid}: ${web.url}`)
async function stop() {
  await rm(join(dataDir, 'native-endpoint.json'), { force: true })
  await web.close()
  socket.close()
  await daemon.close()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
