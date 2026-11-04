# mu

A framework for agent apps: an Electron shell, a pi-durable daemon per machine, its own protocol, and extensions that
add to both. Apps are made with `mu new` and depend on mu's packages, as a Rails app depends on Rails. See [PLAN.md](PLAN.md)
and [docs/structure.html](docs/structure.html).

```sh
pnpm install
pnpm test                       # unit + daemon/CLI e2e (scripted models)
pnpm typecheck
pnpm dev                        # mu itself (examples/full); its daemon lives in ~/.mu
pnpm --filter mu smoke          # headless e2e of the full app
pnpm --filter mu-minimal smoke  # … and of the core alone
pnpm link:cli                   # `mu` on your PATH (~/.local/bin/mu -> examples/full/bin/mu.ts)
mu new ~/dev/my-agent           # a new app from the full example (--minimal for the core alone)
```

## Layout

| | |
|---|---|
| `packages/protocol` | the contract: methods, JSON-RPC peer, status, `AppConfig` |
| `packages/settings` | settings registry, used by daemons (per machine) and apps |
| `packages/daemon` | the daemon: pi-durable harness, sessions, models and sign-in; the daemon half of the extension API |
| `packages/client` | reaching daemons: local socket, ssh, any stdio command; the machine list |
| `packages/cli` | `runCli(app)`, every app's command line, and `mu new` |
| `packages/ui` | component kit and design tokens |
| `packages/app` | `startApp` (main), `mountApp` (window), preload, build preset; the UI half of the extension API |
| `extensions/threads` | the session sidebar (UI) |
| `extensions/ask-user` | an `ask_user` tool; the question card and blocked status (daemon + UI) |
| `examples/minimal` | the core alone |
| `examples/full` | mu itself: core plus every bundled extension |

## An app

```
mu.config.ts           defineApp({ name, id, glyph })
src/daemon.ts          serveDaemon({ app, extensions: [askUser] })        ← daemon halves
src/renderer/main.tsx  mountApp(app, { extensions: [threads, askUser] })  ← UI halves
src/main.ts            startApp(app)
bin/<id>.ts            runCli(app, …)
```

An extension is a package with `./daemon` and/or `./ui`. The daemon half (`defineDaemonExtension`) can add agent tools
and hooks, settings, methods (`<name>.<method>`), live values and session status. The UI half (`defineUiExtension`)
fills slots (`sidebar`, `session.header`, `composer.above`), draws tool calls and entries, settings sections and commands,
using hooks such as `useSessions`, `useSelection`, `useValue` and `call`.

## Environment

Every app reads `<ID>_…` (here `MU_…`):

| Variable | Meaning |
|---|---|
| `MU_HOME` | Data dir (default `~/.mu`) |
| `MU_MODEL` | Default model when none is chosen in Settings, `faux` for the echo model, or `replay:<file>` |
| `MU_REPLAY` | Offer a recording as the model `replay/replay` beside the default |
| `MU_RECORD` | Append every real model answer to this JSONL file, for replaying later |
| `MU_REPLAY_SPEED` | Replay pace in tokens per second (default 120; 0 is instant) |
| `MU_CWD` | Default working directory for new sessions |

## The command

`mu` starts a session in the current directory and opens it in the app. `mu <dir> -p "fix the tests"` starts one
elsewhere with a first message. Every command takes `-m <machine>` and `--json`; `mu help` lists them. A remote machine
needs the app's command on its PATH for `ssh <host> <id> connect --start`.
