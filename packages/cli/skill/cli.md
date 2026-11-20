# The superego command

Every command talks to a machine's daemon, starting this computer's when it isn't running. Two options work
everywhere:

- `-m <machine>` works on another machine (by name or id from `superego machines`). Default: this computer.
- `--json` prints JSON instead of a table. Use it whenever a program (or you) reads the output.

`superego help` lists every command; `superego <command> --help` (`superego extension test --help`, say) gives one
command's usage, options and examples.

## Threads

```sh
superego [dir] [-p prompt] [-P profile] [-w]   # start a thread in dir (default: here) and open it in the app
superego start [dir] [-p prompt] [-P profile] [-w]   # the same without the app; prints the id (also: new)
superego open <thread>                         # show a thread in the app
superego send <thread> <text...>               # send a message
superego threads [--archived]                  # list them (also: ls)
superego read <thread> [--wait]                # its state and last answer; --wait: once it stops working
superego unread [--count]                      # what's done, failed or needs you, unseen: the app icon's count
```

- `-P <profile>` picks a profile; without it a thread gets the folder's `default` profile, the project's before
  yours, or none.
- `-w` gives the thread a git worktree of its own: `~/.superego/worktrees/<repo>/<slug>`, branch `superego/<slug>`.
- On another machine (`-m`), `dir` is a path there.
- `superego do thread.start --parent <thread> …` starts it as that thread's child (nested under it in the sidebar).
  Inside a thread, agents have `thread_start`, `thread_read` (`wait: true`), `thread_send`, `thread_list` and
  `thread_archive` (a thread that isn't working, or with no `thread` their own, once the turn ends), and name threads in
  messages as `[title](thread:<id>)`.

A thread's status is `idle`, `working`, `done`, `blocked` (waiting on the user: a question, say) or `error`. Blocked
with kind `auth` is waiting for sign-in: its provider rejected the machine's credentials, and it goes on by itself
once they change (`superego threads` says which provider, and how to sign in again). To wait for an answer from a
script, `read --wait` (it waits for the answer to a message just sent too; `--json` for `{ thread, answer }`):

```sh
id=$(superego start . -p "Summarise the open TODOs")
superego read "$id" --wait
superego send "$id" "Now the tests" && superego read "$id" --wait
```

The command line prints a thread's last answer, not its transcript; open it in the app (`superego open <id>`).

`superego unread` counts by the app icon's rule, on this computer and every machine its daemon is connected to. It
never starts the daemon (with none running it prints 0), so a status bar can poll it:
`superego unread --count`, or `--json` for `{ count, threads: [{ machine, id, title, state }] }`.

## Actions

Everything the app can do is an action. `superego actions` lists those a machine takes from the command line, with
their parameters (`?` marks optional ones, `a|b` choices); `--all` lists every action, window ones too.

```sh
superego actions
superego do <action> --<param> <value> ...      # values are coerced to the action's schema
superego do <action> --params '<json object>'   # all parameters at once, for nested values
superego actions log                            # the latest runs, from anywhere, with errors
```

Useful ones:

| Action | Does |
|---|---|
| `thread.start` `cwd? title? prompt? profile? model? parent? options?` | start a thread; `options: { worktrees: true }` gives it a git worktree of its own |
| `thread.send` `thread text whenBusy?=steer\|followUp` | send a message |
| `thread.stop` `thread` | stop the agent, and the messages waiting their turn: answers `{ returned }`, the user's own (each its `content` and `attachments`), to write again; another thread's or an extension's are withdrawn, and the transcript says so |
| `thread.rename` `thread title`, `thread.archive` `thread`, `thread.unarchive` `thread` | `thread.archive` answers `{ notes }`, what extensions did (its worktree removed, say). Ego is never archived |
| `pane.open` `thread kind title? params?` | open a pane beside a thread (`editor`, `thread`; `diff` from git, `browser` (`{ url }` or `{ path }`) from browser; a profile's own) |
| `pane.close` `thread pane`, `pane.focus` `thread pane?` | |
| `pane.move` `thread pane to` | move a pane to another place beside the thread (`to`: 0 first) |
| `profile.list` `cwd? user?`, `profile.allow` `cwd? name?` | `user`: yours only, wherever they come from |
| `profile.sources`, `profile.install` `source`, `profile.remove` `source`, `profile.update` `source?` | profile sources (`install` is the user's consent) |
| `ego.ask` `prompt?` | ask Ego, Superego's own agent (one hidden thread per machine): it answers, changes settings and machines, and starts threads for any other work |
| `ego.clear` | clear Ego's conversation: the same thread, empty again |

`pane.open` takes nested `params`, so give it JSON:

```sh
superego do pane.open --params '{"thread":"<thread>","kind":"editor","params":{"path":"README.md"}}'
```

Extensions add their own actions (`agent-ui.answer`, `vault.graph`); they show in the list too.

## Outside agents

`superego mcp` serves a machine's actions to agents outside Superego (outside agents), as an MCP server on stdio:

```sh
claude mcp add superego -- superego mcp         # or {"command": "superego", "args": ["mcp"]} in a client's config
superego mcp -m <machine>                       # one server per machine
```

Each action exposed to `outside` is a tool named for its id with `_` for `.` (`thread.start` is `thread_start`, the
same name as the tool agents inside have), its schema the action's; it runs through `action.run` with
`exposure: 'outside'`, so `superego actions log` shows it from `outside`.
Exposed: `thread.send`, `thread.stop`, `thread.rename`, `thread.archive`, `thread.unarchive`, `pane.open`,
`profile.list`, `ego.ask` (the machine's Ego; its answer comes as any thread's), and `thread.start` once the machine
allows it:

```sh
superego settings set outside.startThreads true   # Settings → Outside agents → Can start threads; off by default
```

Two tools of the server's own read: `thread_list` (`archived?`) and `thread_read` (`thread wait?`: its state and last
answer, after it stops working with `wait`; Ego's thread too). Nothing that changes settings, signs in, allows a
profile, writes files or restarts the daemon is a tool; an extension's action becomes one by adding `'outside'` to its
`expose`. The tools follow the machine's extensions and settings as they change (`tools/list_changed`).

## Profiles

```sh
superego profile                    # the profiles a thread here could start with
superego profile new [name]         # .superego/profiles/<name>/profile.ts in this project, allowed (an agent's waits for the user)
superego profile new [name] --user  # ~/.superego/profiles/<name>: yours, everywhere
superego profile types [name]       # types for an editor: tsconfig.json, node_modules → ~/.superego/types (--user: yours)
superego profile allow [name]       # let this project's profile run (again, after it changed)
superego profile allow-ui <name> -m <machine>   # let that machine's profile UI run in this computer's window, as it is now
superego profile revoke-ui <name> -m <machine>
superego profile install <source>   # yours from a git repo (git:<host>/<owner>/<repo>[@ref]) or a folder: trusted code
superego profile remove <source>    # drop it (a git one's clone too)
superego profile update [source]    # git pull --ff-only the git sources
superego profile sources            # each source, its state and profiles
```

`name` defaults to `default`. See `superego --skill profiles`.

Allowing records the user's consent, so only the user does it: an agent's command line (run in a thread's shell,
which `SUPEREGO_THREAD` marks) is refused `profile allow`, `profile allow-ui`, `machines trust`, `web pair` and every
action marked `consent`. As an agent, tell the user what to allow and where.

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

Each takes `-P <profile>` (default: `default`) and `--user` (yours, in `~/.superego/profiles`). Each shape `new` makes
passes `extension test` as made. See `superego --skill guide`.

## Machines

```sh
superego machines                              # each, whether it answers, and if it runs an older or newer Superego
superego machines add <ssh-target> [--name N] [--command C]
superego machines login <machine>     # ssh in this terminal: a password or code; links then ride that connection
superego machines add --via '<command>' [--name N]   # any command piping stdio to the far side
superego machines rm|enable|disable|trust <machine>
superego machines update <machine> [--now]     # run its install-machine.sh there; --now even while agents work
```

A remote machine needs `superego` installed there (`scripts/install-machine.sh` in the Superego repo); the app reaches it
with `ssh <target> superego connect --start`. `superego daemon install` on a machine runs its daemon as a service (systemd
user unit, launchd agent) so it outlives logouts and reboots. A host that needs a password or code shows as "needs login"
until `machines login`.

## Settings and sign-in

```sh
superego settings                     # every setting and its value
superego settings set <key> <value>   # value is JSON, or plain text; --all: every enabled machine
superego settings reset <key>
superego layout                       # the window's layout.json: the views there are, the places each fits, and where they are
superego providers                    # every provider pi-ai has and how each is signed in, signed-in first
superego providers key <provider>     # sign in with an API key (prompted, or from stdin); asks more where it needs more
superego providers sign-out <provider>
superego providers retry [provider]   # retry the threads waiting for sign-in now
superego providers add --name Ollama --base-url http://localhost:11434/v1 [--key -] [--model <id>...]
superego providers remove <provider>  # one you added
superego models                       # the signed-in providers' models, favourites (★) first
superego models favourite <provider/model>   # or unfavourite: the model menus list favourites first
```

Each machine has its own settings (models, providers, favourites, which extensions are on). OAuth sign-in (ChatGPT,
GitHub Copilot, OpenRouter) happens in the app's Settings. Providers you add are OpenAI-compatible endpoints, kept in
`~/.superego/models.json` in pi's format (`providers.<id>.{ name, baseUrl, api, models: [{ id }] }`); their keys are in
`auth.json` with the others. Credentials in the environment count too (`GROQ_API_KEY`, `AWS_PROFILE`, …).

## MCP servers

The MCP servers a machine's agents use (Settings → MCP servers), from the bundled `mcp-servers` extension:

```sh
superego mcp-servers                         # each, and how it stands
superego mcp-servers --thread <thread>       # the servers its last turn had, and those it went without, and why
superego mcp-servers logs <name> [--lines N] # its log (secrets hidden)
superego mcp-servers restart <name>
superego mcp-servers set-secret <name> [VAR] # its API key or a secret env var (prompted, or from stdin)
superego mcp-servers sign-in <name>          # OAuth: open the page it prints, or paste where the browser ends up
superego mcp-servers sign-out <name>
```

## Web access

```sh
superego settings set web.access local       # off | local (this computer) | tailscale (https://<machine>.<tailnet>.ts.net)
superego web pair                            # a link, its QR code, and a code to type: one device, once, for 5 minutes
superego web devices                         # paired devices: name, last seen, address
superego web revoke <device>                 # unpaired; its connections close at once
superego web rename <device> <name>
```

A browser gets in as a paired device (an HttpOnly cookie; nothing secret in an address). With `tailscale`, the daemon
runs `tailscale serve` itself (Tailscale 1.94 or later), proxying to a socket in the data folder that only you and
tailscaled can open; your own Tailscale login gets in without pairing unless `web.tailscale.pairing` is on.
A device unused for 90 days is forgotten.

## The daemon

```sh
superego daemon status            # running? on the installed build?
superego daemon restart [--now]   # onto the installed code; --now interrupts working agents (they resume)
superego daemon stop
superego daemon                   # run it in the foreground
```

Its data is in `~/.superego` (`SUPEREGO_HOME`), its log in `~/.superego/daemon.log`.

## Environment

| Variable | |
|---|---|
| `SUPEREGO_HOME` | data folder (default `~/.superego`) |
| `SUPEREGO_MODEL` | default model; `faux` echoes, for trying things without a provider |
| `SUPEREGO_CWD` | default folder for new threads |
| `SUPEREGO_AGENTS` | where skills and `AGENTS.md` live (default `~/.agents`) |
