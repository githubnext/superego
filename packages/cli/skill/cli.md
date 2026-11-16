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
superego create [dir] [-p prompt] [-P profile] [-w]   # the same without the app; prints the id (also: new)
superego open <thread>                         # show a thread in the app
superego send <thread> <text...>               # send a message
superego threads [--archived]                  # list them (also: ls)
superego read <thread> [--wait]                # its state and last answer; --wait: once it stops working
```

- `-P <profile>` picks a profile; without it a thread gets the folder's `default` profile, the project's before
  yours, or none.
- `-w` gives the thread a git worktree of its own: `~/.superego/worktrees/<repo>/<slug>`, branch `superego/<slug>`.
- On another machine (`-m`), `dir` is a path there.
- `superego do thread.create --parent <thread> …` starts it as that thread's child (nested under it in the sidebar).
  Inside a thread, agents have `thread_start`, `thread_read` (`wait: true`), `thread_send`, `thread_list` and
  `thread_archive` (a thread that isn't working, or with no id their own, once the turn ends), and name threads in
  messages as `[title](thread:<id>)`.

A thread's status is `idle`, `working`, `done`, `blocked` (waiting on the user: a question, say) or `error`. Blocked
with kind `auth` is waiting for sign-in: its provider rejected the machine's credentials, and it goes on by itself
once they change (`superego threads` says which provider, and how to sign in again). To wait for an answer from a
script, `read --wait` (it waits for the answer to a message just sent too; `--json` for `{ thread, answer }`):

```sh
id=$(superego create . -p "Summarise the open TODOs")
superego read "$id" --wait
superego send "$id" "Now the tests" && superego read "$id" --wait
```

The command line prints a thread's last answer, not its transcript; open it in the app (`superego open <id>`).

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
| `thread.create` `cwd? title? prompt? profile? model? worktree?` | start a thread |
| `thread.submit` `id text whenBusy?=steer\|followUp` | send a message |
| `thread.abort` `id` | stop the agent |
| `thread.rename` `id title`, `thread.archive` `id`, `thread.unarchive` `id` | `thread.archive` answers `{ notes }`, what extensions did (its worktree removed, say). Ego is never archived |
| `pane.open` `id kind title? params?` | open a pane beside a thread (`editor`, `thread`; `diff` from git, `preview` and `artifact` from web-panes; a profile's own) |
| `pane.close` `id pane`, `pane.focus` `id pane?` | |
| `profile.list` `cwd?`, `profile.allow` `cwd? name?` | |
| `ego.ask` `prompt?` | ask Ego, Superego's own agent (one hidden thread per machine): it answers, changes settings and machines, and starts threads for any other work. `thread.meta` is its old name |
| `ego.clear` | clear Ego's conversation: the same thread, empty again. `thread.meta.clear` is its old name |

`pane.open` takes nested `params`, so give it JSON:

```sh
superego do pane.open --params '{"id":"<thread>","kind":"editor","params":{"path":"README.md"}}'
```

Extensions add their own actions (`ask-user.answer`, `vault.graph`); they show in the list too.

## MCP

`superego mcp` serves a machine's actions to an agent outside Superego, as an MCP server on stdio:

```sh
claude mcp add superego -- superego mcp         # or {"command": "superego", "args": ["mcp"]} in a client's config
superego mcp -m <machine>                       # one server per machine
```

Each action exposed to `mcp` is a tool named for its id with `_` for `.` (`thread.create` is `thread_create`), its
schema the action's; it runs through `action.run` with `exposure: 'mcp'`, so `superego actions log` shows it from `mcp`.
Exposed: `thread.submit`, `thread.abort`, `thread.rename`, `thread.archive`, `thread.unarchive`, `pane.open`,
`profile.list`, `ego.ask` (the machine's Ego; its answer comes as any thread's), and `thread.create` once the machine
allows it:

```sh
superego settings set mcp.startThreads true   # Settings → Outside agents → Can start threads; off by default
```

Two tools of the server's own read: `thread_list` (`archived?`) and `thread_read` (`id wait?`: its state and last
answer, after it stops working with `wait`; Ego's thread too). Nothing that changes settings, signs in, trusts a
profile, writes files or restarts the daemon is a tool; an extension's action becomes one by adding `'mcp'` to its
`expose`. The tools follow the machine's extensions and settings as they change (`tools/list_changed`).

## Profiles

```sh
superego profile                    # the profiles a thread here could start with
superego profile new [name]         # .superego/profiles/<name>/profile.ts in this project, allowed
superego profile new [name] --user  # ~/.superego/profiles/<name>: yours, everywhere
superego profile types [name]       # types for an editor: tsconfig.json, node_modules → ~/.superego/types (--user: yours)
superego profile allow [name]       # let this project's profile run (again, after it changed)
superego profile allow-ui <name> -m <machine>   # let that machine's profile UI run in this computer's window, as it is now
superego profile revoke-ui <name> -m <machine>
```

`name` defaults to `default`. See `superego --skill profiles`.

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
superego auth                         # providers and how each is signed in
superego auth key <provider>          # store an API key (prompted, or from stdin)
superego auth logout <provider>
superego auth retry [provider]        # retry the threads waiting for sign-in now
```

Each machine has its own settings (models, providers, which extensions are on). OAuth sign-in happens in the app's
Settings.

## Web access

```sh
superego settings set web.access local       # off | local (this computer) | tailscale (https://<machine>.<tailnet>.ts.net)
superego web pair                            # a link, its QR code, and a code to type: one device, once, for 5 minutes
superego web devices                         # paired devices: name, last seen, address
superego web revoke <device>                 # unpaired; its connections close at once
superego web rename <device> <name>
```

A browser gets in as a paired device (an HttpOnly cookie; nothing secret in an address). With `tailscale`, the daemon
runs `tailscale serve` itself; your own Tailscale login gets in without pairing unless `web.tailscale.pairing` is on.
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
