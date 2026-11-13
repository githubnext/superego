// Separate spike entry: no Electron imports, no dependence on the source checkout at runtime.
import { openDaemon, listen } from '@superego/daemon'
import { serveWeb, webToken } from '../../packages/daemon/src/web.ts'
import { MachineStore } from '@superego/client'
import { writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import askUser from '@superego/ask-user/daemon'
import files from '@superego/files/daemon'
import git from '@superego/git/daemon'
import images from '@superego/images/daemon'
import skills from '@superego/skills/daemon'
import tasks from '@superego/tasks/daemon'
import threadTools from '@superego/threads/daemon'
import suggestions from '@superego/suggestions/daemon'
import webPanes from '@superego/web-panes/daemon'
import app from '../superego.config.ts'

const dataDir = process.env.SUPEREGO_HOME
if (!dataDir) throw new Error('Native spike requires an explicit SUPEREGO_HOME')
const root = join(dirname(process.execPath), '../Resources/renderer')
const daemon = await openDaemon({ app, dataDir, defaultCwd: process.env.SUPEREGO_CWD ?? dataDir,
  agentsDir: process.env.SUPEREGO_AGENTS, extensions: [askUser, files, git, images, skills, tasks, threadTools, suggestions, webPanes], machines: () => new MachineStore(dataDir) })
const socket = await listen(daemon, join(dataDir, 'superego.sock'))
const web = await serveWeb({ root, host: '127.0.0.1', port: 0, token: await webToken(dataDir), serve: (peer) => daemon.serve(peer) })
await writeFile(join(dataDir, 'native-endpoint.json'), JSON.stringify({ pid: process.pid, url: web.url }), { mode: 0o600 })
console.error(`Native daemon ${process.pid}: ${web.url.split('#')[0]}`)
async function stop() {
  await rm(join(dataDir, 'native-endpoint.json'), { force: true })
  await web.close()
  socket.close()
  await daemon.close()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
