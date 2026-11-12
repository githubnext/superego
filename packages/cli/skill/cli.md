# The superego command

Every command talks to a machine's daemon, starting this computer's when it isn't running. Two options work
everywhere:

- `-m <machine>` works on another machine (by name or id from `superego machines`). Default: this computer.
- `--json` prints JSON instead of a table. Use it whenever a program (or you) reads the output.

`superego help` lists every command.

## Threads

```sh
superego [dir] [-p prompt] [-P profile] [-w]   # start a thread in dir (default: here) and open it in the app
superego create [dir] [-p prompt] [-P profile] [-w]   # the same without the app; prints the id (also: new)
superego open <thread>                         # show a thread in the app
superego send <thread> <text...>               # send a message
superego threads [--archived]                  # list them (also: ls)
```

- `-P <profile>` picks a profile; without it a thread gets the folder's `default` profile, the project's before
  yours, or none.
- `-w` gives the thread a git worktree of its own: `~/.superego/worktrees/<repo>/<slug>`, branch `superego/<slug>`.
- On another machine (`-m`), `dir` is a path there.
- `superego do thread.create --parent <thread> …` starts it as that thread's child (nested under it in the sidebar).
  Inside a thread, agents have `thread_start`, `thread_read` (`wait: true`), `thread_send` and `thread_list`, and name
  threads in messages as `[title](thread:<id>)`.

A thread's status is `idle`, `working`, `done`, `blocked` (waiting on the user: a question, say) or `error`. To wait
for an answer from a script, poll:

```sh
id=$(superego create . -p "Summarise the open TODOs" --json | jq -r .id)
until superego threads --json | jq -e --arg id "$id" '.[] | select(.id == $id) | .status.state | test("done|blocked|error")' > /dev/null; do sleep 2; done
```

The command line doesn't print a thread's transcript; open it in the app (`superego open <id>`).

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
| `thread.rename` `id title`, `thread.archive` `id`, `thread.unarchive` `id` | (Ego is never archived) |
| `pane.open` `id kind title? params?` | open a pane beside a thread (`diff`, `editor`, `preview`, `artifact`, `thread`, a profile's own) |
| `pane.close` `id pane`, `pane.focus` `id pane?` | |
| `profile.list` `cwd?`, `profile.allow` `cwd? name?` | |
| `thread.meta` `prompt?` | ask Ego, Superego's own agent (one hidden thread per machine): it answers, and starts threads for any work |
| `thread.meta.clear` | clear Ego's conversation: the same thread, empty again |

`pane.open` takes nested `params`, so give it JSON:

```sh
superego do pane.open --params '{"id":"<thread>","kind":"editor","params":{"path":"README.md"}}'
```

Extensions add their own actions (`ask-user.answer`, `vault.graph`); they show in the list too.

## Profiles

```sh
superego profile                    # the profiles a thread here could start with
superego profile new [name]         # .superego/profiles/<name>/profile.ts in this project, allowed
superego profile new [name] --user  # ~/.superego/profiles/<name>: yours, everywhere
superego profile allow [name]       # let this project's profile run (again, after it changed)
```

`name` defaults to `default`. See `superego --skill profiles`.

## Machines

```sh
superego machines                              # each, and whether it answers
superego machines add <ssh-target> [--name N] [--command C]
superego machines add --via '<command>' [--name N]   # any command piping stdio to the far side
superego machines rm|enable|disable|trust <machine>
```

A remote machine needs `superego` installed there (`scripts/install-machine.sh` in the Superego repo); the app reaches it
with `ssh <target> superego connect --start`.

## Settings and sign-in

```sh
superego settings                     # every setting and its value
superego settings set <key> <value>   # value is JSON, or plain text; --all: every enabled machine
superego settings reset <key>
superego auth                         # providers and how each is signed in
superego auth key <provider>          # store an API key (prompted, or from stdin)
superego auth logout <provider>
```

Each machine has its own settings (models, providers, which extensions are on). OAuth sign-in happens in the app's
Settings.

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
