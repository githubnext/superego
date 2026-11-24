// Claude Agent: a kind of agent whose threads run on the user's own Claude Code. A thread whose profile says
// `agent: 'claude-agent'` has every turn run by the user's installed `claude`, signed in by the user with its own
// `/login`, through the Agent SDK; Superego never sees, keeps or passes on a Claude credential (see
// docs/research/claude-code-agent.md). Off unless a thread is started on it: on one of its models in the model menu
// (offered where `claude` is installed), which starts it with the user's "claude" profile (made then, as first-run
// setup makes it), or with any profile that picks it.
//
// Settings → Claude Agent shows Claude Code on each machine (where it is, its version, whether it's signed in, as
// `claude auth status` says: never a credential), with a terminal to sign in with Claude Code's own `/login`; the
// permission mode threads start in, and how many of their turns run at once (others wait: parallel.ts).
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
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { envName, lit, obj, opt, RpcError, str, threadEnv, union, type Json } from '@superego/protocol'
import { AlwaysAllowed } from './always.ts'
import { checkClaude, claudeEnv, findClaude, NOT_INSTALLED } from './claude.ts'
import { Parallel } from './parallel.ts'
import { ClaudeProcesses } from './session.ts'
import { writePlugin } from './plugin.ts'
import { projectConfig, ProjectAllowances } from './project.ts'
import {
  about, ALLOW, ANSWER, CHECK, CLAUDE, modelLabel, DEFAULT_MODES, EFFORTS, KEPT, LIMIT, limitOf, MAKE_PROFILE, MODELS, optionsProblem, PARALLEL, PROFILE_KEY, PROFILE_NAME, SECTION,
  SETTINGS, SIGN_IN, SIGNED_OUT, TERMINAL, WAITING,
  type Answer, type ClaudeCheck, type Approval, type ClaudeAgentOptions, type Effort, type Kept, type Limit, type PermissionMode, type ProjectFacts, type SubagentSteps,
} from './shared.ts'
import { turnTask, type TurnHost } from './turn.ts'

/** The subagents a thread keeps the work of: its newest. */
const SUBAGENTS_KEPT = 20
/** How often subagents' work is saved while it goes on. */
const SAVE_MS = 250
/** How old a look at Claude Code may be when the model menus are listed before it's looked at again (behind them). */
const CHECK_STALE_MS = 60_000
/** How long the model menus wait for a look at Claude Code once what's known is old, before going on with that. */
const FRESH_WAIT_MS = 2_000
/** The terminal extension's action that runs a program in a terminal pane (terminal.run). */
const TERMINAL_RUN = 'terminal.run'
/** How long a thread's Claude Code waits for its next turn before it goes. */
const IDLE_MS = 5 * 60_000
/** How often Claude Code is looked at again while threads wait for it to be signed in. */
const SIGN_IN_POLL_MS = 30_000

export type ClaudeAgentSetup = {
  /** Skill folders (each with a SKILL.md) Claude Code gets in every thread: the app's own `superego` skill. */
  skills?: string[]
  /** For tests: the `claude` to run (otherwise the user's, `<APPID>_CLAUDE` when set). */
  executable?: TurnHost['executable']
  /** For tests: the environment it starts from (otherwise the daemon's, without credentials: `claudeEnv`). */
  env?: () => Record<string, string>
  /** For tests: the user's own Claude Code folder (otherwise `CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  userConfig?: string
  /** For tests: how long a thread's Claude Code waits for its next turn (otherwise 5 minutes). */
  idleMs?: number
}

/** The daemon half. */
export function claudeAgent({ skills = [], executable, env = () => claudeEnv(), userConfig, idleMs = IDLE_MS }: ClaudeAgentSetup = {}) {
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
        description: "Load a folder's own Claude Code settings (.claude/, .mcp.json, and the skills in .claude/skills folders below it) and instructions (CLAUDE.md, CLAUDE.local.md) in Claude Agent threads there, as they are now: their hooks, MCP servers and permissions run commands, and Claude Code follows the instructions. Again after they change. `hash`: the one shown, refused if they changed since.",
        params: obj({ cwd: str(), hash: opt(str()) }),
        async run({ cwd, hash }) {
          if (!isAbsolute(cwd)) throw new RpcError('invalid', `${cwd}: give the folder's whole path`, { hint: 'superego do claude-agent.allow --cwd "$PWD"' })
          const project = projectConfig(cwd, userConfig)
          if (!project) throw new RpcError('not_found', `${cwd} has no Claude Code settings or CLAUDE.md of its own`)
          if (hash && hash !== project.hash) throw new RpcError('changed', `${cwd}'s Claude Code settings changed since: look at them again`)
          if (project.unsafe) throw new RpcError('unsafe', `Claude Code would also load settings from ${project.unsafe} there, which another user on this computer can change: they can't be allowed`)
          if (project.tooBig) throw new RpcError('too_big', `${cwd} isn't a git repository and has too many folders below it to look through for the Claude Code skills there: its settings can't be allowed`, { hint: 'Work in a git repository, or a smaller folder.' })
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

      // ── Claude Code here: whether it's installed and signed in, for setup, Settings and the model menus ────────────
      const claude = superego.value<ClaudeCheck | null>(CLAUDE, null)
      let checked = 0
      let checking: Promise<ClaudeCheck> | undefined
      let again: Promise<ClaudeCheck> | undefined
      /**
       * Look at Claude Code here again: where it is, its version, whether it's signed in. One look at a time: asked
       * while one goes on, the next starts after it (it may have started before what's asked about, a sign-in).
       */
      const check = (): Promise<ClaudeCheck> => {
        if (!checking) return lookNow()
        return again ??= checking.catch(() => undefined).then(() => { again = undefined; return check() })
      }
      const lookNow = () => checking = (async (): Promise<ClaudeCheck> => {
        try {
          const path = await (executable ?? (() => findClaude(given)))()
          const now: ClaudeCheck = path ? { installed: true, path, ...await checkClaude(path, env()) } : { installed: false }
          checked = Date.now()
          // Gone meanwhile (the daemon stopping): nobody to tell.
          if (!superego.signal.aborted) {
            claude.set(now as ClaudeCheck & Json)
            if (now.installed && now.loggedIn) void signedIn()
          }
          return now
        } finally {
          checking = undefined
        }
      })()
      // Looked at as the daemon starts, so the model menus have it.
      void check().catch((error: unknown) => console.error('Claude Agent: looking at Claude Code here failed:', error))

      // ── Threads waiting for Claude Code to be signed in ─────────────────────────────────────────────────────────
      // A turn that failed as Claude Code isn't signed in leaves its thread waiting for it (`kind: 'auth'`), with the
      // way to sign in above its composer. Once a look finds it signed in (Settings, the card's "Check again", or every
      // half minute while threads wait), each goes on where it failed. Kept in memory: after a restart, such a thread
      // shows the turn's error instead.
      const signedOut = superego.scopedValue<boolean>(SIGNED_OUT, false)
      let polling: ReturnType<typeof setInterval> | undefined
      const poll = () => {
        if (signedOut.scopes().length && !polling) {
          polling = setInterval(() => void check().catch((error: unknown) => console.error('Claude Agent: looking at Claude Code here failed:', error)), SIGN_IN_POLL_MS)
          polling.unref?.()
        } else if (!signedOut.scopes().length && polling) { clearInterval(polling); polling = undefined }
      }
      const waitForSignIn = (thread: string) => {
        signedOut.set(thread, true)
        superego.invalidate()
        poll()
      }
      const stopWaiting = (thread: string) => {
        if (!signedOut.get(thread)) return
        signedOut.delete(thread)
        superego.invalidate()
        poll()
      }
      /** Claude Code is signed in now: the threads waiting for it go on. */
      async function signedIn() {
        for (const thread of signedOut.scopes()) {
          stopWaiting(thread)
          try {
            await (await superego.threads.conversation(thread)).submit({ type: 'continue' }, BACKGROUND_CONTEXT)
          } catch (error) {
            console.error(`Claude Agent: going on with thread ${thread} once Claude Code was signed in failed:`, error)
          }
        }
      }
      superego.status((thread) => signedOut.get(thread) ? { kind: 'auth', msg: SIGN_IN } : undefined)

      // ── The plan's limits, as the user's Claude Code reports them ────────────────────────────────────────────────
      const limit = superego.value<Limit | null>(LIMIT, null)

      // ── Each thread's Claude Code, kept running while it's in use ────────────────────────────────────────────────
      const processes = new ClaudeProcesses()

      superego.action(defineAction({
        id: CHECK, title: 'Look at Claude Code here', runs: 'machine', expose: ['ui', 'cli'],
        description: "Whether Claude Code is installed on this machine, where, its version, and whether it's signed in (claude auth status: never a credential).",
        params: obj({}),
        run: () => check(),
      }))
      /** Make the user's "claude" profile, whose threads run on Claude Code, unless there's one by that name. */
      const makeProfile = async () => {
        const dir = join(superego.dataDir, 'profiles', PROFILE_NAME)
        if (existsSync(join(dir, 'profile.ts'))) return
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'profile.ts'), `// Threads with this profile run on your Claude Code, signed in with its own /login.\nexport default { agent: 'claude-agent' }\n`)
      }
      superego.action(defineAction({
        id: MAKE_PROFILE, title: 'Make a profile that runs Claude Code', runs: 'machine', expose: ['ui', 'cli'],
        description: `The user's "${PROFILE_NAME}" profile, whose threads run on Claude Code (agent: 'claude-agent'); one there already is left as it is.`,
        params: obj({}),
        async run() {
          await makeProfile()
          return { name: PROFILE_NAME }
        },
      }))
      superego.action(defineAction({
        id: TERMINAL, title: 'Open Claude Code in a terminal', runs: 'machine',
        description: "A terminal beside a thread running this machine's claude, for the user to sign in with its own /login. A window's only.",
        params: obj({ thread: str() }),
        async run({ thread }) {
          const found = await check()
          if (!found.installed) throw new RpcError('not_found', NOT_INSTALLED)
          return await superego.dispatch(TERMINAL_RUN, { thread, command: [found.path] }) as Json
        },
      }))

      // ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────
      superego.settings.register({
        id: SECTION, title: 'Claude Agent', order: 27, ui: SECTION, value: CLAUDE,
        description: 'Threads that run your own Claude Code, on its sign-in and your plan’s limits.',
        settings: [
          {
            key: SETTINGS.permissionMode, title: 'Permission mode', description: "For threads whose profile doesn't pick one.", default: 'auto',
            type: { type: 'choice', options: DEFAULT_MODES.map((m) => ({ ...m })) },
          },
          {
            key: SETTINGS.parallel, title: 'Threads at once', description: 'How many work at the same time on this machine; the rest wait their turn.',
            default: PARALLEL, type: { type: 'number', min: 1, max: 20, step: 1 },
          },
        ],
      })
      const parallel = new Parallel(() => superego.settings.get<number>(SETTINGS.parallel), () => superego.invalidate())
      superego.settings.onChange(() => parallel.pump())
      // A turn waiting for its place works on, saying so.
      superego.status((thread) => {
        const waiting = parallel.waitingFor(thread)
        return waiting ? { working: waiting } : undefined
      })

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
      // Read from each thread's profile as it sends (a profile edited applies from the next turn), with the thread's own
      // model and effort (Claude Agent's, `claude-agent/<model>`) over the profile's, for its turn.
      const chosen = new Map<string, ClaudeAgentOptions>()
      superego.agentParts((thread) => {
        const options = { ...thread.profile?.spec[PROFILE_KEY] as ClaudeAgentOptions | undefined }
        const own = thread.model?.startsWith(`${about.name}/`) ? thread.model.slice(about.name.length + 1) : undefined
        if (own) options.model = own
        if (own && (EFFORTS as readonly string[]).includes(thread.thinking ?? '')) options.effort = thread.thinking as Effort
        else if (own) delete options.effort
        if (Object.keys(options).length) chosen.set(thread.id, options)
        else chosen.delete(thread.id)
      })

      superego.thread<Kept>({
        // A Claude Agent thread's folder is looked at once it's made (where it works, a worktree's say), for the window
        // to say before its first turn what that turn would go without.
        starting(draft) { if (draft.profile?.spec.agent === 'claude-agent') return { state: {} } },
        async started(thread) { if (await kept.get(thread.id)) await look(thread.id, thread.cwd) },
        archived(thread) { chosen.delete(thread.id); processes.close(thread.id); stopWaiting(thread.id) },
        // Sent to again (or going on): it no longer waits.
        turnStart(thread) { stopWaiting(thread.id) },
      })

      superego.agentKind({
        name: about.name,
        // Offered where Claude Code is installed; its models picked only once it's signed in. What it says when they
        // can't be is what a thread started on them by default is refused with.
        async menu() {
          // Looked at once before it's offered; after that, again when it's old: what it finds, if that's quick (a
          // thread about to start on it by default is refused once it's signed out), else what it knew, while it looks.
          const known = claude.get()
          const found = !known ? await check() : Date.now() - checked <= CHECK_STALE_MS ? known : await Promise.race([
            check().catch((error: unknown) => { console.error('Claude Agent: looking at Claude Code here failed:', error); return known }),
            new Promise<ClaudeCheck>((resolve) => setTimeout(() => resolve(known), FRESH_WAIT_MS).unref()),
          ])
          if (!found?.installed) return { unavailable: "Claude Code isn't installed here" }
          const unavailable = found.loggedIn ? undefined : found.error ? "Couldn't tell whether Claude Code is signed in here" : "Claude Code isn't signed in here: run claude, then /login"
          return { title: about.title, description: 'Runs your Claude Code', models: MODELS.map((m) => ({ ...m, thinking: [...m.thinking] })), ...(unavailable ? { unavailable } : {}) }
        },
        profile: { name: PROFILE_NAME, make: makeProfile },
        // Where its model shows: the model and effort it runs with, as picked, else its profile's, else Claude Code's own.
        describe(thread) {
          const own = thread.model?.startsWith(`${about.name}/`) ? thread.model.slice(about.name.length + 1) : undefined
          const profile = thread.profile?.[PROFILE_KEY] as ClaudeAgentOptions | undefined
          const state = thread.state as Kept | undefined
          const picked = own ?? profile?.model
          const effort = own ? thread.thinking : profile?.effort
          return {
            model: picked ? modelLabel(picked) : state?.model ?? "Claude Code's default",
            provider: 'anthropic',
            ...(effort ? { thinking: effort } : {}),
            about: 'runs your Claude Code',
            ...(state?.context ? { context: state.context } : {}),
          }
        },
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
          // The machine's permission mode, unless the profile picks one.
          options: (thread) => ({ permissionMode: superego.settings.get<PermissionMode>(SETTINGS.permissionMode), ...chosen.get(thread) }),
          place: (thread, signal) => parallel.take(thread, signal),
          rules: (cwd) => always.rules(cwd),
          remember: (cwd, rules) => always.remember(cwd, rules),
          ask,
          subagent,
          processes,
          idleMs,
          ran: (thread, { context, model }) => {
            void kept.update(thread, (current) => ({ ...current, context, model }))
              .then(() => superego.invalidate(), (error: unknown) => console.error(`Claude Agent: keeping thread ${thread}'s context usage failed:`, error))
          },
          limit: (info) => limit.set(limitOf(info) as Limit & Json),
          signedOut: waitForSignIn,
        }),
      })
      // What's still to be saved is, before the daemon goes.
      return async () => {
        if (timer) clearTimeout(timer)
        if (polling) clearInterval(polling)
        await Promise.all([save(), processes.closeAll()])
      }
    },
  })
}

export default claudeAgent()
