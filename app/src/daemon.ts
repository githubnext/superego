// The daemon: Electron's binary run as Node, started detached by the app or `superego`, so agents outlive the app.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { serveDaemon } from '@superego/daemon'
// Every bundled extension's daemon half, in the order the window lists their UI halves (one with none, like links, the
// window declares to the daemon). Whether each is required or optional is its own declaration (`about`), not decided here.
import askUser from '@superego/ask-user/daemon'
import ego from '@superego/ego/daemon'
import files from '@superego/files/daemon'
import git from '@superego/git/daemon'
import images from '@superego/images/daemon'
import skills from '@superego/skills/daemon'
import suggestions from '@superego/suggestions/daemon'
import tasks from '@superego/tasks/daemon'
import threadReports from '@superego/threads/reports'
import threadTools from '@superego/threads/daemon'
import webPanes from '@superego/web-panes/daemon'
import worktrees from '@superego/worktrees/daemon'
import app from '../superego.config.ts'

// The window's build, for Web access: next to this file once built (out/main → out/renderer); from source, the last build.
const webRoot = [join(import.meta.dirname, '../renderer'), join(import.meta.dirname, '../out/renderer')].find((dir) => existsSync(join(dir, 'index.html')))

serveDaemon({ app, defaultCwd: homedir(), extensions: [worktrees, askUser, ego, files, git, images, skills, suggestions, tasks, threadTools, threadReports, webPanes], ...(webRoot ? { webRoot } : {}) }).catch((error) => {
  console.error(error)
  process.exit(1)
})
