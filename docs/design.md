# Superego: design

One app for running agents: a desktop app, a daemon per machine, and the same window in a browser or on a phone. What
an agent *is* comes from profiles: files in `~/.superego` or inside a project's own `.superego`, so a repo carries the
harness it needs. What it does for the user is in [overview.md](overview.md); how to extend it is the skill
(`packages/cli/skill/`, `superego --skill`); the repository's layout is in [development.md](development.md).

## Principles

1. **The core is a runtime plus a shell, not a product.** The sidebar, terminals, the diff view, Ego: all extensions,
   most of them optional. The test: *if it only makes sense with a particular layout, it's not core.*
2. **Headless daemon, UI as client.** Closing the window never stops an agent.
3. **One method table.** `packages/protocol/src/methods.ts` types the daemon's dispatch and every client; a test holds
   the daemon to what the generation released.
4. **State, not events.** Clients render durable state: a watch is a snapshot, then ops.
5. **Status is a protocol.** The OSC 7501 vocabulary (`idle|working|done|blocked{permission|question|auth}|error`)
   end to end, so Superego's agents and Claude Code, Codex or pi in a terminal look the same.
6. **No hard-coded agent topology.** Threads start threads; nothing fixes who coordinates whom.

## Architecture

```
┌──────────── Electron app (one per computer) ──────────┐
│ renderer: the window + extensions' UI halves          │
│        ▲ preload: window.superego.call / on           │
│ main:  links to N machines                            │
└───────┬─────────────────────────────┬─────────────────┘
        │ unix socket                 │ ssh -T host superego connect (stdio)
┌───────▼──────────────┐     ┌────────▼─────────────┐
│ superego daemon      │     │ superego daemon (box)│   Node, one per user per machine:
│  • pi-durable harness│     │  the same            │   ELECTRON_RUN_AS_NODE locally,
│    on SQLite         │     │                      │   plain `node` remotely
│  • threads, profiles │     │                      │
│  • extensions' daemon│     │                      │
│    halves            │     │                      │
│  • Web access (HTTP, │     │                      │
│    WebSocket)        │     │                      │
└──────────────────────┘     └──────────────────────┘
```

**The daemon** (`packages/daemon`) owns one pi-durable harness on SQLite (one writer), the thread catalog and the
extension host. It speaks JSON-RPC 2.0 over NDJSON on a mode-0600 unix socket; `superego connect` bridges stdio to it.
Streams are notifications on subscription ids. Bulk bytes (uploads, terminals) go on channels: still JSON-RPC lines,
base64 chunks within the credit the receiver grants, sent only behind every control message
(`packages/protocol/src/channels.ts`). A client that pings (`heartbeat`) notices a dead link in seconds on any
transport, and the daemon hangs up on one that stops.

**The main process** is thin: windows, the machine list (`~/.superego/machines.json`), ssh links, and one generic
`call`/`on` relay. Each link reconnects with backoff; a disconnected machine stays visible but stale.

**The daemon as a hub.** A daemon keeps links of its own to the machines in its `machines.json` (the same
`MachineLinks` from `packages/client` the app uses: identity remembered, a machine reached twice refused, never
itself). Its clients reach them through it: `machines.watch` lists them (itself as `local`), `relay.call` passes a
call on, and their notifications come back as `relay.event`. A browser and agents (`thread_*` with `machine`) go
through the hub, which therefore holds every machine's access: pair browsers with care. A call goes on with who it's
for (`relay.as`: a thread's shell, an extension), so the far machine refuses it the user's consent as the hub would; to
an older daemon without `relay.as`, the hub passes on nothing for them that could be consent.

```
browser ──ws── daemon (hub) ──ssh/via── daemon (box)        agent on the hub ─ thread_start {machine: box}
```

**The window** is React 19, plain CSS on `packages/ui`'s tokens, Base UI for overlays. In a browser it has no preload:
`window.superego` is a WebSocket bridge to the daemon that served it.

## The protocol

The protocol version is a **generation** (now 2); peers of one generation negotiate by `features`, not by version.
Within a generation the core only grows: `RELEASED` (`packages/protocol/src/released.ts`) names what it released, and
`released-actions.json` the params of its actions; a test fails when a daemon no longer answers one or an action's
params break a caller. The skew policy is in the skill (`superego --skill lifecycle`, "The skew policy").

Reads and streams (`*.list`, `*.watch`) are plain methods. Everything that changes something is an **action**: an id,
a params schema, where it runs (`window`, `app` or `machine`), who may call it (`expose`), a default shortcut. One
router validates params, runs the action and logs it with its source; keys, the ⌘K palette, buttons, extensions,
`superego do` and `superego mcp` all dispatch through it. Shortcuts are data (`app.keys`).

## Entities

```
Machine
└─ Project (derived: by the folder threads belong to; a repository's main checkout holds its worktrees)
   └─ Thread (a pi-durable conversation + folder + title + profile + worktree? + panes)
      ├─ Pane (a kind and its params: kept with the thread, so every client shows the same)
      └─ child threads
```

Projects aren't stored: each thread keeps the project it belongs to, and clients group by it. What a client shows and
where its focus is (the selection, a draft, an editor's scroll) are the client's own.

A thread's status is derived: a run → `working`; an extension says blocked (agent-ui's question) → `blocked`; a failed
run → `error`; an answer the user hasn't seen → `done`; otherwise `idle`. "Seen" is stored per thread, so every
client agrees.

## Decisions

1. **Own protocol, own TypeScript daemon.** We never wait on or adapt to anyone else's roadmap (herdr's `hc`, Fut's
   protocol). We borrow their ideas.
2. **Electron, not Tauri.** Tauri's wins are bundle size and idle memory, from the system webview. Rendering isn't
   faster, and WebKitGTK on Linux is slower. Its Rust backend would still need a Node sidecar for pi-durable, and
   extension authors would test three engines instead of Chromium. The daemon is UI-independent, so the shell stays
   swappable. (A native AppKit shell was tried and isn't ready to replace Electron: tag `native-spike`.)
3. **Terminals are a bundled extension** (`extensions/terminal`), not core: the daemon hosts the PTYs (node-pty, as
   `@lydell/node-pty`'s N-API prebuilds, which load in Electron as Node and in plain Node alike); the window draws them
   with ghostty-web (Ghostty's emulator as WebAssembly), the same on desktop and web.
4. **Chord:** delta ops only (`applyImmutable` in the window), not its facet/plugin system.
5. **Base UI** for the kit's overlays: portals, positioning, focus and Escape done right, instead of hand-rolled. Only
   `packages/ui` depends on it: its components (`Dialog`, `Switch`, `Slider`, …) wrap Base UI's parts, and the parts
   themselves, unstyled, are `BaseUI.X` from `@superego/ui`. One copy, so popups nested across packages layer right.

## Open

- **Remote install.** A machine runs a checkout installed by `scripts/install-machine.sh`, and Update (or
  `superego machines update`) runs it again over ssh. With `--release`, a Mac runs the release's app instead, with no
  checkout, and Linux a checkout at the release's tag.
- **The service's lifecycle.** `superego daemon install` runs the daemon as a systemd user unit or a launchd agent,
  brought back after a crash or a restart (exit 75), not after a stop. A service starts the daemon with the unit's
  environment only, so a restart leaves its own in `restart-env.json` (0600) for the successor. Such a daemon has no
  `SSH_AUTH_SOCK` unless the service manager gives it one: its links that need the agent show "needs login".
- **Name and package scope.** `@superego/*` for now; publishing decides it.

## Next

- **Web and mobile:** accounts and TLS, a service worker (offline, and notifications on a phone), native shells as
  wrappers.
- **MCP, more:** watches as resources (a thread's transcript, the thread list); more actions exposed to outside agents
  as they prove safe.
- **Background jobs**, as an extension.
- **The terminal:** the daemon keeping each terminal's screen with a headless emulator, so a window attaching gets
  the screen rather than raw output replayed; terminals that survive a daemon restart (a PTY holder process);
  channels relayed by the hub, so a browser reaches terminals on the machines it reaches; a tab title from the shell
  (OSC 0/2). The headless emulator can be Ghostty's own (libghostty-vt, as WebAssembly in Node: tried, it works).
  Embedding the native libghostty in Electron would be weeks of work, macOS only, on an API Ghostty doesn't offer
  to embedders.
- **A sandboxed tier for UI extensions**, for UI an agent writes: today a profile's UI runs with the window's full
  authority.
- **MCP servers:** importing servers from Claude Code and Cursor configs; per-tool narrowing in profiles; code mode
  over MCP tools; elicitation as `ask_ui`, prompts as `/` commands, resources as `@` mentions; replaying read-only
  calls after a restart; Client ID Metadata Documents; sandboxed stdio servers for projects.
- **The renderer's cost** (`app/test/profile.sh` measures it): sidebar rows that render only when their thread
  changes (the shell's state as a store with selector hooks); a terminal render loop that sleeps until something
  changed (upstream, in ghostty-web).
- **Publishing the packages**; then extensions installed at runtime.
