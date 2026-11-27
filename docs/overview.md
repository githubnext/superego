# Overview

Superego runs agents. A daemon on each machine runs them, so they keep working while the app is closed, and the same
window works in a browser and on a phone. A [profile](../packages/cli/skill/profiles.md) says what an agent is (model,
prompt, tools, extensions, panes): files in `~/.superego/profiles/` or a project's `.superego/profiles/`.

```text
machine    this computer, or one reached over ssh
└─ project  a git repository (with its worktrees) or a folder
   └─ thread  one conversation with an agent, in the folder or a worktree of its own
      └─ pane   a view beside the thread: changes, a file, a web page, a terminal, a profile's own
```

## Threads

- New thread (`⌘N`) starts like the thread shown: same machine, project, profile, model, thinking and worktree choice.
- **`/clear`** (or `/new`) in a thread's composer starts it over: a new thread like it, in the same folder, takes its
  place (and its pin), and it's archived. Words after it (`/clear fix the tests`) and attached files go to the new one.
- **`/compact`** summarizes the conversation so far to free its context; words after it say what the summary should
  keep (`/compact keep the API changes`). Both are in `⌘K` too, as Clear thread and Compact conversation.
- **Worktrees.** Tick the New thread checkbox (or `superego -w`) and the thread works in
  `~/.superego/worktrees/<repo>/<slug>` on branch `superego/<slug>`. Archiving removes a clean worktree and keeps its
  branch.
- **Archived** threads are in the sidebar's Archived list, readable, and take no messages until unarchived.
- **Threads start threads.** An agent can start, read, message and archive threads of its own
  ([thread tools](../packages/cli/skill/thread-tools.md)). A child is nested under its parent and reports back when it
  finishes, fails or waits on a question.
- **Thread links.** `[title](thread:<id>)` in a message links to a thread; `⌘`-click opens it beside.

## Messages

- Attach, drop or paste files. Images go to the model as images; every file is saved on the thread's machine and named
  to the agent by its path.
- `@` names a thread or a file. `$name` sends a [skill](#skills-and-agentsmd).
- Files named in a thread (`[[Note]]`, a relative link, `` `src/app.ts` ``) open beside it. `⌘P` opens any file in the
  thread's folder.
- An agent can ask you something (`ask_user`), show a form (`ask_ui`) or draw [blocks](blocks.md). A question waits
  above the message box, and the thread shows as blocked until you answer.
- Images an agent shows (`show_images`) appear in the thread; click to zoom. An image on the web loads only when you
  click it.

## Panes

Panes sit beside the thread, as columns or stacked as tabs (Settings → Appearance → Panes, or `⌘⇧\`). They're kept
with the thread, so every client shows the same ones; the agent opens them too (`pane_open`). Maximize one with its
tab's button, a double click on its title or `⌘⇧↩`; `Esc` restores it.

| Pane | From |
|---|---|
| File editor (Markdown in live preview, or source), another thread | built in |
| Changes (git's diff), Browser, Terminal, Processes, file tree | bundled extensions |

**Browser.** A web page or an HTML file the agent wrote. A `localhost` page on another machine is forwarded here
([Machines](machines.md#localhost-on-another-machine)). A page beyond this computer and its network that the agent
opened waits for you to press Open page. Pages ask for camera, microphone, notifications and local network as a browser
does; Settings → Site permissions forgets your answers.

**Processes.** What a thread runs that lasts longer than a command (a server, a watcher, a long build), started by its
agent (`process_start`), and its folder's dev command: each with its state, and the selected one's output, live. They
run on through Superego's updates and restarts; the thread is woken with the last lines when a build ends or a server
fails. The chip in the title bar says how they stand. Archiving a thread stops its own, and its folder's with the last
thread there.

**A folder's dev command** (Run) is `.superego/run.json`, in the folder or one above it up to the repository's root:
`{ "command": ["npm", "run", "dev"], "ready": "ready in", "grace": 5, "env": { "PORT": "3000" } }` (`command`, an argv
or a shell line, run in your login shell where the file is; `ready`, text in its output that says it's up; `grace`,
seconds between SIGTERM and SIGKILL). The setting `run.command` is the default where there's none. `⌃R` starts or
restarts it, and it starts again after the computer restarts if it was running.

**Layout.** Where views sit (the rail, beside the thread, the pane menu, the header) is
`~/.superego/layout.json`: Edit layout… in `⌘K` opens it, and it applies as you save. Or right-click a view to move it.
See [How the window is put together](interface.md).

## Focus mode

Focus a few threads, and the sidebar can show only those: Focus in a thread's right-click menu (on a phone, its menu),
or `⌘⌥F` for the one shown. Threads it starts join on their own. The ◎ in the sidebar's heading, or `⌘⇧F`, turns focus
mode on: the threads in focus under their projects, and every thread that needs you (a question, a permission, a
failure), which is never hidden. "Show N more" at the end, the ◎ or `⌘⇧F` again shows everything. The ◎'s menu has
Focus for 1 hour, which turns itself off. What's in focus is the same in every window; it's the `focus` extension, so
Settings → Extensions can turn it off.

## Ego

Ego is Superego's own agent: the circle at the top of the rail (`⌘1`), or Ask Ego in `⌘K`. It's an extension, so if you
turned it off (Settings → Extensions on a machine), it isn't there. It answers questions about Superego and how
this computer has it set up, changes settings and machines itself, and hands other work (a profile, a skill, code) to a
thread it starts in the right project. One Ego thread per machine; Clear in its title bar empties it. From a shell:
`superego do ego.ask --prompt "…"`.

## Skills and AGENTS.md

- **Skills** are the folders in `~/.agents/skills` on the thread's machine, each with a `SKILL.md`. The agent sees each
  one's name and description and reads it when it fits. `$name` in a message sends it along;
  `disable-model-invocation: true` in its front matter makes it `$name`-only.
- **AGENTS.md**: `~/.agents/AGENTS.md`, and every `AGENTS.md` from the project's top down to the thread's folder, are
  standing instructions. One another user on the machine could have written is skipped.

Turn either off for a profile (`without: ['skills', 'agents-md']`) or a machine (Settings → Extensions).

## Keys

| Keys | |
|---|---|
| `⌘L` | Go to a project, thread or pane (`⌃P`, `⌃T`, `⌃G`: one kind) |
| `⌘K` | Commands |
| `⌘N` | New thread: `⌃1`–`⌃7` go to its machine, folder, profile, model, thinking, prompt and name; `⌘⏎` starts it |
| `⌘⇧N` | New window |
| `⌘P` | Open a file in the thread's folder |
| `⌘⇧P` | Open a pane |
| `⌘⇧I` | Inspect views: outline every view, slot, pane and space; click one to paste its identifier into the message |
| `⌘U` | Unread threads: what needs you, then what failed, then what finished |
| `⌘.` | Next unread thread |
| `⌘⌥F` | Focus or unfocus the thread shown |
| `⌘⇧F` | Focus mode: the sidebar shows only the threads in focus, and what needs you |
| `⌘⇧[` `⌘⇧]` | Previous / next thread in the sidebar |
| `⌘[` `⌘]` | Back / forward through the threads this window has shown |
| `⌃Tab` `⌃⇧Tab` | The thread and its panes, in turn |
| `⌘⌥←` `⌘⌥→` | Focus the region beside: the sidebar, the thread, each pane |
| `⌘⌥⇧←` `⌘⌥⇧→` | Move the focused pane left / right |
| `⌘⇧\` | Panes side by side or stacked |
| `⌘⇧↩` | Maximize the focused column, or restore it |
| `⌃I` | Focus the message box (`Esc` leaves it, to read and scroll) |
| `⌃D` `⌃U` | Scroll half a page down / up |
| `⌃O` | The links in the thread |
| `⌘I` | Thread details |
| `⌘/` | Show or hide the sidebar |
| `⌘⇧E` | Archive the thread |
| `⌘⇧D` | Changes |
| `⌘⇧T` | The file tree |
| `⌘⌥N` | A new file, in the folder pane with the focus |
| `⌘T` | A new Browser pane |
| `` ⌃` `` | A terminal beside the thread |
| `⌃R` | Start or restart the folder's dev command |
| `⌘W` | Close the focused pane |
| `⌘⇧W` | Close the window (Superego keeps running) |
| `⌘,` | Settings |

Every key runs an action: change them in Settings → Hotkeys, find them in `⌘K`, run one from a shell with
`superego do <id>`.
