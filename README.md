# mu

An Electron version of pi: a bare-bones core with an agent (pi-durable), sessions across machines, and (soon) an extension API for arbitrary web UI. See [PLAN.md](PLAN.md).

```sh
pnpm install
pnpm test                       # daemon e2e over the socket (scripted model)
pnpm typecheck
pnpm dev                        # the app; starts ~/.mu daemon on first launch
pnpm --filter @mu/app smoke     # headless app e2e: chat, quit, reopen, reattach
node packages/daemon/src/cli.ts help
```

**Environment variables**

| Variable | Meaning |
|---|---|
| `MU_HOME` | Data dir (default `~/.mu`): `mu.sqlite`, `mu.sock`, `daemon.log`, `settings.json`, `auth.json`, `app-settings.json` |
| `MU_MODEL` | Default model when none is chosen in Settings (`provider/model`), `faux` for the echo model, or `replay:<file>` to play back recorded turns |
| `MU_RECORD` | Append every real model answer to this JSONL file, for `replay:` later |
| `MU_REPLAY_SPEED` | Replay pace in tokens per second (default 120; 0 is instant) |
| `MU_CWD` | Default working directory for new sessions |

**Layout**

- `packages/protocol`: method table, JSON-RPC peer, status model
- `packages/settings`: settings registry, used by the daemon (per machine) and the app
- `packages/daemon`: the daemon (pi-durable Harness on SQLite), socket server, `mu` CLI
- `packages/ui`: minimal component kit and design tokens
- `app`: Electron main (machine links), preload bridge, renderer
