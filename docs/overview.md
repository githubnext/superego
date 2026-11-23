# Overview

Superego is a desktop app for running agents. A daemon on each machine runs them, so they keep working when the app
is closed, and the same window works in a browser and on a phone. What an agent is (its model, prompt, tools,
extensions and panes) comes from a [profile](../packages/cli/skill/profiles.md): files in `~/.superego/profiles/` or in
a project's own `.superego/profiles/`, so a repository can carry the agent it needs.

## Projects, threads and panes

```text
machine    this computer, or one reached over ssh
└─ project  a git repository (with its worktrees) or a folder
   └─ thread  one conversation with an agent, in the folder or a worktree of its own
      └─ pane   a view beside the thread: changes, a file, a web page, a terminal, a profile's own
```

- **A thread** starts in the folder you give it. New thread (`⌘N`) starts like the thread shown: its machine, project,
  profile, model, thinking and worktree choice. Ask for a worktree (the New thread checkbox, `superego -w`) and the
  thread works in `~/.superego/worktrees/<repo>/<slug>` on branch `superego/<slug>`; archiving removes a clean worktree
  and keeps its branch. Archived threads stay readable from the sidebar's Archived list and take no messages until you
  unarchive them.
- **Threads start threads.** An agent can start a thread of its own for separate work, read it, message it and archive
  it ([thread tools](../packages/cli/skill/thread-tools.md)). A child is nested under its parent in the sidebar, and
  tells its parent when it finishes, fails or waits on a question. A message names a thread as
  `[its title](thread:<id>)`, shown as a link to it (`⌘`-click opens it beside).
- **Panes** sit beside the thread as a row of columns that scrolls sideways, or stacked in one column as tabs
  (Settings → Appearance → Panes, or `⌘⇧\`). Panes are kept with the thread, so every client shows the same ones. The
  agent opens them too (`pane_open`). Maximize one with its tab's button, a double click on its title or `⌘⇧↩`; `Esc`
  restores it. Built in: the file editor (Markdown in live preview, or as source) and another thread. Bundled
  extensions add Changes (git's diff), Browser, Terminal and the file tree.
- **The Browser pane** shows a web page or an HTML file the agent wrote. A page on another machine's `localhost` is
  forwarded to this computer, so a dev server there opens here (see [Machines](machines.md#localhost-on-another-machine)).
  A page the agent opens beyond this computer and its network waits for you to press Open page, since its address
  could carry what the agent read. Pages ask for the camera, microphone, notifications and the local network as a
  browser does; Settings → Site permissions forgets your answers.
- **Files** named in a thread (`[[Note]]`, a relative link, `` `src/app.ts` ``) open beside it. `⌘P` opens any file in
  the thread's folder.
- **Messages** take files: attach, drop or paste them. Images go to the model as images; every file is saved on the
  thread's machine and named to the agent by its path. `@` names another thread or a file, and the agent is told what
  it is.
- **Images** an agent shows (`show_images`) appear in the thread: one alone, a few in a grid, more in a carousel. Click
  one to zoom. An image on the web isn't fetched until you click it, since its address could carry what the agent read.
- **Questions and UI.** An agent can ask you something with options (`ask_user`), show a form (`ask_ui`), or draw
  [blocks](blocks.md) in the transcript or a pane. A question waits above the message box, and the thread shows as
  blocked until you answer.
- **The layout** of the window (what sits in the rail, beside the thread, in the pane menu and the thread's header) is
  text: Edit layout… in `⌘K` opens `~/.superego/layout.json`, which applies as you save. Right-click a view to move it.
  Thread details (`⌘I`) is one such view.

## Ego

Ego is Superego's own agent: the lifebuoy in the rail, or Ask Ego in `⌘K`. It answers questions about Superego and
how this computer has it set up: settings, profiles, skills, machines, MCP servers, projects and threads. It changes
settings and machines itself; other work (a profile, a skill, code) it hands to a thread it starts in the right
project, and links you to it. There's one Ego thread per machine, kept for good; Clear in its title bar empties it.
From a shell: `superego do ego.ask --prompt "…"`.

## Skills and AGENTS.md

Skills are the folders in `~/.agents/skills` on the thread's machine, each with a `SKILL.md`. The agent is told each
one's name and description and reads one when it fits. `$name` in a message (completed as you type) sends that skill
with it; `disable-model-invocation: true` in a skill's front matter keeps it to being named.

`~/.agents/AGENTS.md`, and any `AGENTS.md` from the project's top down to the thread's folder, are standing
instructions. One that another user on the machine could have written is skipped. A profile can go without either
(`without: ['skills', 'agents-md']`), and a machine can turn either off in Settings → Extensions.

## Keys

| Keys | |
|---|---|
| `⌘L` | Go to a project, thread or pane (`⌃P`, `⌃T`, `⌃G`: one kind) |
| `⌘K` | Commands |
| `⌘N` | New thread: `⌃1`–`⌃7` go to its machine, folder, profile, model, thinking, prompt and name; `⌘⏎` starts it |
| `⌘⇧N` | New window |
| `⌘P` | Open a file in the thread's folder |
| `⌘⇧P` | Open a pane |
| `⌘U` | Unread threads: what needs you, then what failed, then what finished |
| `⌘.` | Next unread thread |
| `⌘⇧[` `⌘⇧]` | Previous / next thread in the sidebar |
| `⌘[` `⌘]` | Back / forward through the threads this window has shown |
| `⌃Tab` `⌃⇧Tab` | The thread and its panes, in turn |
| `⌘⌥←` `⌘⌥→` | Focus the region beside: the sidebar, the thread, each pane |
| `⌘⌥⇧←` `⌘⌥⇧→` | Move the focused pane left / right |
| `⌘⇧\` | Panes side by side or stacked |
| `⌘⇧↩` | Maximize the focused column, or restore it |
| `⌃I` | Focus the message box (`Esc` there leaves it, to read and scroll) |
| `⌃D` `⌃U` | Scroll half a page down / up |
| `⌃O` | The links in the thread |
| `⌘I` | Thread details |
| `⌘/` | Show or hide the sidebar |
| `⌘⇧E` | Archive the thread |
| `⌘⇧D` | Changes |
| `⌘⇧T` | The file tree |
| `⌘T` | A new Browser pane |
| `` ⌃` `` | A terminal beside the thread |
| `⌘W` | Close the focused pane |
| `⌘⇧W` | Close the window (Superego keeps running) |
| `⌘,` | Settings |

Every key runs an action: Settings → Hotkeys changes them, `⌘K` lists them, and `superego do <id>` runs one from a
shell.

## More

- [Machines](machines.md): agents on other computers, and the app in a browser or on a phone.
- [The command](../packages/cli/skill/cli.md): `superego` in a terminal, and Superego as an MCP server for other agents.
- [Profiles](../packages/cli/skill/profiles.md) and [extensions](../packages/cli/skill/SKILL.md): changing what an agent
  is and what the window shows.
- [MCP servers](mcp.md): other people's tools for the agents in threads.
