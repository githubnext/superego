// Ego's agent: what it's told (the prompt below) and its tools. It reads and explains: what Superego is (the prompt below), and this machine's
// setup through tools that read: its settings, its actions, its profiles, the machines this computer reaches, its
// threads, and files. What it changes itself is setup: this machine's settings (superego_set_setting) and the machines
// this computer reaches (superego_machines). Any other work it hands to a new, ordinary thread (thread_start), top-level
// in the project it belongs to, and names that thread.
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { createReadTool } from '@earendil-works/pi-durable/tools'
import { lineOf, linkTo, readTool } from '@superego/threads/tools'
import { bool, lit, obj, opt, str, union, unknown, type ActionInfo, type Exposure, type Json, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'

/** The machines a computer reaches, as the app keeps them (`machines.json`). */
export type MachineDirectory = {
  list(): { id: string; label: string; target: string; command?: string; via?: string; enabled: boolean }[]
  add(input: { label?: string; target?: string; command?: string; via?: string }): Promise<{ id: string; label: string }>
  update(id: string, patch: { label?: string; enabled?: boolean }): Promise<unknown>
  remove(id: string): Promise<unknown>
}

/** What Ego needs of the daemon's threads: the listed ones (never Ego itself), and starting a top-level one. */
export type EgoThreads = {
  info(id: string): Promise<ThreadInfo | undefined>
  list(): Promise<ThreadInfo[]>
  /** A new, ordinary thread: top-level in its project, never Ego's child. */
  start(params: { prompt: string; cwd: string; title?: string; profile?: string; worktree?: boolean }): Promise<ThreadInfo>
  answer(id: string): Promise<string | undefined>
}

/** What the meta agent is told, before the tools' own descriptions. */
export function metaPrompt({ name, agent, id, dataDir, agentsDir, hostname }: { name: string; agent?: string; id: string; dataDir: string; agentsDir: string; hostname: string }) {
  return `You are ${agent ? `${agent}, ` : ''}${name}'s own agent: you answer the user's questions about ${name}, the app they are
talking to you in, and about how it is set up on this machine (settings, profiles, skills, machines, projects, threads).
You run on ${hostname}, in ${dataDir}, ${name}'s data folder there. Be brief and practical.

You read and explain. Your tools look: read files, list folders, and read this machine's settings, actions, profiles,
machines and threads. What you change yourself is setup: this machine's settings (superego_set_setting) and the
machines this computer reaches (superego_machines: add, rename, enable, disable, remove). Say what you'll change first,
ask before removing a machine, and afterwards say where the user sees it. Any other work (editing a file, signing in,
writing a profile or a skill, writing code) is done by a separate, ordinary thread that you start with thread_start:
- Give it a clear, self-contained prompt: it sees nothing of this conversation. Say what to do, where, what you found
  that it needs, and how to check the result.
- Start it in the right folder: the project the work belongs to; ${dataDir} for ${name}'s own profiles;
  ${agentsDir} for skills and standing instructions. Ask the user when you can't tell.
- Then tell the user which thread you started, as a link: [its title](thread:<id>). It shows in the sidebar under its
  project, where they follow it; thread_read tells you how it went.
- Ask before starting work the user didn't ask for, and say what it will change.

What ${name} is:
- A machine runs a daemon that keeps agents going while the app is closed. "This computer" is always there; others are
  reached over ssh (or any command piping stdio), and need ${id} installed and on PATH there: the app runs
  \`ssh <target> ${id} connect --start\`. A machine is added by its ssh target (user@host, or a Host from ~/.ssh/config).
- A session is a project on a machine: a git repository (with its worktrees) or a folder. A thread is one conversation with
  an agent, in a folder, or in a git worktree of its own (${dataDir}/worktrees/<repo>/<slug>, branch ${id}/<slug>).
  Archived threads stay readable and take no messages until unarchived.
- Panes sit beside a thread: the file editor, another thread, and the kinds extensions add (changes, web pages…). You
  can open them with open_pane, say to show the user a file ({ kind: "editor", params: { path } }).
- Profiles are what an agent is, as files: a folder with a profile.ts, in ${dataDir}/profiles/<name> (the user's) or in a
  project's .${id}/profiles/<name>. The one called "default" is what new threads in that place start with.
    import { defineProfile } from '${id}'
    export default defineProfile({
      description: 'Answers customer mail',
      model: 'anthropic/claude-sonnet-4-5',         // provider/model; else the machine's default
      prompt: 'You answer customer email for Acme.', // instructions for its agent
      extensions: ['./tools.ts'],                    // agent tools, prompt sections, hooks (defineExtension from '${id}')
      ui: ['./ui/badge.tsx'],                        // window extensions (defineUiExtension from '${id}/ui')
      without: ['ask-user'],                         // optional extensions it does without: coding-tools, panes, skills, agents-md, thread-tools, thread-reports, ask-user, ego, files, git, images, links, suggestions, tasks, web-panes
      worktree: true,                                // its threads get worktrees
      extends: 'user:default',                       // a project's profile building on the user's
    })
  A project's profile is code from that repo: it runs only once allowed (the profile.allow action, or \`${id} profile
  allow\` there), and again after its files change. \`${id} profile new [name]\` scaffolds one. A thread writing a
  profile's extensions (tools, actions, panes, UI) should read \`${id} --skill\` and the topics it lists first.
- Skills live in ${agentsDir}/skills/<name>/SKILL.md: front matter with name and description (and
  disable-model-invocation: true to offer it only when named), then the instructions. Every agent is told about them; a
  message with $name or /skill:name sends one along. ${agentsDir}/AGENTS.md, and AGENTS.md files from / down to a
  thread's folder, are standing instructions for every agent.
- Settings: each machine has its own (models, providers and sign-in, web access, …): superego_settings reads them and
  superego_set_setting changes them (as \`${id} do settings.set --key … --value …\` does). Providers sign in from the app's
  Settings → Providers (OAuth needs the browser). The app's own settings (fonts, accent colour, keyboard shortcuts,
  notifications, the menu bar) are in the app's Settings window: point the user there.
- The command line: \`${id}\` starts a thread here and opens it; \`${id} threads\`, \`${id} machines\`, \`${id} settings\`,
  \`${id} actions\`, \`${id} do <action>\`, \`${id} help\` for the rest.
- You are one thread per machine, kept, and not listed with the others. The user clears you from your title bar.

Data folder layout (${dataDir}): settings.json (this machine's settings), app-settings.json (the app's), machines.json
(the machines this computer reaches), profiles/, worktrees/, attachments/, trusted-profiles.json. Settings and
machines change through your tools, the rest through actions (profile.allow, …) a thread runs, not by hand.`
}

/**
 * The meta agent's tools: they read, except those for setup, which is Ego's own to change (superego_set_setting,
 * superego_machines), and thread_start, which hands any other work to a thread.
 */
export function metaExtension({ dir, dispatch, actions, snapshot, machines, threads }: {
  /** Ego's own folder, the data folder: where relative paths start. */
  dir: string
  /** Run an action on this machine (`settings.set`, `profile.list`), and list them. */
  dispatch(id: string, params: Record<string, Json>): Promise<unknown>
  actions(exposure: Exposure): ActionInfo[]
  snapshot(): Promise<SettingsSnapshot>
  machines?: () => MachineDirectory
  threads: EgoThreads
}) {
  const json = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
  const text = (value: string) => ({ output: [{ type: 'text' as const, text: value }] })
  const brief = (action: ActionInfo) => ({ id: action.id, title: action.title, params: action.params })
  const folder = (path: string) => resolve(dir, path.replace(/^~(?=\/|$)/, homedir()))
  const tools = [
    createReadTool(),
    defineTool({
      name: 'ls',
      description: 'List a folder: its entries, folders with a trailing slash. Relative to your folder; ~ is home.',
      parameters: obj({ path: opt(str()) }),
      async execute({ path }) {
        const at = folder(path ?? '.')
        const entries = (await readdir(at, { withFileTypes: true })).map((e) => e.isDirectory() ? `${e.name}/` : e.name).sort()
        return text(entries.length ? `${at}:\n${entries.slice(0, 500).join('\n')}${entries.length > 500 ? `\n… (${entries.length - 500} more)` : ''}` : `${at} is empty.`)
      },
    }),
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
      name: 'superego_set_setting',
      description: "Change one of this machine's settings, by its key (superego_settings lists them, with their types and choices).",
      parameters: obj({ key: str({ minLength: 1 }), value: unknown() }),
      async execute({ key, value }) {
        await dispatch('settings.set', { key, value: (value ?? null) as Json })
        return text(`Set ${key} to ${JSON.stringify(value ?? null)}.`)
      },
    }),
    defineTool({
      name: 'superego_actions',
      description: 'The actions this machine runs (what the command line may run, `superego do <id>`): id, title and params schema. For explaining, and for the prompts of threads you start; you run none.',
      parameters: obj({}),
      async execute() { return json(actions('cli').map(brief)) },
    }),
    defineTool({
      name: 'superego_profiles',
      description: 'The profiles a thread in a folder can start with: the project\'s and the user\'s, each with its folder and whether it is allowed to run.',
      parameters: obj({ cwd: opt(str({ description: 'The project folder; else your own' })) }),
      async execute({ cwd }) { return json(await dispatch('profile.list', { cwd: folder(cwd ?? '.') })) },
    }),
    defineTool({
      name: 'thread_list',
      description: "This machine's threads, by project: each as a link, with where it stands and where it works.",
      parameters: obj({}),
      async execute() {
        const all = await threads.list()
        if (!all.length) return text('No threads yet.')
        const projects = new Map<string, ThreadInfo[]>()
        for (const thread of all) projects.set(thread.session.root, [...(projects.get(thread.session.root) ?? []), thread])
        return text([...projects].map(([root, list]) => `${list[0]!.session.name} (${root}):\n${list.map((t) => `- ${lineOf(t)}${t.parent ? `, started by thread ${t.parent}` : ''}`).join('\n')}`).join('\n\n'))
      },
    }),
    readTool(threads),
    defineTool({
      name: 'thread_start',
      description: 'Hand work to a new thread: an ordinary thread of its own, top-level in its project, with the prompt as its first message. ' +
        'Then tell the user which thread it is, as the link this returns.',
      parameters: obj({
        prompt: str({ minLength: 1, description: 'Its first message: everything it needs (it sees nothing of this conversation): what to do, where, and how to check it.' }),
        cwd: str({ minLength: 1, description: 'Where it works: the project the work belongs to (~ is home).' }),
        title: opt(str()), profile: opt(str()), worktree: opt(bool({ description: 'Work in a git worktree of its own.' })),
      }),
      async execute({ cwd, ...args }) {
        const thread = await threads.start({ ...args, cwd: folder(cwd) })
        return { ...text(`Started ${linkTo(thread)} (id ${thread.id}), in ${thread.cwd}.`), details: { id: thread.id, title: thread.title } }
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

