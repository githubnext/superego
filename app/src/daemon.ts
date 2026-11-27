// The daemon: Electron's binary run as Node, started detached by the app or `superego`, so agents outlive the app. Built
// as daemon-main.js, which the app's daemon.js runs from a snapshot of the build (see @superego/app's daemon.ts).
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { serveDaemon } from '@superego/daemon'
import { machineHub } from '@superego/client'
// Every bundled extension, by its daemon half, in the order the window lists their UI halves. One whose work is all in
// the window is here by its `about` alone, so this machine knows it from the start, window or not: its pane kinds told
// to agents (browser's pane), its switch in Settings, a profile doing without it. All but the sidebar
// (`threads`, required, whose name is the core's namespace: nothing to switch or do without). Whether each is required
// or optional is its own declaration (`about`), not decided here.
import agentUi from '@superego/agent-ui/daemon'
import { claudeAgent } from '@superego/claude-agent/daemon'
import ego from '@superego/ego/daemon'
import files from '@superego/files/daemon'
import git from '@superego/git/daemon'
import github from '@superego/github/daemon'
import images from '@superego/images/daemon'
import { about as links } from '@superego/links/shared'
import { about as mermaid } from '@superego/mermaid/shared'
import mcpServers from '@superego/mcp-servers/daemon'
import mentions from '@superego/mentions/daemon'
import schedules from '@superego/schedules/daemon'
import processes from '@superego/processes/daemon'
import { skillsExtension } from '@superego/skills/daemon'
import { SKILL_DIR } from '@superego/cli/skill'
import suggestions from '@superego/suggestions/daemon'
import tasks from '@superego/tasks/daemon'
import terminal from '@superego/terminal/daemon'
import threadReports from '@superego/thread-reports/daemon'
import threadTools from '@superego/thread-tools/daemon'
import { about as unread } from '@superego/unread/shared'
import { about as focus } from '@superego/focus/shared'
import { about as browser } from '@superego/browser/shared'
import worktrees from '@superego/worktrees/daemon'
import app from '../superego.config.ts'

// The window's build, for Web access: next to this file once built (out/main → out/renderer); from source, the last build.
const webRoot = [join(import.meta.dirname, '../renderer'), join(import.meta.dirname, '../out/renderer')].find((dir) => existsSync(join(dir, 'index.html')))

// The skills extension offers the app's own `superego` skill (out/skill once built), beside those in ~/.agents/skills.
const skills = skillsExtension({ own: [SKILL_DIR] })
// Claude Agent threads get it too, as a plugin for their Claude Code.
const claude = claudeAgent({ skills: [SKILL_DIR] })

// The daemon links to the machines this computer reaches (the same list the app and `superego machines` keep), to serve
// them to browsers and agents (see the daemon's relay.ts).
serveDaemon({
  app, defaultCwd: homedir(), extensions: [
    worktrees, agentUi, claude, ego, files, git, github, images, links, mcpServers, mentions, mermaid, processes, schedules, skills, suggestions, tasks, terminal, threadTools, threadReports, unread, focus, browser,
  ], ...(webRoot ? { webRoot } : {}),
  reach: (dataDir, self) => machineHub({ app, dataDir, self }),
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
