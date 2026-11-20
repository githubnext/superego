// Claude Agent: a kind of agent whose threads run on the user's own Claude Code. A thread whose profile says
// `agent: 'claude-agent'` has every turn run by the user's installed `claude`, signed in by the user with its own
// `/login`, through the Agent SDK; Superego never sees, keeps or passes on a Claude credential (see
// docs/research/claude-code-agent.md). Off unless a profile picks it.
//
// Claude Code runs with the user's own settings, and a folder's own (`.claude/`, `.mcp.json`, `CLAUDE.md`: project.ts)
// only once the user allowed them as they are, and never where another user could change them: a thread with some not
// loaded says so (its facts), for the window's notice.
//
// What Claude Code asks before it goes on (a tool call to allow, a plan to approve) waits here, one queue per thread,
// oldest first, published in the thread's scope for every client to answer (`claude-agent.answer`); while it waits,
// the thread shows as blocked on a permission. Its questions go through agent-ui's question card instead (turn.ts).
// What the user says to always allow is kept here, by folder (always.ts), not in the folder's own settings.
// What its subagents do is kept with the thread, by their Agent call, for those calls' rows.
import { isAbsolute, join } from 'node:path'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { envName, lit, obj, opt, RpcError, str, threadEnv, union, type Json } from '@superego/protocol'
import { AlwaysAllowed } from './always.ts'
import { claudeEnv, findClaude } from './claude.ts'
import { writePlugin } from './plugin.ts'
import { projectConfig, ProjectAllowances } from './project.ts'
import {
  about, ALLOW, ANSWER, KEPT, optionsProblem, PROFILE_KEY, WAITING,
  type Answer, type Approval, type ClaudeAgentOptions, type Kept, type ProjectFacts, type SubagentSteps,
} from './shared.ts'
import { turnTask, type TurnHost } from './turn.ts'

/** The subagents a thread keeps the work of: its newest. */
const SUBAGENTS_KEPT = 20
/** How often subagents' work is saved while it goes on. */
const SAVE_MS = 250

export type ClaudeAgentSetup = {
  /** Skill folders (each with a SKILL.md) Claude Code gets in every thread: the app's own `superego` skill. */
  skills?: string[]
  /** For tests: the `claude` to run (otherwise the user's, `<APPID>_CLAUDE` when set). */
  executable?: TurnHost['executable']
  /** For tests: the environment it starts from (otherwise the daemon's, without credentials: `claudeEnv`). */
  env?: () => Record<string, string>
  /** For tests: the user's own Claude Code folder (otherwise `CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  userConfig?: string
}

/** The daemon half. */
export function claudeAgent({ skills = [], executable, env = () => claudeEnv(), userConfig }: ClaudeAgentSetup = {}) {
  return defineDaemonExtension({
    ...about,
    async setup(superego) {
      const given = process.env[envName(superego.app, 'CLAUDE')]
      // What each Claude Agent thread keeps: `{}` once it's made, before its folder's looked at.
      const kept = superego.state<Kept>({ publish: { key: KEPT, empty: {} } })

      // ── A folder's own Claude Code settings, loaded only once allowed ───────────────────────────────────────────
      const allowances = new ProjectAllowances(join(superego.dataDir, 'claude-agent', 'allowed-projects.json'))
      await allowances.load()
      /** Look at a thread's folder again: what it has now is what its facts say. */
      const look = async (thread: string, cwd: string) => {
        const project = projectConfig(cwd, userConfig)
        await kept.update(thread, ({ project: _, ...rest } = {}) => project ? { ...rest, project } : rest)
        superego.invalidate()
        return project
      }

      superego.facts<Kept>(({ state }) => {
        const project = state?.project
        if (!project) return undefined
        return { ...project, allowed: allowances.allowed(project), changed: allowances.changed(project) } satisfies ProjectFacts as Json
      })

      superego.action(defineAction({
        id: ALLOW, title: "Allow a folder's Claude Code settings", expose: ['ui', 'cli'], consent: true,
        description: "Load a folder's own Claude Code settings (.claude/, .mcp.json) and instructions (CLAUDE.md, CLAUDE.local.md) in Claude Agent threads there, as they are now: their hooks, MCP servers and permissions run commands, and Claude Code follows the instructions. Again after they change. `hash`: the one shown, refused if they changed since.",
        params: obj({ cwd: str(), hash: opt(str()) }),
        async run({ cwd, hash }) {
          if (!isAbsolute(cwd)) throw new RpcError('invalid', `${cwd}: give the folder's whole path`, { hint: 'superego do claude-agent.allow --cwd "$PWD"' })
          const project = projectConfig(cwd, userConfig)
          if (!project) throw new RpcError('not_found', `${cwd} has no Claude Code settings or CLAUDE.md of its own`)
          if (hash && hash !== project.hash) throw new RpcError('changed', `${cwd}'s Claude Code settings changed since: look at them again`)
          if (project.unsafe) throw new RpcError('unsafe', `Claude Code would also load settings from ${project.unsafe} there, which another user on this computer can change: they can't be allowed`)
          await allowances.allow(project)
          // Its threads say so now.
          for (const thread of await superego.threads.list()) {
            const state = await kept.get(thread.id)
            if (state?.project?.cwd === project.cwd) await kept.update(thread.id, (current) => ({ ...current, project }))
          }
          superego.invalidate()
          return project
        },
      }))

      // The skills as a plugin of the daemon's own, made again as it starts (the build it runs may be new).
      const plugin = skills.length ? await writePlugin(join(superego.dataDir, 'claude-agent', 'plugin'), skills) : undefined
      // ── What Claude Code waits on the user for ──────────────────────────────────────────────────────────────────
      const always = new AlwaysAllowed(join(superego.dataDir, 'claude-agent', 'always-allowed.json'))
      await always.load()
      const waiting = superego.scopedValue<Approval[]>(WAITING, [])
      const answers = new Map<string, (answer: Answer) => void>()

      /** Publish `approval` as waiting until it's answered, or withdrawn (`signal`): the answer. */
      async function ask(approval: Approval, signal: AbortSignal): Promise<Answer> {
        signal.throwIfAborted()
        const answered = new Promise<Answer>((resolve, reject) => {
          answers.set(approval.id, resolve)
          signal.addEventListener('abort', () => reject(new Error('Withdrawn: the turn stopped')), { once: true })
        })
        waiting.update(approval.thread, (list) => [...list.filter((a) => a.id !== approval.id), approval as Approval & Json])
        superego.invalidate()
        try {
          return await answered
        } finally {
          answers.delete(approval.id)
          const left = waiting.get(approval.thread).filter((a) => a.id !== approval.id)
          if (left.length) waiting.set(approval.thread, left)
          else waiting.delete(approval.thread)
          superego.invalidate()
        }
      }

      superego.status((thread) => {
        const first = waiting.get(thread)[0]
        return first ? { kind: 'permission', msg: first.title } : undefined
      })

      superego.action(defineAction({
        id: ANSWER, title: 'Answer what Claude Code asks', runs: 'machine', expose: ['ui', 'cli'],
        description: 'Allow what a Claude Agent thread waits on (once, or always, as Claude Code offers), or deny it, saying why or what to do instead.',
        params: obj({ id: str(), choice: union([lit('allow'), lit('always'), lit('deny')]), message: opt(str()) }),
        run({ id, choice, message }) {
          const answer = answers.get(id)
          if (!answer) throw new RpcError('not_found', 'That is no longer waiting')
          const approval = waiting.scopes().flatMap((scope) => waiting.get(scope)).find((a) => a.id === id)
          if (choice === 'always' && !approval?.always) throw new RpcError('invalid', 'Claude Code offers no "always" for this')
          // Taken now, so a second answer at the same moment (another window) is told it's no longer waiting.
          answers.delete(id)
          answer({ choice, ...(message?.trim() ? { message: message.trim() } : {}) })
          return null
        },
      }))

      // ── Subagents' work, kept with each thread ───────────────────────────────────────────────────────────────────
      const unsaved = new Map<string, Map<string, SubagentSteps>>()
      let timer: ReturnType<typeof setTimeout> | undefined
      const save = async () => {
        timer = undefined
        const all = [...unsaved]
        unsaved.clear()
        for (const [thread, calls] of all) {
          await kept.update(thread, (current) => {
            const next = { ...current?.subagents, ...Object.fromEntries(calls) }
            const newest = Object.entries(next).sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0)).slice(0, SUBAGENTS_KEPT)
            return { ...current, subagents: Object.fromEntries(newest) }
          }).catch((error: unknown) => console.error(`Claude Agent: keeping thread ${thread}'s subagents failed:`, error))
        }
      }
      const subagent = (thread: string, call: string, work: SubagentSteps) => {
        const calls = unsaved.get(thread) ?? unsaved.set(thread, new Map()).get(thread)!
        calls.set(call, { ...work, at: Date.now() })
        timer ??= setTimeout(() => void save(), SAVE_MS)
      }

      // ── A profile's choices ───────────────────────────────────────────────────────────────────────────────────────
      superego.profileKey(PROFILE_KEY, { title: 'Claude Agent', check: optionsProblem })
      // Read from each thread's profile as it sends (a profile edited applies from the next turn), for its turn.
      const chosen = new Map<string, ClaudeAgentOptions>()
      superego.agentParts((thread) => {
        const options = thread.profile?.spec[PROFILE_KEY] as ClaudeAgentOptions | undefined
        if (options) chosen.set(thread.id, options)
        else chosen.delete(thread.id)
      })

      superego.thread<Kept>({
        // A Claude Agent thread's folder is looked at once it's made (where it works, a worktree's say), for the window
        // to say before its first turn what that turn would go without.
        starting(draft) { if (draft.profile?.spec.agent === 'claude-agent') return { state: {} } },
        async started(thread) { if (await kept.get(thread.id)) await look(thread.id, thread.cwd) },
        archived(thread) { chosen.delete(thread.id) },
      })

      superego.agentKind({
        name: 'claude-agent',
        runner: turnTask('claude-agent.turn', {
          executable: executable ?? (() => findClaude(given)),
          // Marked with its thread, as a Superego thread's shell is: `superego` run there knows who's calling (see threadEnv).
          env: (thread) => ({ ...env(), [threadEnv(superego.app)]: thread }),
          ...(plugin ? { plugin } : {}),
          threadOf: (conversationId) => superego.threads.of(conversationId),
          async sources(conversationId, cwd) {
            const thread = superego.threads.of(conversationId)
            const project = thread ? await look(thread, cwd) : projectConfig(cwd, userConfig)
            return project && allowances.allowed(project) ? ['user', 'project', 'local'] : ['user']
          },
          options: (thread) => chosen.get(thread) ?? {},
          rules: (cwd) => always.rules(cwd),
          remember: (cwd, rules) => always.remember(cwd, rules),
          ask,
          subagent,
        }),
      })
      // What's still to be saved is, before the daemon goes.
      return async () => {
        if (timer) clearTimeout(timer)
        await save()
      }
    },
  })
}

export default claudeAgent()
