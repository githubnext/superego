# mu

One app for running agents: a desktop app, a daemon per machine that keeps agents running when the app is closed, and
(coming) a web and mobile client. What an agent is (its model, prompt, tools, extensions) comes from **profiles**: files
in `~/.mu/profiles/` or inside a project's own `.mu/profiles/`, so a repo can carry the harness it needs. See
[PLAN.md](PLAN.md) and [docs/structure.html](docs/structure.html). The framework-with-a-generator version is tagged
`pre-embedded`.

```sh
pnpm install
pnpm test               # unit + daemon/CLI e2e (scripted models)
pnpm typecheck
pnpm dev                # the app; its daemon lives in ~/.mu
pnpm --filter mu smoke  # headless e2e of the app
pnpm --filter mu showcase /tmp/shots   # scripted threads, screenshotted
pnpm --filter mu package               # mu.app in app/dist
pnpm link:cli           # `mu` on your PATH (~/.local/bin/mu -> app/bin/mu.ts)
```

## Layout

| | |
|---|---|
| `app` | the mu app: Electron main, window, daemon entry, the `mu` command, icons |
| `packages/protocol` | the contract: methods, JSON-RPC peer, actions, status |
| `packages/settings` | settings registry, used by daemons (per machine) and the app |
| `packages/daemon` | the daemon: pi-durable harness, sessions, models and sign-in; the daemon half of the extension API |
| `packages/client` | reaching daemons: local socket, ssh, any stdio command; the machine list |
| `packages/cli` | the command line |
| `packages/ui` | component kit and design tokens |
| `packages/app` | main process, window, preload, build and packaging; the UI half of the extension API |
| `extensions/threads` | the session sidebar (UI) |
| `extensions/ask-user` | an `ask_user` tool; the question card and blocked status (daemon + UI) |

An extension has a daemon half (`defineDaemonExtension`: agent tools and hooks, settings, actions, live values, session
status) and a UI half (`defineUiExtension`: slots, tool and entry renderers, settings sections, actions).

## Environment

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
elsewhere with a first message; `-P <profile>` picks a profile. Every command takes `-m <machine>` and `--json`; `mu help`
lists them. A remote machine needs `mu` on its PATH for `ssh <host> mu connect --start`.

## Profiles

```sh
mu profile new            # .mu/profiles/default/profile.ts in this project (allowed, since you made it)
mu profile new support    # another, for `mu -P support`
mu profile new --user     # ~/.mu/profiles/default: yours, everywhere a project has none
mu profile allow support  # after pulling someone else's changes to it
```

```ts
import { defineProfile } from 'mu'
export default defineProfile({
  description: 'Answers customer mail',
  prompt: 'You answer customer email for Acme. Be brief.',
  extensions: ['./orders.ts'],     // defineExtension({ name, tools: [defineTool(…)] }) from 'mu'
  ui: ['./ui/badge.ts'],           // defineUiExtension({ name, setup(mu) { … } }) from 'mu/ui'
  without: ['ask-user'],
})
```

## In a browser or on a phone

Settings → a machine → Web access: serve the app to this computer or the local network. Open the address it shows (it
carries a token); on a phone, add it to the home screen.
