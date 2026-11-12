# Superego

One app for running agents: a desktop app, a daemon per machine that keeps agents running when the app is closed, and
the same window in a browser or on a phone. What an agent is (its model, prompt, tools, extensions, panes) comes from
**profiles**: files in `~/.superego/profiles/` or inside a project's own `.superego/profiles/`, so a repo can carry the harness it
needs. See [PLAN.md](PLAN.md) and [docs/structure.html](docs/structure.html).

```sh
pnpm install
pnpm test               # unit + daemon/CLI e2e (scripted models)
pnpm typecheck
pnpm dev                # the app; its daemon lives in ~/.superego
pnpm --filter superego smoke  # e2e of the app, headless: nothing reaches the screen
pnpm --filter superego showcase /tmp/shots   # scripted threads, screenshotted
pnpm --filter superego package               # superego.app in app/dist
pnpm link:cli           # `superego` on your PATH (~/.local/bin/superego -> app/bin/superego.ts)
```

## Sessions, threads, panes

```text
session    a project on a machine: a git repository (its worktrees too) or a folder
└─ thread  one conversation with an agent, by topic; in the folder, or a worktree of its own
   └─ pane a view beside the thread: changes, a file, a page, a profile's own
```

- **The machine** is a fact about a session, said where it isn't this computer. Machines are reached over ssh (or any
  command), and a session on one works like a local one.
- **A thread** starts in the folder you give it; New thread (⌘N) starts like the thread shown: its machine, project, profile, model, thinking and worktree choice. Ask for a worktree (the New thread checkbox, `superego -w`) and it works in
  `~/.superego/worktrees/<repo>/<slug>` on branch `superego/<slug>`; archiving removes a clean worktree and keeps its branch.
  Archived threads stay readable from the sidebar's Archived list, taking no messages until you unarchive them.
- **Threads start threads.** An agent starts one of its own for separate work (`thread_start`): a child, shown nested
  under its parent in the sidebar, with "from" its parent in the title bar. It reads another (`thread_read`, waiting for
  it with `wait: true`), messages one (`thread_send`), and lists those around (`thread_list`). A message names a thread
  as `[its title](thread:<id>)`, shown as that thread to open (⌘-click: beside). `thread.create` takes `parent` too.
- **Panes** sit beside the thread as a row of columns that scrolls sideways (Dinky's scrolling layout); the thread
  and its panes are kept with the thread, so every client sees the same. The agent opens them too (`open_pane`).
  Built in: Changes (git diff), the file editor (Markdown in live preview, as Obsidian shows it), Preview (a web page),
  Artifact (an HTML file the agent wrote, sandboxed) and another thread.
- **Files** named in a thread (`[[Note]]`, a relative link, `` `src/app.ts` ``) open beside it; the `files` extension
  adds a tree beside the editor and quick open.
- **Messages** take files: attach, drop or paste them into the composer. Images go to the model as images; every file
  is saved on the thread's machine and named to the agent by its path.
- **Ego**, Superego's own agent (the lifebuoy in the rail, or *Ask Ego* in ⌘K), helps set Superego up: it knows what Superego is, and works on
  this computer's settings, actions and machine list, and on profiles, skills and `AGENTS.md`. One thread, kept, in
  `~/.superego`; from a shell, `superego do thread.meta --prompt "…"`.
- **Skills** are the ones in `~/.agents/skills` on the thread's machine (a folder each, with a `SKILL.md`). The agent is
  told each one's name and description and reads one when it fits; `$name` or `/skill:name` in a message (completed
  as you type) sends that skill's instructions with it. `disable-model-invocation: true` keeps a skill to being named.
  `~/.agents/AGENTS.md`, and any `AGENTS.md` from the root down to the thread's folder, are standing instructions.
  A profile can do without either (`without: ['skills', 'agents-md']`).

## Keys

| Keys | |
|---|---|
| `⌘L` | Go to a session, thread or pane (the navigator, after Fut's: ←→ parent and child, `⌃S` `⌃T` `⌃P` one kind) |
| `⌘K` | Commands |
| `⌘P` | Open a file in the thread's folder |
| `⌘N` | New thread |
| `⌘⇧N` | New window |
| `⌘.` | Next unread thread (everywhere, or in this session: Settings → Navigation) |
| `⌘⇧[` `⌘⇧]` | Previous / next thread, through every session in the sidebar's order |
| `⌃Tab` `⌃⇧Tab` | The thread and its panes, in turn |
| `⌘⌥←` `⌘⌥→` | Focus the region beside: the sidebar, the thread, each pane (every one can hold the focus) |
| `⌃I` | Focus the prompt (`Esc` there leaves it for the thread, to read and scroll; typing goes back to the prompt) |
| `⌃D` `⌃U` | Scroll what has the focus (the thread, from its prompt) half a page down / up |
| `⌃O` | The links in the thread, to follow from the keyboard |
| `⌘/` | Hide or show the sidebar |
| `⌘⇧E` | Archive the thread shown |
| `⌘⇧T` | The file tree beside the editor |
| `⌘⇧D` | Show changes |
| `⌘W` | Close the pane with the focus (the focus moves left) |
| `⌘⇧W` | Close the window (Superego keeps running) |
| `⌘,` | Settings |

Every one is an action: Settings → Keyboard changes them, `⌘K` lists them, `superego do <id>` runs a machine's from a shell.
Focus is always visible: whatever has it wears one solid ring, and the region holding it is marked.

## Layout

| | |
|---|---|
| `app` | the Superego app: Electron main, window, daemon entry, the `superego` command, icons |
| `packages/protocol` | the contract: methods, JSON-RPC peer, actions, status |
| `packages/settings` | settings registry, used by daemons (per machine) and the app |
| `packages/daemon` | the daemon: pi-durable harness, threads, worktrees, files, profiles, models and sign-in; the daemon half of the extension API |
| `packages/client` | reaching daemons: local socket, ssh, any stdio command; the machine list |
| `packages/cli` | the command line |
| `packages/ui` | component kit and design tokens |
| `packages/app` | main process, window, preload, build and packaging; panes, the editor, the navigator; the UI half of the extension API |
| `extensions/threads` | the sidebar: sessions and their threads (UI) |
| `extensions/ask-user` | an `ask_user` tool; the question card and blocked status (daemon + UI) |
| `extensions/files` | the file tree beside the editor and quick open (`⌘P`) (daemon + UI) |
| `extensions/links` | ⌃O: the links in the thread, newest first, fuzzy filtered; ⏎ follows one, ⌘⏎ opens it in a pane, ⌃1–9 / ⌃⌘1–9 the first nine (UI) |
| `extensions/suggestions` | after each answer, a side call to the thread's model for what you might send next; offered over the composer, ⇥ takes the first (daemon + UI) |
| `extensions/tasks` | `task_start`/`task_finish` tools and a prompt asking the agent to report its work as tasks; the transcript folds work under each task's title, status and outcome (daemon + UI) |

An extension has a daemon half (`defineDaemonExtension`: agent tools and hooks, settings, actions, live values, thread
status) and a UI half (`defineUiExtension`: slots, pane kinds, tool and entry renderers, work dividers, settings sections, actions).

## Environment

| Variable | Meaning |
|---|---|
| `SUPEREGO_HOME` | Data dir (default `~/.superego`) |
| `SUPEREGO_MODEL` | Default model when none is chosen in Settings, `faux` for the echo model, or `replay:<file>` |
| `SUPEREGO_REPLAY` | Offer a recording as the model `replay/replay` beside the default |
| `SUPEREGO_RECORD` | Append every real model answer to this JSONL file, for replaying later |
| `SUPEREGO_REPLAY_SPEED` | Replay pace in tokens per second (default 120; 0 is instant) |
| `SUPEREGO_CWD` | Default working directory for new threads |
| `SUPEREGO_AGENTS` | The folder agents share, for skills and `AGENTS.md` (default `~/.agents`) |
| `SUPEREGO_HEADLESS` | The app shows nothing: no window, Dock icon, notification or focus (tests) |

## The command

`superego` starts a thread in the current directory and opens it in the app. `superego <dir> -p "fix the tests"` starts one
elsewhere with a first message; `-P <profile>` picks a profile; `-w` gives it a worktree of its own. `superego threads` lists
them. Every command takes `-m <machine>` and `--json`; `superego help` lists them. `superego --skill` prints a skill for
agents on using and extending Superego (`superego --skill > ~/.agents/skills/superego/SKILL.md` installs it); it ends with
an index of topics, each printed by `superego --skill <topic>`: `cli`, `profiles`, `tools`, `daemon`, `ui`, `bundled`,
`debugging`. They live in `packages/cli/skill/`. A remote machine needs `superego` on its PATH for
`ssh <host> superego connect --start`:

```sh
gh repo clone mikker/superego ~/dev/superego && ~/dev/superego/scripts/install-machine.sh   # again to update
```

It installs `~/.local/bin/superego`, which a non-interactive ssh shell may not have on its PATH; then add the machine with
that command: `superego machines add <host> --command '~/.local/bin/superego connect --start'`.

The daemon takes model keys from the providers' own variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) when none is
stored in Settings. A restart keeps the environment it was started with and adds that of the shell asking for it. Where
those keys are sealed, as on a [workbox](https://github.com/githubnext/workboxes), restart it from a terminal on the box,
once after each boot: `box run superego daemon restart`. (The app's ssh has no terminal for `box run` to ask for a password.)

## Profiles

```sh
superego profile new            # .superego/profiles/default/profile.ts in this project (allowed, since you made it)
superego profile new support    # another, for `superego -P support`
superego profile new --user     # ~/.superego/profiles/default: yours, everywhere a project has none
superego profile allow support  # after pulling someone else's changes to it
```

```ts
import { defineProfile } from 'superego'
export default defineProfile({
  description: 'Answers customer mail',
  prompt: 'You answer customer email for Acme. Be brief.',
  extensions: ['./orders.ts'],     // agent extensions, or daemon extensions (actions, live values), from 'superego'
  ui: ['./ui/order.tsx'],          // defineUiExtension({ name, setup(superego) { superego.pane('order', …) } }) from 'superego/ui'
  panes: { order: 'an order, with its lines and status. Params: { id }' },  // told to the agent, for open_pane
  without: ['ask-user'],
  worktree: false,                 // its threads work in place (the default); true: each in a worktree of its own
})
```

A profile's UI is TSX or TS, compiled when the daemon serves it; it imports `react` and `superego/ui` (the window's own
hooks and components, the file editor among them). An example is the `obsidian` profile in `~/.superego/profiles`: a vault's
notes as a graph and as notes edited in place, with search and backlink tools for the agent.

## In a browser or on a phone

Settings → a machine → Web access: serve the app to this computer or the local network. Open the address it shows (it
carries a token); on a phone, add it to the home screen. Each pane is a screen wide there, and a swipe moves between
the thread and its panes.
