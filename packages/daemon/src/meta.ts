// The meta agent: a thread about Superego itself, for setting it up. It knows what Superego is (the prompt below) and works on this
// machine's Superego through tools: its settings, its actions (what the command line may run), and, where the app gives the
// daemon its machine list, the machines this computer reaches. Files (profiles, skills, AGENTS.md) it edits with the
// coding tools every thread has. One thread per machine, in Superego's data folder; the app opens it from its rail.
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { lit, obj, opt, str, union, type ActionInfo, type Json, type Router, type SettingsSnapshot } from '@superego/protocol'
import type { DaemonContext } from './daemon.ts'

/** The machines a computer reaches, as the app keeps them (`machines.json`); given to the daemon by the app. */
export type MachineDirectory = {
  list(): { id: string; label: string; target: string; command?: string; via?: string; enabled: boolean }[]
  add(input: { label?: string; target?: string; command?: string; via?: string }): Promise<{ id: string; label: string }>
  update(id: string, patch: { label?: string; enabled?: boolean }): Promise<unknown>
  remove(id: string): Promise<unknown>
}

/** What the meta agent is told, before the tools' own descriptions. */
export function metaPrompt({ name, agent, id, dataDir, agentsDir, hostname }: { name: string; agent?: string; id: string; dataDir: string; agentsDir: string; hostname: string }) {
  return `You are ${agent ? `${agent}, ` : ''}${name}'s own agent: you help the user set up and understand ${name}, the app they are talking to you in.
You run on ${hostname}, in ${dataDir}, ${name}'s data folder there. Be brief and practical. Before changing anything, say
what you'll change; ask before removing or overwriting what the user made. After a change, say where they'll see it.

What ${name} is:
- A machine runs a daemon that keeps agents going while the app is closed. "This computer" is always there; others are
  reached over ssh (or any command piping stdio), and need ${id} installed and on PATH there: the app runs
  \`ssh <target> ${id} connect --start\`. A machine is added by its ssh target (user@host, or a Host from ~/.ssh/config).
- A session is a project on a machine: a git repository (with its worktrees) or a folder. A thread is one conversation with
  an agent, in a folder, or in a git worktree of its own (${dataDir}/worktrees/<repo>/<slug>, branch ${id}/<slug>).
  Archived threads stay readable and take no messages until unarchived.
- Panes sit beside a thread: changes (git diff), the file editor, a web preview, an HTML artifact, another thread. You
  can open them with open_pane, say to show the user a file you made ({ kind: "editor", params: { path } }).
- Profiles are what an agent is, as files: a folder with a profile.ts, in ${dataDir}/profiles/<name> (the user's) or in a
  project's .${id}/profiles/<name>. The one called "default" is what new threads in that place start with.
    import { defineProfile } from '${id}'
    export default defineProfile({
      description: 'Answers customer mail',
      model: 'anthropic/claude-sonnet-4-5',         // provider/model; else the machine's default
      prompt: 'You answer customer email for Acme.', // instructions for its agent
      extensions: ['./tools.ts'],                    // agent tools, prompt sections, hooks (defineExtension from '${id}')
      ui: ['./ui/badge.tsx'],                        // window extensions (defineUiExtension from '${id}/ui')
      without: ['ask-user'],                         // built-ins it does without: coding-tools, ask-user, panes, skills, agents-md
      worktree: true,                                // its threads get worktrees
      extends: 'user:default',                       // a project's profile building on the user's
    })
  A project's profile is code from that repo: it runs only once allowed (the profile.allow action, or \`${id} profile
  allow\` there), and again after its files change. \`${id} profile new [name]\` scaffolds one. Before writing a
  profile's extensions (tools, actions, panes, UI), read \`${id} --skill\` and the topics it lists (\`${id} --skill ui\`, …).
- Skills live in ${agentsDir}/skills/<name>/SKILL.md: front matter with name and description (and
  disable-model-invocation: true to offer it only when named), then the instructions. Every agent is told about them; a
  message with $name or /skill:name sends one along. ${agentsDir}/AGENTS.md, and AGENTS.md files from / down to a
  thread's folder, are standing instructions for every agent.
- Settings: each machine has its own (models, providers and sign-in, web access, …): read them with superego_settings, change
  them with the settings.set action. Providers sign in from the app's Settings → Providers (OAuth needs the browser);
  an API key can be set with the auth.login action ({ provider, type: "api_key", key }). The app's own settings (fonts,
  accent colour, keyboard shortcuts, notifications, the menu bar) are in the app's Settings window, not here: point the
  user there.
- The command line: \`${id}\` starts a thread here and opens it; \`${id} threads\`, \`${id} machines\`, \`${id} settings\`,
  \`${id} actions\`, \`${id} do <action>\`, \`${id} help\` for the rest. Prefer your tools: the same actions, without a shell.

Data folder layout (${dataDir}): settings.json (this machine's settings), app-settings.json (the app's), machines.json
(the machines this computer reaches), profiles/, worktrees/, attachments/, trusted-profiles.json. Don't edit these by
hand when an action or tool does it.`
}

/** The meta agent's tools, on this machine's actions and settings, and on the machine list when there is one. */
export function metaExtension({ router, snapshot, machines }: {
  router: Router<DaemonContext>
  snapshot(): Promise<SettingsSnapshot>
  machines?: () => MachineDirectory
}) {
  const json = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
  const context: DaemonContext = { source: 'meta', notify: () => {} }
  /** Never from here: restarting the daemon would stop this very agent. */
  const refused = new Set(['daemon.restart'])
  const brief = (action: ActionInfo) => ({ id: action.id, title: action.title, params: action.params })
  const tools = [
    defineTool({
      name: 'superego_settings',
      description: "This machine's settings: each section with its settings (key, title, type, choices) and their values, and what sections report (providers and how they're signed in, web access).",
      parameters: obj({}),
      async execute() {
        const { sections, values } = await snapshot()
        return json(sections.map((section) => ({
          id: section.id, title: section.title, ...(section.data !== undefined ? { data: section.data } : {}),
          settings: section.settings.filter((s) => !s.hidden).map(({ key, title, description, default: initial, disabled, ...type }) => ({
            key, title, ...(description ? { description } : {}), type, default: initial, value: values[key] ?? initial, ...(disabled ? { disabled } : {}),
          })),
        })))
      },
    }),
    defineTool({
      name: 'superego_actions',
      description: 'The actions this machine runs (what the command line may run): id, title and params schema. Run one with superego_run.',
      parameters: obj({}),
      async execute() { return json(router.list('cli').filter((a) => !refused.has(a.id)).map(brief)) },
    }),
    defineTool({
      name: 'superego_run',
      description: 'Run one of this machine\'s actions by id, with its params: settings.set { key, value }, thread.create { cwd, title?, prompt?, profile?, worktree? }, profile.list { cwd }, profile.allow { cwd, name? }, auth.login { provider, type: "api_key", key }, … (superego_actions lists them all).',
      parameters: obj({ id: str({ minLength: 1 }), params: opt(obj({}, { open: true })) }),
      async execute({ id, params }) {
        if (refused.has(id)) throw new Error(`${id} isn't run from here: it would stop this agent. Ask the user to do it from Settings.`)
        const parsed = typeof params === 'string' ? JSON.parse(params) as Json : params ?? {}
        return json(await router.dispatch(id, parsed, context, { source: 'meta', exposure: 'cli' }) ?? null)
      },
    }),
  ]
  if (machines) tools.push(defineTool({
    name: 'superego_machines',
    description: 'The machines this computer reaches besides itself, as the app keeps them: list; add (by ssh target, or `via` any command piping stdio to the far side, with an optional name and the command to run there); rename; enable; disable; remove. The app connects to an added machine on its own; it needs superego installed there.',
    parameters: obj({
      op: union([lit('list'), lit('add'), lit('rename'), lit('enable'), lit('disable'), lit('remove')]),
      machine: opt(str({ description: 'Which one, by id or name (not for list or add)' })),
      target: opt(str({ description: 'add: an ssh target, user@host or a Host from ~/.ssh/config' })),
      via: opt(str({ description: 'add: instead of ssh, a command whose stdio reaches the far side' })),
      command: opt(str({ description: 'add: what to run there instead of `superego connect --start`' })),
      name: opt(str({ description: 'add, rename: what to call it' })),
    }),
    async execute({ op, machine, target, via, command, name }) {
      const directory = machines()
      if (op === 'list') return json(directory.list())
      if (op === 'add') return json(await directory.add({ ...(target ? { target } : {}), ...(via ? { via } : {}), ...(command ? { command } : {}), ...(name ? { label: name } : {}) }))
      const all = directory.list()
      const found = all.find((m) => m.id === machine) ?? all.filter((m) => m.label.toLowerCase() === machine?.toLowerCase()).at(0)
      if (!found) throw new Error(`No machine ${machine ?? '(none given)'}: ${all.map((m) => m.label).join(', ') || 'none added yet'}`)
      if (op === 'remove') await directory.remove(found.id)
      else if (op === 'rename') { if (!name?.trim()) throw new Error('rename needs a name'); await directory.update(found.id, { label: name.trim() }) }
      else await directory.update(found.id, { enabled: op === 'enable' })
      return json(directory.list())
    },
  }) as typeof tools[number])
  return defineExtension({ name: 'meta', tools })
}
