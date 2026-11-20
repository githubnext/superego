// Claude Agent: a kind of agent whose threads run on the user's own Claude Code. A thread whose profile says
// `agent: 'claude-agent'` has every turn run by the user's installed `claude`, signed in by the user with its own
// `/login`, through the Agent SDK; Superego never sees, keeps or passes on a Claude credential (see
// docs/research/claude-code-agent.md). Off unless a profile picks it.
//
// Claude Code runs with the user's own settings, and a folder's own (`.claude/`, `.mcp.json`: project.ts) only once
// the user allowed them as they are, and never where another user could change them: a thread with some not loaded
// says so (its facts), for the window's notice.
import { isAbsolute, join } from 'node:path'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { obj, opt, RpcError, str, type Json } from '@superego/protocol'
import { claudeEnv, findClaude } from './claude.ts'
import { projectConfig, ProjectAllowances } from './project.ts'
import { about, ALLOW, type ProjectConfig, type ProjectFacts } from './shared.ts'
import { turnTask, type TurnHost } from './turn.ts'

/** What a thread's folder had of Claude Code configuration when last looked at: `{}` for a Claude Agent thread not looked at yet. */
type Memo = { project?: ProjectConfig }

/**
 * The daemon half; `executable`, `env` and `userConfig` (the user's own Claude Code folder) are for tests (the user's
 * `claude`, the daemon's environment and `~/.claude` otherwise).
 */
export function claudeAgent({ executable = findClaude, env = () => claudeEnv(), userConfig }: Partial<{ executable: TurnHost['executable']; env: TurnHost['env']; userConfig: string }> = {}) {
  return defineDaemonExtension({
    ...about,
    async setup(superego) {
      const allowances = new ProjectAllowances(join(superego.dataDir, 'claude-agent', 'allowed-projects.json'))
      await allowances.load()
      const memos = superego.state<Memo>()
      /** Look at a thread's folder again: what it has now is what its facts say. */
      const look = async (thread: string, cwd: string) => {
        const project = projectConfig(cwd, userConfig)
        await memos.set(thread, project ? { project } : {})
        superego.invalidate()
        return project
      }

      superego.agentKind({
        name: 'claude-agent',
        runner: turnTask('claude-agent.turn', {
          executable, env,
          async sources(conversationId, cwd) {
            const thread = superego.threads.of(conversationId)
            const project = thread ? await look(thread, cwd) : projectConfig(cwd, userConfig)
            return project && allowances.allowed(project) ? ['user', 'project', 'local'] : ['user']
          },
        }),
      })

      superego.thread<Memo>({
        // A Claude Agent thread's folder is looked at once it's made (where it works, a worktree's say), for the window
        // to say before its first turn what that turn would go without.
        starting(draft) { if (draft.profile?.spec.agent === 'claude-agent') return { state: {} } },
        async started(thread) { if (await memos.get(thread.id)) await look(thread.id, thread.cwd) },
      })

      superego.facts<Memo>(({ state }) => {
        const project = state?.project
        if (!project) return undefined
        return { ...project, allowed: allowances.allowed(project), changed: allowances.changed(project) } satisfies ProjectFacts as Json
      })

      superego.action(defineAction({
        id: ALLOW, title: "Allow a folder's Claude Code settings", expose: ['ui', 'cli'], consent: true,
        description: "Load a folder's own Claude Code settings (.claude/, .mcp.json) in Claude Agent threads there, as they are now: their hooks, MCP servers and permissions run commands. Again after they change. `hash`: the one shown, refused if they changed since.",
        params: obj({ cwd: str(), hash: opt(str()) }),
        async run({ cwd, hash }) {
          if (!isAbsolute(cwd)) throw new RpcError('invalid', `${cwd}: give the folder's whole path`, { hint: 'superego do claude-agent.allow --cwd "$PWD"' })
          const project = projectConfig(cwd, userConfig)
          if (!project) throw new RpcError('not_found', `${cwd} has no Claude Code settings of its own`)
          if (hash && hash !== project.hash) throw new RpcError('changed', `${cwd}'s Claude Code settings changed since: look at them again`)
          if (project.unsafe) throw new RpcError('unsafe', `Claude Code would also load settings from ${project.unsafe} there, which another user on this computer can change: they can't be allowed`)
          await allowances.allow(project)
          // Its threads say so now.
          for (const thread of await superego.threads.list()) {
            const memo = await memos.get(thread.id)
            if (memo?.project?.cwd === project.cwd) await memos.set(thread.id, { project })
          }
          superego.invalidate()
          return project
        },
      }))
    },
  })
}

export default claudeAgent()
