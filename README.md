# Superego

One app for running agents: a desktop app, a daemon per machine that keeps agents running when the app is closed, and
the same window in a browser or on a phone. What an agent is (its model, prompt, tools, extensions, panes) comes from
**profiles**: files in `~/.superego/profiles/` or inside a project's own `.superego/profiles/`, so a repo can carry the harness it
needs. See [PLAN.md](PLAN.md) and [docs/structure.html](docs/structure.html).

```sh
pnpm install
pnpm test               # unit + daemon/CLI e2e (scripted models)
pnpm typecheck          # tsc -b, incremental
pnpm dev                # the app; its daemon lives in ~/.superego
pnpm dev --fresh        # the app as it comes: a new, empty data dir (or --home <dir> for one of your own)
pnpm smoke              # e2e of the app, headless: nothing reaches the screen
pnpm --filter superego showcase /tmp/shots   # scripted threads, screenshotted
pnpm --filter superego package               # Superego.app in app/dist, signed ad hoc for this Mac
pnpm bundle             # …signed with your Developer ID and notarized, for any Mac (see .env.example)
pnpm release 0.1.0      # bundle, tag, push and publish it as a GitHub release
pnpm link:cli           # `superego` on your PATH (~/.local/bin/superego -> app/bin/superego.ts)
```

Releasing, and what a Mac needs to sign and notarize: [docs/releasing.md](docs/releasing.md).

Tests, typecheck, smoke and showcase take turns across the machine (two at a time; `SUPEREGO_CHECK_SLOTS`), and smoke
and showcase build the app only when its sources changed. See [AGENTS.md](AGENTS.md) for when to run which.

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
  it with `wait: true`), messages one (`thread_send`), lists those around (`thread_list`), and archives one
  (`thread_archive`): a finished child, or its own thread once its turn ends, but not a thread still working. A message
  names a thread as `[its title](thread:<id>)`, shown as that thread to open (⌘-click: beside). `thread.create` takes
  `parent` too. The same tools take `machine`, any machine its daemon reaches (`thread_machines` lists them): a thread
  started there is that machine's own, not nested under its parent, whose catalog is elsewhere.
- **Panes** sit beside the thread as a row of columns that scrolls sideways (Dinky's scrolling layout), or stacked in
  one column beside it, as tabs, so nothing passes the window's edge (Settings → Appearance → Panes, the strip's
  switch, `⌘⇧\`); the thread and its panes are kept with the thread, so every client sees the same. The agent opens
  them too (`open_pane`). One can be maximized for a while (its tab's button, a double click on its title, `⌘⇧↩`):
  over the thread and the rest, in this window only, until Esc, Restore, or another pane or thread.
  Built in: the file editor (Markdown rendered, in live preview as Obsidian shows it, or as source) and another thread.
  Bundled extensions add Changes (git's diff, `git`), Preview (a web page) and Artifact (an HTML file the agent wrote,
  sandboxed) (`web-panes`); a pane of an extension a thread goes without isn't shown.
- **Files** named in a thread (`[[Note]]`, a relative link, `` `src/app.ts` ``) open beside it; the `files` extension
  adds a tree beside the editor and quick open.
- **Messages** take files: attach, drop or paste them into the composer. Images go to the model as images; every file
  is saved on the thread's machine and named to the agent by its path.
- **The layout** is yours: what sits in the rail, beside the thread, in the pane menu and in the thread's header (and a
  phone's drawer) is text, `~/.superego/layout.json`: *Edit layout…* in ⌘K opens it, it applies as you save, and its
  head lists the views and the places each fits (`superego layout` prints it). A right-click on a view (the ··· beside
  the thread; an entry in the pane menu) moves it too, or takes it out; a pane's ··· moves its view. Thread details (⌘I) are a view beside the thread like any.
- **Images** an agent shows (`show_images`: a screenshot it took, a chart it drew) appear in the thread where it showed
  them: one fits the column, a few sit in a grid, more go one at a time in a carousel (‹ ›, ←/→, a swipe). Click one
  to look closely: zoom by clicking, scrolling or pinching, drag to pan, ←/→ through the set, Esc to close. Each is
  copied to the thread's files on its machine, so every client sees it, on the web too, as it was when shown.
- **Ego**, Superego's own agent (the lifebuoy in the rail, or in a phone's drawer, or *Ask Ego* in ⌘K; the `ego` extension), answers questions about Superego and
  how this computer has it set up: settings, profiles, skills, machines, projects and threads. It changes setup itself
  (this machine's settings, and the machines this computer reaches); any other work (a profile, a skill, code) it hands
  to an ordinary thread it starts in the right project, and links you to it. One thread per machine, in `~/.superego`, kept for good and in no list: it can't be archived, and *Clear* in its
  title bar (or `superego do ego.clear`) empties it. From a shell, `superego do ego.ask --prompt "…"`.
- **Skills** are the ones in `~/.agents/skills` on the thread's machine (a folder each, with a `SKILL.md`). The agent is
  told each one's name and description and reads one when it fits; `$name` or `/skill:name` in a message (completed
  as you type) sends that skill's instructions with it. `disable-model-invocation: true` keeps a skill to being named.
  `~/.agents/AGENTS.md`, and any `AGENTS.md` from the root down to the thread's folder, are standing instructions.
  A profile can do without either (`without: ['skills', 'agents-md']`), and a machine can turn either off. Skills are
  the `skills` extension; `AGENTS.md` is the core's. *Skills* lists every machine's to browse, once the layout places it
  (`skills.view`: a space, or beside the thread).

## Keys

| Keys | |
|---|---|
| `⌘L` | Go to a session, thread or pane (the navigator, after Fut's: ←→ parent and child, `⌃S` `⌃T` `⌃P` one kind) |
| `⌘K` | Commands |
| `⌘P` | Open a file in the thread's folder |
| `⌘N` | New thread |
| `⌘⇧N` | New window |
| `⌘.` | Next unread thread (everywhere, or in this session: Settings → Unread) |
| `⌘⇧[` `⌘⇧]` | Previous / next thread: up or down the sidebar's rows as shown (threads a thread started sit under it), across sessions and around |
| `⌘[` `⌘]` | Back / forward through the threads (and Settings) this window has shown, as a browser goes; the arrows in the title bar and the mouse's back and forward buttons too |
| `⌃Tab` `⌃⇧Tab` | The thread and its panes, in turn |
| `⌘⇧\` | Panes scrolled or stacked |
| `⌘⇧↩` | Maximize the pane with the focus, or restore it (`Esc` too) |
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
Focus is always visible: the region holding it (the sidebar, the thread, a pane) wears one solid ring, from a click or a key alike.

## Layout

| | |
|---|---|
| `app` | the Superego app: Electron main, window, daemon entry, the `superego` command, icons |
| `packages/protocol` | the contract: methods, JSON-RPC peer, actions, status |
| `packages/settings` | settings registry, used by daemons (per machine) and the app |
| `packages/daemon` | the daemon: pi-durable harness, threads, files, profiles, models and sign-in; the daemon half of the extension API |
| `packages/client` | reaching daemons: local socket, ssh, any stdio command; the machine list |
| `packages/cli` | the command line |
| `packages/ui` | component kit and design tokens |
| `packages/blocks` | UI an agent writes as JSON blocks: the strict schema (checked by the daemon half that takes them and again in the window that draws them), the words an answer sends, and the renderer (an `html` block runs in a sandboxed frame, replying only as the user acts) |
| `packages/app` | main process, window, preload, build and packaging; panes, the editor, the navigator; the UI half of the extension API |
| `packages/sdk` | what an extension's author imports: `superego`, `superego/ui`, `superego/testing` (a test daemon, a test window), `superego/unstable` |
| `extensions/threads` | the sidebar: sessions and their threads; the thread tools' rows and `thread:` links (UI; required). Its daemon half is `thread-tools`, the agent's `thread_*` tools (optional), and `thread-reports`: a thread started by another tells it when what it was asked finishes, fails or waits on a question, until the user takes it over by writing to it (optional) |
| `extensions/worktrees` | a git worktree of its own for a thread that asks (`-w`, the New thread checkbox, a profile's `worktree: true`): made on a branch, removed when archived clean (what still runs from it stopped first), put back when unarchived; the branch in the title bar (daemon + UI; required) |
| `extensions/ego` | Ego, Superego's own agent: one hidden thread per machine, its prompt and tools that read and set up; the rail's lifebuoy (a phone's drawer's too), *Ask Ego* in ⌘K, *Clear* (daemon + UI) |
| `extensions/ask-user` | an `ask_user` tool; the question card and blocked status (daemon + UI) |
| `extensions/reply-ui` | `show_ui` (blocks in the transcript, pressed later as a message) and `ask_ui` (blocks above the composer, waiting for an answer); both drawn out of the run's fold (daemon + UI) |
| `extensions/pane-ui` | `open_ui`/`update_ui`: the agent's blocks in a `ui` pane beside the thread, kept with the thread across restarts (daemon + UI) |
| `extensions/git` | Changes (`⌘⇧D`): the thread's folder's changes by git, file by file, +N −N on its tab; the agent opens it too (daemon + UI) |
| `extensions/web-panes` | Preview, a web page beside the thread (a link it names, opened beside), and Artifact, an HTML file the agent wrote, sandboxed (daemon + UI) |
| `extensions/files` | the file tree beside the editor and quick open (`⌘P`) (daemon + UI) |
| `extensions/images` | a `show_images` tool; the images in the thread, as one, a grid or a carousel, and a lightbox to zoom (daemon + UI) |
| `extensions/unread` | the bell with what agents have for you that you haven't seen (in the rail when the sidebar isn't there, beside Settings on a phone), most pressing first; `⌘.` to the next, everywhere or in this session (UI only) |
| `extensions/notifications` | a notification when a thread finishes, fails or needs you while the window is in the background, saying what it did, asks or failed on (a thread working for its parent says only when it needs you: its parent hears the rest); clicking it shows the thread. On the desktop, and in a browser once you allow it (offered over the composer while a thread works). With no window open, the desktop app notifies by itself; the menu bar keeps its count either way (UI only) |
| `extensions/links` | ⌃O: the links in the thread, newest first, fuzzy filtered; ⏎ follows one, ⌘⏎ opens it in a pane, ⌃1–9 / ⌃⌘1–9 the first nine (UI only) |
| `extensions/skills` | skills from `~/.agents/skills`: what each is for in the prompt, `$name` completed in the composer and sent with the message, a chip under it, and a data view listing them (daemon + UI) |
| `extensions/suggestions` | after each answer, a side call to the thread's model for what you might send next; offered over the composer, numbered; ←/→ pick, ⏎ sends, ⇥ takes it to change, ⌃1–9 send that one (daemon + UI) |
| `extensions/tasks` | `task_start`/`task_finish` tools and a prompt asking the agent to report its work as tasks; the transcript folds work under each task's title, status and outcome (daemon + UI) |
| `extensions/mcp-servers` | MCP servers for the agents in threads: other people's tools (Linear, GitHub, a browser) as `mcp__<server>__<tool>`, a command a machine runs or a URL it reaches, signed in to once per machine; Settings → MCP servers (Add server with a list of well-known ones, Sign in, Set key, Allow, Show log), the calls as rows, `3 MCP` in a thread's header and its servers in thread details, a notice when one needs signing in (daemon + UI) |

An extension has a daemon half (`defineDaemonExtension`: agent tools and hooks, settings, actions, read methods, live
values, pane kinds described to the agent, thread status) and a UI half (`defineUiExtension`: slots, pane kinds, tool
and entry renderers, work dividers, settings sections, window actions with `when`, window state). Everything a half
registers is its own and goes with it. Each extension declares once what it is, both halves alike: **required** (part
of what Superego is: the sidebar, worktrees) or **optional** (everything else, the thread tools `thread-tools` and Ego
included, and the core's own agent parts `coding-tools`, `panes`, `agents-md`): an optional one can be turned off per machine in Settings → Extensions
and left out by a profile (`without`), and its tools, pane kinds and UI are then absent from those threads.

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
them. Every command takes `-m <machine>` and `--json`; `superego help` lists them. Settings → Command line puts it in
`~/.local/bin`: the installed app writes a script that runs the CLI built into it, on its own Electron as Node; the dev
app links the checkout's `app/bin/superego.ts`, as `pnpm link:cli` does. `superego --skill` prints a skill for
agents on using and extending Superego (`superego --skill > ~/.agents/skills/superego/SKILL.md` installs it); it ends with
an index of topics, each printed by `superego --skill <topic>`: `cli`, `profiles`, `tools`, `daemon`, `ui`, `bundled`,
`debugging`. They live in `packages/cli/skill/`. A remote machine needs `superego` on its PATH for
`ssh <host> superego connect --start`:

```sh
gh repo clone mikker/superego ~/dev/superego && ~/dev/superego/scripts/install-machine.sh   # again to update
```

It installs `~/.local/bin/superego`, which a non-interactive ssh shell may not have on its PATH; then add the machine with
that command: `superego machines add <host> --command '~/.local/bin/superego connect --start'`. A machine whose Superego is
older (or newer) than this computer's gets a dot beside its name in the sidebar and in Settings → Machines; Update there
(⌘K *Update Superego on a machine*, or `superego machines update <host>`) runs its install-machine.sh over the same ssh
and reconnects, asking first if agents are working there, since the daemon restarts.

`superego mcp` is an MCP server on stdio, for agents outside Superego (Claude Code, Codex, an editor's): each action a
machine exposes to MCP is a tool (`thread.create` as `thread_create`), run as `superego do` runs it and in the same
action log, from `mcp`; `thread_list` and `thread_read` (a thread's state and last answer, waiting for it if asked) read.
Only actions that opt in are there: starting threads, sending them messages, stopping and renaming them, listing
profiles. One server serves one machine; `superego mcp -m <machine>` serves another. Add it as
`claude mcp add superego -- superego mcp`, or as `{"command": "superego", "args": ["mcp"]}` in a client's config.

That's Superego as an MCP server, for agents outside it ("outside agents"). The other way round, the agents in its
threads use **MCP servers**: Settings → MCP servers lists a machine's, each a command it runs (stdio) or a URL it
reaches (Streamable HTTP), with how it signs in: OAuth in the browser, an API key, or secret environment variables.
Secrets stay on that machine, in `mcp-auth.json` (mode 0600), never in `mcp-servers.json`. Add server offers well-known
ones to start from, and checks a server as it's saved ("Connected · 23 tools"). A thread uses the servers its profile
names (`mcp: ['linear']`, below), or, without a profile, those switched to *Use in threads without a profile*. Its
calls show as rows (*Called Linear · create_issue*), its header says how many servers it has (`3 MCP`, opening to each
with its state and why any were left out), and a server needing sign-in puts a notice over its composer. Ego sets
servers up too ("connect Linear"), but never takes a key in chat, and a command it adds waits for **Allow** in
Settings, which shows the whole command line. Outside agents can't set servers up, through Ego or otherwise; a thread
one starts (where *Can start threads* is on) uses its profile's servers like any other. From a shell:
`superego mcp-servers` (how each stands), `logs <name>`, `restart <name>`, `set-secret <name>` (from stdin). Design:
[docs/mcp.md](docs/mcp.md).

ssh runs without a terminal (`BatchMode`) and rides one shared ControlMaster connection per target under the data dir. A host
that wants a password, a code or a hardware key shows as "needs login": `superego machines login <machine>` (or Log in in
Settings → Machines, which opens Terminal) logs in once and leaves a master that links ride for four hours. A changed or
unknown host key is its own state, with ssh's message.

`superego daemon install` (on a machine) runs its daemon as a service, a systemd user unit (with lingering) or a launchd
agent, so it outlives logouts and reboots; `hello` reports `keepsRunning`, and `superego machines` and Settings warn when a
remote daemon will end at logout or reboot. Under a service, `superego daemon stop` stays stopped until the next connection
starts it; a crash or a restart brings it back. A daemon the service started has only the unit's environment (plus what a
restart brought): without an ssh agent there, its links to other machines may need `superego machines login <machine>`
on that computer.

Each computer's daemon links to the machines in its `machines.json` too (the list the app and `superego machines` keep),
with the same identity checks, so a browser or an agent there reaches them through it. It never links to itself. After
Log in or Trust this machine, the app tells its daemon to reconnect as well.

The daemon takes model keys from the providers' own variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) when none is
stored in Settings. A restart keeps the environment it was started with and adds that of the shell asking for it. Where
those keys are sealed, as on a [workbox](https://github.com/githubnext/workboxes), restart it from a terminal on the box,
once after each boot: `box run superego daemon restart`. (The app's ssh has no terminal for `box run` to ask for a password.)

## Profiles

Writing your first extension (a tool, a pane, where things show up): [docs/writing-extensions.md](docs/writing-extensions.md).

```sh
superego profile new            # .superego/profiles/default/profile.ts in this project (allowed, since you made it)
superego profile new support    # another, for `superego -P support`
superego profile new --user     # ~/.superego/profiles/default: yours, everywhere a project has none
superego profile allow support  # after pulling someone else's changes to it
superego profile types          # types for an editor, for profiles made before (or a fresh clone)
```

```ts
import { defineProfile } from 'superego'
export default defineProfile({
  description: 'Answers customer mail',
  prompt: 'You answer customer email for Acme. Be brief.',
  extensions: ['./orders.ts'],     // agent extensions, or daemon extensions (actions, live values), from 'superego'
  ui: ['./ui/order.tsx'],          // defineUiExtension({ name, setup(superego) { superego.pane('order', …) } }) from 'superego/ui'
  panes: { order: 'an order, with its lines and status. Params: { id }' },  // told to the agent, for open_pane
  mcp: ['linear', 'sentry'],       // the machine's MCP servers its threads use (Settings → MCP servers), by name
  mcpServers: {                    // servers of its own: a command (run in the project's root) or a URL
    docs: { command: 'node', args: ['./tools/docs-mcp.js'], auth: { type: 'env', names: ['DOCS_TOKEN'] } },
  },
  without: ['ask-user'],           // optional extensions its threads go without
  worktree: false,                 // its threads work in place (the default); true: each in a worktree of its own
  options: { worktrees: false },   // what its threads ask extensions for, by name (`worktree` is the shorthand for this one)
})
```

A profile's `mcpServers` take the shape of a Settings entry (`command`, `args`, `cwd`, `env`, or `url`, `headers`;
`auth`, `lifetime`, `tools`, `timeout`); their secrets are entered in Settings → MCP servers → From profiles, never in
the file. A project's run only once its profile is allowed, like the rest of it. With `extends`, `mcp` lists add up and
`mcpServers` merge by name, the project's winning; `without: ['mcp-servers']` drops them all.

A profile's UI is TSX or TS, compiled when the daemon serves it; it imports `react` and `superego/ui` (the window's own
hooks and components, the file editor among them). An example is the `obsidian` profile in `~/.superego/profiles`: a vault's
notes as a graph and as notes edited in place, with search and backlink tools for the agent.

Adding a machine gives it no say over this computer: a profile's UI from another machine runs in the window only once
allowed here, for the exact sources the window received (it hashes them itself; any change asks again). Until then its
threads work without it, and a notice over the composer offers Allow, with its files to read. Not now is remembered
for those sources, a quiet "UI not allowed" in the thread's header that asks again when clicked. Settings → Machines lists
what's allowed, with Revoke (which asks again too), and what's put off, with Allow; `superego profile allow-ui <name> -m <machine>` allows from a shell. Allowed, it runs
with the window's full authority, over every machine. Revoking takes out what it registered, but not what its code
already did or left going: the window offers a reload to clear that. A data-only view (a daemon extension's
`superego.view`) runs no code in the window, so it needs no allowing, and the window checks what it sends; its buttons
still run that machine's actions. This computer's own
profiles keep their daemon's rules. A browser or phone talks only to the daemon that served it (it is `local` there; other machines through it), and
runs no other machine's profile UI.

## In a browser or on a phone

Settings → a machine → Web access: serve the app to this computer, or over Tailscale (the daemon sets up
`tailscale serve`, so it's at `https://<machine>.<tailnet>.ts.net` to your tailnet). Then **Pair a device**: scan the QR
code or open its link on the device, once, within 5 minutes. A page added to a phone's home screen keeps cookies of its
own, so it asks for the code shown beside the link. Your own Tailscale login gets in without pairing (unless you
require it). Paired devices are listed there, to rename or revoke; one unused for 90 days is forgotten. From a
terminal: `superego web pair`, `superego web devices`.

On a phone, the bar at the top opens the drawer (☰: the threads, any other space to switch to at its foot, Ego,
Unread and Settings) and, from the thread's title, its sheet: what the title bar holds on the desktop (where it runs,
the model, archiving), the panes to open beside it, and what the layout puts beside the thread (thread details). Each
pane is a screen wide, and a swipe moves between the thread and its panes. A browser notifies like the
desktop app once allowed: the first time a thread works, a pill over the composer offers it. A phone's browser shows
them only from a service worker, which there isn't yet.

The page shows every machine the serving daemon reaches, through it (`machines.watch`, `relay.call`, `relay.event`);
Settings → Machines there lists them with Reconnect, while adding, removing, logging in and updating stay in the desktop
app. Settings → a machine → Connected lists who is using it right now: windows, browsers, command lines and other
machines' daemons.
