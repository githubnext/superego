// Claude Agent: a kind of agent whose threads run on the user's own Claude Code. A thread whose profile says
// `agent: 'claude-agent'` has every turn run by the user's installed `claude`, signed in by the user with its own
// `/login`, through the Agent SDK; Superego never sees, keeps or passes on a Claude credential (see
// docs/research/claude-code-agent.md). Off unless a profile picks it.
import { defineDaemonExtension } from '@superego/daemon'
import { claudeEnv, findClaude } from './claude.ts'
import { about } from './shared.ts'
import { turnTask, type TurnHost } from './turn.ts'

/** The daemon half; `executable` and `env` are for tests (the user's `claude` and the daemon's environment otherwise). */
export function claudeAgent({ executable = findClaude, env = () => claudeEnv() }: Partial<{ executable: TurnHost['executable']; env: TurnHost['env'] }> = {}) {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      superego.agentKind({ name: 'claude-agent', runner: turnTask('claude-agent.turn', { executable, env }) })
    },
  })
}

export default claudeAgent()
