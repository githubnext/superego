# The superego command

Every command talks to a machine's daemon, starting this computer's if it isn't running.

| Option | |
|---|---|
| `-m <machine>` | work on another machine (name or id from `superego machines`); default: this computer |
| `--json` | JSON instead of a table: use it whenever a program (or you) reads the output |
| `--help` | one command's usage, options and examples (`superego extension test --help`); `superego help` lists every command |

Settings → Command line installs `superego` in `~/.local/bin`. `superego --skill` prints this skill
(`superego --skill > ~/.agents/skills/superego/SKILL.md` installs it); `superego --skill <topic>` prints one topic.

## Threads

```sh
superego [dir] [-p prompt] [-P profile] [-w]         # start a thread in dir (default: here) and open it in the app
superego start [dir] [-p prompt] [-P profile] [-w]   # the same without the app; prints the id (also: new)
superego open <thread>                               # show a thread in the app
superego send <thread> <text...>                     # send a message
superego threads [--archived]                        # list them (also: ls)
superego read <thread> [--wait]                      # its state and last answer; --wait: once it stops working
superego unread [--count]                            # what's done, failed or needs you, unseen: the app icon's count
```

- `-P <profile>`: without it, the folder's `default` profile, the project's before yours, or none.
- `-w`: a git worktree of its own, `~/.superego/worktrees/<repo>/<slug>` on branch `superego/<slug>`.
- With `-m`, `dir` is a path on that machine.
- `superego do thread.start --parent <thread> …` starts a child, nested under that thread. Inside a thread, agents
  have the [thread tools](thread-tools.md).

A thread's status is `idle`, `working`, `done`, `blocked` (waiting on the user) or `error`. Blocked with kind `auth`
waits for sign-in: its provider rejected the machine's credentials, and it goes on once they change (`superego threads`
says which provider).

```sh
id=$(superego start . -p "Summarise the open TODOs")
superego read "$id" --wait                          # also waits for the answer to a message just sent
superego send "$id" "Now the tests" && superego read "$id" --wait   # --json: { thread, answer }
```

`read` prints the last answer, not the transcript; `superego open <id>` shows that.

`superego unread` counts as the app icon does, across every connected machine. It never starts the daemon (none
running: 0), so a status bar can poll `superego unread --count`, or `--json` for
`{ count, threads: [{ machine, id, title, state }] }`.

## Actions

`superego actions` lists the actions a machine takes from the command line, with parameters (`?` optional, `a|b`
choices); `--all` adds the window's.

```sh
superego do <action> --<param> <value> ...      # values coerced to the action's schema
superego do <action> --params '<json object>'   # all at once, for nested values
superego actions log                            # the latest runs, from anywhere, with errors
```

| Action | Does |
|---|---|
| `thread.start` `cwd? title? prompt? profile? model? parent? options?` | start a thread; `options: { worktrees: true }` gives it a worktree |
| `thread.send` `thread text whenBusy?=steer\|followUp` | send a message |
| `thread.stop` `thread` | stop the agent and its queued messages. Answers `{ returned }`: the user's own (each its `content` and `attachments`), to write again; others' are withdrawn, and the transcript says so |
| `thread.rename` `thread title`, `thread.archive` `thread`, `thread.unarchive` `thread` | `thread.archive` answers `{ notes }`, what extensions did (removed its worktree, say). Ego is never archived |
| `pane.open` `thread kind title? params?` | open a pane: `editor`, `thread`; `diff` (git); `browser` (`{ url }` or `{ path }`); a profile's own |
| `pane.close` `thread pane`, `pane.focus` `thread pane?` | |
| `pane.move` `thread pane to` | move a pane (`to`: 0 is first) |
| `pane.resize` `thread pane? width? last?` | the thread's column (no `pane`) or a pane's width, a share of the window (no `width`: the default) |
| `profile.list` `cwd? user?`, `profile.allow` `cwd? name?` | `user`: yours only |
| `profile.sources`, `profile.install` `source`, `profile.remove` `source`, `profile.update` `source?` | profile sources (`install` is the user's consent) |
| `ego.ask` `prompt?` | ask Ego, Superego's own agent (one hidden thread per machine) |
| `ego.clear` | empty Ego's thread |

```sh
superego do pane.open --params '{"thread":"<thread>","kind":"editor","params":{"path":"README.md"}}'
```

Extensions' actions (`agent-ui.answer`, `vault.graph`) are listed too.

## Outside agents

`superego mcp` serves a machine's actions to agents outside Superego, as an MCP server on stdio:

```sh
claude mcp add superego -- superego mcp         # or {"command": "superego", "args": ["mcp"]} in a client's config
superego mcp -m <machine>                       # one server per machine
```

- Each action exposed to `outside` is a tool named for its id with `_` for `.` (`thread_start`), its schema the
  action's. It runs with `exposure: 'outside'` (`superego actions log` shows it so).
- Exposed: `thread.send`, `thread.stop`, `thread.rename`, `thread.archive`, `thread.unarchive`, `pane.open`,
  `profile.list`, `ego.ask`, and `thread.start` once the machine allows it:
  `superego settings set outside.startThreads true` (Settings → Outside agents → Can start threads; off by default).
- Its own tools: `thread_list` (`archived?`) and `thread_read` (`thread wait?`; Ego's thread too).
- Nothing that changes settings, signs in, allows a profile, writes files or restarts the daemon. An extension's action
  becomes a tool by adding `'outside'` to its `expose`.
- The tool list follows the machine's extensions and settings (`tools/list_changed`).

## Profiles

```sh
superego profile                    # the profiles a thread here could start with
superego profile new [name]         # .superego/profiles/<name>/profile.ts here, allowed (an agent's waits for the user)
superego profile new [name] --user  # ~/.superego/profiles/<name>: yours, everywhere
superego profile types [name]       # types for an editor: tsconfig.json, node_modules → ~/.superego/types (--user: yours)
superego profile allow [name]       # let this project's profile run (again, after it changed)
superego profile allow-ui <name> -m <machine>   # let that machine's profile UI run in this window, as it is now
superego profile revoke-ui <name> -m <machine>
superego profile install <source>   # yours from git (git:<host>/<owner>/<repo>[@ref]) or a folder: trusted code
superego profile remove <source>    # drop it (a git one's clone too)
superego profile update [source]    # git pull --ff-only the git sources
superego profile sources            # each source, its state and profiles
```

`name` defaults to `default`. See [profiles](profiles.md).

Allowing is the user's consent. From an agent's shell (marked by `SUPEREGO_THREAD`), `profile allow`,
`profile allow-ui`, `machines trust`, `web pair` and every `consent` action are refused: tell the user what to allow
and where.

## Extensions

```sh
superego extension new <name>              # an agent tool, in a daemon half, in this project's default profile
superego extension new <name> --ui         # a pane, UI half only
superego extension new <name> --badge      # a sidebar mark: a daemon half sets a thread's fact, a UI half draws it
superego extension new <name> --tool --ui  # an agent tool, and a pane of what it did
superego extension test [name]             # check the profile's types and run its tests (or one extension's)
superego extension reload                  # load the profile's changes now
superego extensions [--thread <thread>]    # every extension here, and what it registered
```

Each takes `-P <profile>` (default: `default`) and `--user`. What `new` makes passes `extension test`. See
[the guide](guide.md).

## Machines

```sh
superego machines                              # each, whether it answers, and whether it runs another version
superego machines add <ssh-target> [--name N] [--command C]
superego machines add --via '<command>' [--name N]   # any command piping stdio to the far side
superego machines login <machine>              # ssh in this terminal (password, code); links then use that connection
superego machines rm|enable|disable|trust <machine>
superego machines update <machine> [--now]     # run install-machine.sh there; --now even while agents work
```

A remote machine needs `superego` installed (`scripts/install-machine.sh` in the Superego repo); the app runs
`ssh <target> superego connect --start`. `superego daemon install` there runs its daemon as a service (systemd user
unit, launchd agent) that outlives logouts and reboots.

## Settings and sign-in

```sh
superego settings                     # every setting and its value
superego settings set <key> <value>   # JSON or plain text; --all: every enabled machine
superego settings reset <key>
superego secrets                      # extensions' secrets: set or not (never values); and unclaimed ones still set
superego secrets set <key>            # prompted without echo, or from stdin; refused from a thread's shell
superego secrets clear <key>
superego layout                       # the window's layout.json: the views, the places each fits, where they are
superego providers                    # every provider and how it's signed in, signed-in first
superego providers key <provider>     # sign in with an API key (prompted, or from stdin)
superego providers sign-out <provider>
superego providers retry [provider]   # retry the threads waiting for sign-in now
superego providers add --name Ollama --base-url http://localhost:11434/v1 [--key -] [--model <id>...]
superego providers remove <provider>  # one you added
superego models                       # the signed-in providers' models, favourites (★) first
superego models favourite <provider/model>   # or unfavourite
```

- Each machine has its own settings: models, providers, favourites, which extensions are on.
- OAuth sign-in (ChatGPT, GitHub Copilot, OpenRouter) is in the app's Settings.
- Added providers are OpenAI-compatible endpoints, in `~/.superego/models.json` in pi's format
  (`providers.<id>.{ name, baseUrl, api, models: [{ id }] }`); keys in `auth.json`.
- Credentials in the environment count too (`GROQ_API_KEY`, `AWS_PROFILE`, …).

## MCP servers

The servers a machine's agents use (Settings → MCP servers; the bundled `mcp-servers` extension):

```sh
superego mcp-servers                         # each, and how it stands
superego mcp-servers --thread <thread>       # the servers its last turn had, those left out, and why
superego mcp-servers logs <name> [--lines N] # its log (secrets hidden)
superego mcp-servers restart <name>
superego mcp-servers set-secret <name> [VAR] # its API key or a secret env var (prompted, or from stdin)
superego mcp-servers sign-in <name>          # OAuth: open the page it prints, or paste where the browser ends up
superego mcp-servers sign-out <name>
```

## Web access

```sh
superego settings set web.access local       # off | local (this computer) | tailscale (https://<machine>.<tailnet>.ts.net)
superego web pair                            # a link, its QR code, and a code: one device, once, within 5 minutes
superego web devices                         # paired devices, and yours on the tailnet (approved or waiting)
superego web approve <device>                # let in a waiting device of yours on the tailnet
superego web revoke <device>                 # its connections close at once
superego web rename <device> <name>
```

A paired browser holds an HttpOnly cookie; addresses carry no secret. With `tailscale`, the daemon runs
`tailscale serve` (Tailscale 1.94 or later) to a socket only you and tailscaled can open. A device logged in to
Tailscale as you may skip pairing, once approved. Devices unused for 90 days are forgotten.

## The daemon

```sh
superego daemon status            # running? on the installed build?
superego daemon restart [--now]   # onto the installed code; --now interrupts working agents (they resume)
superego daemon stop
superego daemon                   # run it in the foreground
```

Data in `~/.superego` (`SUPEREGO_HOME`), log in `~/.superego/daemon.log`.

## Environment

| Variable | |
|---|---|
| `SUPEREGO_HOME` | data folder (default `~/.superego`) |
| `SUPEREGO_MODEL` | default model; `faux` echoes, for trying things without a provider |
| `SUPEREGO_CWD` | default folder for new threads |
| `SUPEREGO_AGENTS` | where skills and `AGENTS.md` live (default `~/.agents`) |
| `SUPEREGO_CLAUDE` | the `claude` Claude Agent threads run (default: the one on the login shell's `PATH`) |
| `SUPEREGO_SECRETS` | `file`: keep extensions' secrets encrypted in the data folder, not in the keychain |
