# Superego — plan

> One app for running agents: a desktop app, a daemon per machine, and the same window in a browser or on a phone. What an agent *is* comes from profiles: files in `~/.superego` or inside a project's own `.superego`, so a repo carries the harness it needs.

## The pivot (2026-11-05)

Superego was a framework with a generator (`superego new`, each app its own build). That is tagged `pre-embedded`. Now:

- **One app** (`app/`): the desktop app, its daemon and the `superego` command. No generator, no per-app builds.
- **Profiles** (§3b): `profile.ts` (`defineProfile` from `'superego'`) in `~/.superego/profiles/<name>` or `<repo>/.superego/profiles/<name>`, with a model, a prompt, agent extensions (tools, prompt sections, hooks) and UI extensions. A thread takes its folder's profile when it starts; a project's profile runs only once allowed.
- **Web and phone** (§3c): a machine's daemon serves the same window to browsers (Web access), over a WebSocket open to paired devices and the owner's Tailscale login; narrow windows get a phone layout, and it installs as a PWA.
- **Sessions, threads, panes** (§3d, 2026-11-09): a session is a project on a machine; it holds threads (conversations, each in the folder or a worktree of its own); a thread holds panes beside it. Navigation follows Fut; focus follows Tremolo.
- Packaging the one app (`pnpm --filter superego package`) builds a signed `superego.app`.

Principle 6 below (no network listener) gave way: Web access is a network listener, off by default, on loopback; `tailscale serve` takes it to the tailnet with HTTPS. Devices pair one by one; the owner's Tailscale login gets in by name.

Research sources: `~/dev/fut`, `~/dev/wt`, `~/dev/gh/tremolo`, pi-mono (`~/.cache/checkouts/github.com/badlogic/pi-mono`, v1.5.0), herdr / herdr-core / herdr-app (`~/.cache/checkouts/github.com/herdrdev/*`), pi-pocket, durable-pi.

---

## 0. Does Herdr already do this?

Partly. **herdr-core (`hc`)** already ships the runtime half:
- headless terminals that persist (PTY holder → restartable core → clients)
- machines over SSH or a `--via` command
- OSC 7501 status
- parent/child agents
- an OpenRPC JSON-RPC API

**herdr-app** is not Superego:

| | herdr-app | Superego |
|---|---|---|
| UI | Native GPUI. Mods are QuickJS describing native widgets; the docs explicitly say no HTML/CSS/webview. | Electron, so extensions are arbitrary web UI. |
| Agent | None. It hosts external CLI agents, and core refuses vendor logic. | Built in: pi-durable, with hooks and activity. |
| Unit of work | A terminal (PTY). | An agent thread (durable conversation). Terminals are optional. |
| Extensibility | Agent-written recipes + JS mods; no versioned API. | Pi-style typed extension API, versioned. |

The niche is real. We should borrow herdr-core's protocol hygiene wholesale, and keep "use `hc` as the terminal substrate" as an option (see §7).

---

## 1. Principles

1. **The core is a runtime plus a shell, not a product.** Sidebar, bench, terminals, diff view: all extensions, some bundled. Use herdr's gate: *"if it only makes sense with a particular layout, it's not core."*
2. **Headless daemon, UI as client.** Closing the window never stops an agent. Learned in tremolo, fut and herdr alike.
3. **One method table** generates dispatch, the CLI, the TS client and the schema, with a frozen-contract test (herdr-core).
4. **State, not events.** Clients render durable state and subscribe to snapshot + ops (pi-durable 1.5 removed `watchEvents` for this reason; durable-pi broke on it).
5. **Status is a protocol.** Use the OSC 7501 vocabulary (`idle|working|done|blocked{permission|question|auth}|error`) end to end, so Superego agents, Claude Code, Codex and pi all look the same.
6. **SSH does auth.** No network listener. A remote machine is `ssh host superego connect` speaking the same protocol over stdio (fut, hc).
7. **No hard-coded agent topology.** tremolo's coordinator/worker split was a regret.

---

## 2. Architecture

```
┌──────────── Electron app (one per laptop) ────────────┐
│ renderer: Shell (layout slots) + extension UI modules │
│        ▲ MessagePort / contextBridge `superego.call/on`     │
│ main:  connection manager → N machine links           │
└───────┬─────────────────────────────┬─────────────────┘
        │ unix socket                 │ ssh -T host superego connect (stdio)
┌───────▼─────────┐          ┌────────▼─────────┐
│ superego daemon (local)│          │ superego daemon (box)  │   Node, per user per machine
│  • pi-durable    │          │  same            │   ELECTRON_RUN_AS_NODE locally,
│    Harness+SQLite│          │                  │   plain `node` remotely
│  • thread catalog          │                  │
│  • daemon-side extensions   │                  │
│  • docs (CAS key/value)     │                  │
│  • [pty host — optional]    │                  │
└──────────────────┘          └──────────────────┘
```

**Daemon** (`@superego/daemon`, plain Node/TS):
- owns one pi-durable `Harness` on node SQLite (one storage per daemon; durable allows a single writer)
- owns the thread catalog, the extension host and the doc store
- exposes JSON-RPC 2.0 over NDJSON on a mode-0600 unix socket; `superego connect` bridges stdio to it
- streaming uses notifications on subscription ids; bulk bytes (uploads now, terminals later) go on channels: still JSON-RPC lines, base64 chunks within credit the receiver grants, and the peer's writer sends them only behind every control message (`packages/protocol/src/channels.ts`)
- a client that pings (`heartbeat`) notices a dead link in seconds on any transport, and the daemon hangs up on one that stops

**Electron main:** thin. Window management, machine catalog (`~/.superego/machines.json`: `{id,label,target,enabled}`), spawning ssh links, and relaying one generic `call/on` (no hand-maintained channel lists; that was a tremolo regret). Each machine link reconnects with backoff, and a disconnected machine stays visible but stale (fut).

**The daemon as a hub:** a daemon keeps links of its own to the machines in its data dir's `machines.json` (the same `MachineLinks` from `@superego/client` the app uses: identity remembered, a machine reached twice refused, never itself), following the file. The app's daemon gets them through `serveDaemon({ reach })` (`machineHub`), so the daemon package doesn't depend on the client one. Its clients reach them through it: `machines.watch` lists them (itself as `local`), `relay.call` passes a call on (uploads it holds go onward on the link's own channels), and their notifications come back as `relay.event`, a watch's to the connection that opened it, anything else to every connection that has called that machine; watches end when their connection does. The desktop app keeps its own links as before; a browser and agents (`thread_*` with `machine`) go through the hub, which therefore holds every machine's access (pair browsers with care, §3c).

```
browser ──ws── daemon (hub) ──ssh/via── daemon (box)        agent on the hub ─ thread_start {machine: box}
```

**Renderer:** React 19, plain CSS on `@superego/ui` tokens, Base UI for overlays, electron-vite. The shell provides slots, the thread and its panes, Settings, the ⌘L navigator, the ⌘K palette and extensions' commands.

### Protocol surface (as built)

```
hello {client, version, features, label} → {version, features, machine{id, build, …}, methods, client}
clients.watch                             → snapshot + clients.changed (id, kind, label, via, connectedAt, activeAt)
client.perform {client, action, params}   → the other client gets client.perform and runs its own window action (navigation only)
thread.list {archived?}                   agent.models
thread.watch {id}                         → snapshot + watch.ops (Chord delta ops)
threads.watch                             → snapshot + threads.changed (status, model, cost, activeAt, session, worktree, panes)
file.read / file.find / file.watch {id, path} → file.changed      git.diff {id} (git)
profile.ui / profile.module               settings.watch          value.watch {key} → value.changed
action.list / action.run {id, params, exposure} / action.log            unwatch {sub}
ping                                      ch.open {ch, kind, params, window} → ch.data / ch.ack / ch.end / ch.abort
                                          (kind `upload`: an attachment named by its id, `{name, mimeType, upload}`)

actions, each also served under its id:
thread.create {cwd, prompt, attachments, profile, worktree} / submit {text, attachments} / abort / rename / seen
thread.archive / unarchive (its worktree removed if clean, and back)
pane.open / update / focus / close        file.write              profile.list / allow
settings.set   auth.login / respond / cancel / logout   daemon.restart   <extension>.<name>
web.pair → {link, code, expires}          web.devices / web.rename {id, name} / web.revoke {id}
machines.watch → snapshot + machines.changed     relay.call {machine, method, params} → relay.event {machine, method, params}
machines.reconnect {id}
```

Reads and streams (`*.list`, `*.watch`) stay plain methods. Everything that changes something is an action (§3a). The protocol version is a generation and stays 1; peers negotiate by `features`, not by version. The method table only grows: `RELEASED` (packages/protocol/src/released.ts) names what generation 1 released, `released-actions.json` beside it the params of its actions, and a test fails when a daemon no longer answers one or an action's params break a caller.

### Entities

```
Machine
└─ Session (derived: a project, by the folder threads belong to; a repository's main checkout holds its worktrees)
   └─ Thread (= pi-durable conversation + folder + title + profile + worktree? + panes)
      ├─ Pane (a kind and its params: kept with the thread, so every client shows the same)
      └─ child threads (subagents; die with parent unless detached)
```

Sessions aren't stored: each thread keeps the project it belongs to, and clients group by it. What a client shows and where its focus is (the selected thread, a draft, an editor's scroll) are the client's own.

---

## 3. Extension API

As built (2026-11-04). An extension is a package with up to two halves, imported by an app at **build time**: `<pkg>/daemon` (listed in the app's `src/daemon.ts`) and `<pkg>/ui` (listed in `src/renderer/main.tsx`). Runtime-installed and user extensions come later. The current shape is in `docs/structure.html`.

**Daemon half** (`defineDaemonExtension`):
- `superego.agent(ext)`: pi-durable tools, prompt sections, hooks, tasks
- `superego.settings`: register settings sections of its own (`<name>.…`), read any
- `superego.action(defineAction({ id: '<name>.<m>', params, run }))`: what clients can do (§3a)
- `superego.method('<name>.<m>', run, { params })`: reads, called by name, not actions
- `superego.value(key, initial)`: live values, watched by name with `value.watch`
- `superego.pane(kind, about)`: pane kinds told to the agent for open_pane
- `superego.status(fn)`: mark a thread blocked
- `superego.harness`, `superego.threads` (list, get, conversation, `of(conversationId)`)
- Everything registered is owned and undone with the extension. Each one announces `ext:<name>` in `hello`.
- Each extension declares itself once (`{ name, title, description, required }`, both halves): optional ones (all but
  the sidebar, the core's agent parts included) are switched per machine and left out by profiles (`without`); a
  thread's `without` reaches clients, and the window draws none of their UI for it.

**UI half** (`defineUiExtension`):
- Slots: `sidebar`, `thread.header`, `composer.above`, `thread.aside`, `editor.side`, `editor.bar`, `overlay`
- `superego.pane(kind, { title, component, menu?, opens? })`: a kind of pane; `opens(path)` claims files opened from the thread, `menu` offers it in the header's pane menu
- `superego.tool(name, C)` and `superego.entry(kind, C)`: transcript renderers
- `superego.settings(ui, C)`: custom settings sections
- `superego.appSettings(section)`: the UI half's own settings, kept by the app
- `superego.action(defineAction({ id, title, keys, when, run }))`: window actions, for keys and the ⌘K palette (offered while `when` holds); `superego.dispatch` runs any action
- `superego.store(key, initial, { persist })`: the extension's window state, for its actions and components
- Hooks: `useMachines`, `useThreads`, `useSessions`, `useSelection`, `useSidebar`, `useThreadView`, `useValue`, `useAppSetting`, `useLocalState`, `useComposerClaim`, `useDispatch`, `useShortcut`, `call`, `has`.
- Components: `Markdown`, `FileEditor` (live preview, saves as you type, follows its file on disk; links, bar actions and what goes below are the caller's).

**Kit:** `@superego/ui` (Base UI underneath for dialog, menu, popover and tooltip) and its tokens.

**Trust:** in-process, like pi. A sandboxed tier comes later, for agent-written UI.

**Bundled extensions:**
- `threads`: the sidebar (sessions and their threads), with sort, rail and details modes
- `files`: the file tree beside the editor, and quick open (⌘P)
- `ask-user`: a tool, the blocked status, and the question in the composer

**Layout:** the shell's slots, and panes beside a thread (§3d).

## 3a. Actions

Every intent is an action: an id, a title, a params schema (pi-schema), where it runs (`window`, `app` or `machine`), who may call it (`expose`: `ui`, `cli`, `mcp`), a default shortcut, and whether it acts on the selected thread. One `Router` (in `@superego/protocol`) validates and coerces params, runs the action and logs it.

- **The window** has its own router. `dispatch(id, params)` runs window actions there, forwards app actions to the main process and machine actions to the right machine (`machine` option, else the selection's), filling in the thread from the selection. Keys, the palette, buttons and extensions all dispatch.
- **The log:** every dispatch with its source (`keys`, `palette`, `cli`, `composer`, an extension) and timing. *Show action log* in the window; `action.log` per machine; `superego actions log`.
- **The command line:** `superego actions` lists what a machine takes, `superego do <id> --param value…` runs one (values coerced to the schema, or `--params <json>`).
- **Shortcuts are data.** The setting `app.keys` holds only the user's changes by action id (`null`: none). Settings → Keyboard lists every action that runs without more input, records new shortcuts, and marks clashes; the first registered wins a clash. Plain keys without ⌘/⌃/⌥ are refused so typing stays typing.
- **Not a store.** Streams (threads, transcripts, settings, values) stay on watches; actions are intents only. Snapshots and the log make debugging output easy without one global state.

**MCP:** `superego mcp` (`packages/cli/src/mcp.ts`, on `@modelcontextprotocol/sdk`) is an MCP server on stdio, made from the actions a machine exposes to `mcp`: each is a tool (`thread.create` as `thread_create`: clients take `[A-Za-z0-9_-]`, and ids have no `_`) with the action's schema, run through `action.run` with `exposure: 'mcp'`, so the same log shows it from `mcp`, by a client of kind `superego-mcp` named for the MCP client. Reads stay methods, so two tools of the server's own read on them: `thread_list` and `thread_read` (state and last answer, waiting while it works). The list follows the machine (`features.changed` → `tools/list_changed`); the daemon is reached on the first request and again after a restart. Watches as resources: not built.
- **Exposure is opt-in.** An outside agent runs only what says `'mcp'` in its `expose`; `cli` doesn't imply it, since the command line is the user and an MCP client is whatever the user plugged in. Exposed: `thread.create`, `thread.submit`, `thread.abort`, `thread.rename`, `profile.list`. Not: settings, auth, `profile.allow`/`reload` (trust is the user's), `thread.archive` (it removes a worktree), `file.write`, panes, `web.*`, `machines.*`, `daemon.restart`, and every extension's (`ask-user.answer` and `reply-ui.answer` answer as the user; `ego.*` changes setup).
- **One server per machine.** `superego mcp` serves this computer, `superego mcp -m <machine>` another, over the CLI's own link. A `machine` param on every tool (through the hub's `relay.call`) would be cheap to route, but the tools are one machine's actions: another may take others, or the same with other schemas, and the hub would decide what an outside agent reaches. A client adds a server per machine it wants.

---

## 3b. Profiles

- **Where:** `~/.superego/profiles/<name>/profile.ts` (yours) and `<repo>/.superego/profiles/<name>/profile.ts` (the project's; the nearest `.superego/profiles` at or above a thread's folder). A project's replaces yours of the same name, unless it `extends: 'user:<name>'`.
- **What:** `defineProfile({ description, model, thinking, prompt, extensions, ui, panes, without, extends, worktree })`. `extensions` are agent extensions (pi-durable `defineExtension`: tools, prompt sections, hooks) or daemon extensions (`defineDaemonExtension`: actions, live values, agent extensions of their own; set up when the profile loads, torn down when it changes); `ui` are UI extensions (`defineUiExtension`); `panes` describes the pane kinds its UI adds, for the agent; `without` drops built-ins (`coding-tools`, `ask-user`); `worktree: true` gives its threads worktrees.
- **'superego':** profiles and their extensions `import … from 'superego'` (the daemon's SDK, through a loader hook: nothing to install) and `'superego/ui'` (the window's hooks and components). UI modules are TS or TSX, compiled by sucrase as they're served.
- **Threads:** a thread takes the folder's `default` (or a named) profile when it starts, and keeps it. Each turn selects that profile's extensions and instructions in the one harness (pi-durable selects extensions per conversation); a thread without a profile gets the built-ins. Edits reload from the next turn.
- **Trust:** a project's profile is that repo's code: it runs only once allowed (`superego profile allow`, or Allow and start in the app), and again after any of its files change.
- **UI:** the daemon serves a profile's UI modules (types stripped, only once allowed); the window rewrites their imports to its own React and `superego/ui` and installs them for that profile's threads only.
- **The command:** `superego profile` (list), `superego profile new [name] [--user]`, `superego profile types [name] [--user]`, `superego profile allow [name]`, `-P <profile>` when starting.
- **Proof:** the `obsidian` profile (user scope): a vault as a graph pane and as notes edited in live preview with backlinks, with search and backlink tools and the vault's own AGENTS.md read every turn.
- **Types for authors:** `profile new`, `extension new` and `profile types` (for profiles made before, or a fresh clone) give a profile a `tsconfig.json` with nothing of this computer in it, a `.gitignore`, and `node_modules` linked to `~/.superego/types/node_modules`. That holds declarations only: `superego`, `superego/ui`, `superego/unstable` and `superego/testing` emitted by TypeScript from the SDK's sources (`packages/sdk/types.ts`), the workspace packages they reach, and the outside declarations those reach (pi-durable, React, Node, vitest; ~19MB), copied as installed. The app's build writes them to `out/types` and the app copies them to `~/.superego/types` when it starts, so an upgrade refreshes every profile's types; a checkout's CLI builds them into `packages/sdk/.types` when the sources they came from changed. The docs' code, the starter and the examples are checked against them.
- Not yet: a profile's settings; a profile's UI in the sidebar.

## 3c. Web and phone

- **Web access** (a machine setting: off; to this computer; over Tailscale; a port): the daemon serves the window's build over HTTP on loopback and the protocol over a WebSocket at `/rpc`, to paired devices (an HttpOnly cookie each, from a one-time link or code; Settings lists them to rename and revoke) and, through `tailscale serve`, to the owner's own login. Nothing secret is ever in an address; every request must name a host it is served at, and the WebSocket must come from the page's origin. An artifact loads in its sandbox from an address carrying a capability for that thread and device; one on a machine the daemon reaches is `<thread>@<machine>`.
- **Who's connected:** the daemon lists its connections (`clients.watch`: kind from `hello`, a label: the computer's name, a browser's device name, a Tailscale login), the action log names who dispatched, and `client.perform` passes a window action to another client. Only navigation may be asked for (`PERFORMABLE` in the protocol: `thread.select`, `thread.next`/`previous`, `thread.unread`, `session.next`/`previous`, `pane.next`/`previous`); the daemon refuses anything else, and a window takes them only from its own machine's daemon ("local" on the desktop, the serving daemon in a browser), only while it is on screen, never relayed from a machine it merely reaches. Settings → a machine → Connected shows them.
- **In a browser** the window has no preload: `window.superego` is a WebSocket bridge to that daemon ("local") and, through it, every machine it reaches (`relay`, §2): calls for them go as `relay.call`, their news comes back as theirs. It pings (`heartbeat`), sends large attachments ahead as uploads, and holds back while the socket's buffer is full. App settings live in the browser; no other machine's profile UI runs there. Settings → Machines lists the machines with Reconnect; adding, removing, logging in and updating, and folder picking, are desktop-only.
- **Phones:** under 760px wide, one column: a bar with the threads in a drawer, the composer at the bottom, full-screen dialogs. A web manifest and icons for the home screen.
- Not yet: a service worker for offline, the desktop app as a wrapper of a remote daemon's web UI.

## 3d. Sessions, threads, panes

The window's model, after Fut: **session → thread → pane**.

- **A session** is a project on a machine: a git repository (worktrees included) or a folder. The machine is a fact about it, not a level above it. The sidebar lists sessions and their threads; ⌘⇧[ ⌘⇧] go between sessions, to the thread last shown in each.
- **A thread** is a conversation, by topic. It works in the folder it's started in, or (asked for when starting: the dialog's checkbox, `superego -w`, a profile's `worktree: true`) in a worktree of its own under `~/.superego/worktrees/<repo>/<slug>` on branch `superego/<slug>`. Archiving removes a clean worktree and keeps the branch; unarchiving brings it back.
- **Panes** are views beside a thread, kept with it. The thread and its panes are a row of columns scrolled sideways (Dinky's scrolling layout): a lone thread fills the width; pane columns share one width, dragged at an edge; the focused column scrolls just far enough to show. ⌃Tab moves along. On a phone each column is the screen's width.
- **Navigation:** ⌘L is the navigator (sessions, threads and panes as one searchable tree), ⌘K commands only, ⌘. the next unread thread, ⌘/ the sidebar (its button stays put, open or closed), ⌘P a file.
- **Focus** (after Tremolo): always visible: the region holding it wears one solid ring, its own border, and nothing inside it does but a small control reached from the keyboard. The window is a row of regions (sidebar, thread, panes); ⌘⌥← ⌘⌥→ move between them, ⌃I goes to the prompt; focus moving into a pane makes it the focused one.
- **Files:** the editor shows Markdown in live preview and follows its file on disk (`file.watch`); files named in a thread open beside it in the pane kind that takes them; messages carry attachments (images to the model as images, every file saved on the thread's machine).
- **The window's own state** (the selection, Settings, drafts, editors' places) survives a reload; it's never on a machine.

## 4. Agent and activity

- One agent runtime: pi-durable 1.5 with `CodingTools` and pi-ai models. Credentials are Superego's own (`<dataDir>/auth.json`), managed in Settings.
- **Derived status** per thread, from `pi.live` plus extension contributions:
  - `run` present → `working`
  - an extension says blocked (ask-user's pending question) → `blocked{question}`
  - `runFailure` → `error`
  - an answer the user hasn't seen → `done`
  - otherwise `idle`

  "Seen" is stored per thread, so every client agrees.
- **Asking the user** is the `ask-user` extension, not core. A restart re-asks the question (the tool is `replay: "safe"`).
- **Subagents and background jobs** are still to come, as an extension.
- **External agents** (Claude Code, Codex) in terminals report via OSC 7501, once a terminal extension exists.

---

## 4a. Threads

How a thread reads. One list of your turns, the agent's text and runs of work:

- **Markdown** for the agent's text (GFM: tables, task lists); links open in the browser.
- **Runs of work:** tool calls and thinking back to back, even across the agent's turns, fold into one row that says what was done: "Edited `src/dates.mjs` and ran a command +3 −1". Open while running, closed once the agent moves on.
- **Rows:** an icon on the text's edge, a verb ("Read", "Ran", "Edited", "Edit failed"), what it acted on in mono. Chevrons hang in the gutter and show on hover.
- **Output** is capped at a dozen lines ("Show all N lines"); edits show their diff with old and new line numbers; code never wraps, it scrolls and fades only while a line overflows.
- **Turns:** your messages are tinted bubbles with clear air above; a turn that did work ends with what it did ("5 steps · +3 −1"). The title is the first message's first sentence or clause; the bubble shows the rest.

Styled over eight rounds of impartial review of the showcase screenshots (scores 5.75 → 6.75 of 10, flat for the last rounds as reviewers began contradicting each other). Pacing is the weakest point left.

## 5. What a new app gets

- **`superego new <dir> [--minimal]`** copies `examples/full` or `examples/minimal`. Every name comes from `AppConfig`: data dir, socket, command, env prefix, menu bar glyph. `@superego/*` links to this checkout until the packages are published.
- **The shell:**
  - a macOS look: system colours, the system blue, real push buttons, pop-up selects
  - threads that read well (§4a)
  - Settings: app, machines, every machine's own, "All machines"
  - the ⌘K palette
  - menu bar and Dock
  - the restart notice
  - single instance; quits on SIGTERM (only the ⌘Q item keeps it in the menu bar)
  - notifications
- **Icons:** the app's `resources/`: `trayTemplate.png` (+ @2x) for the menu bar, `superego.icon` (Icon Composer) for the app, with `icon.png` for the Dock when run from source. Without them, the glyph is drawn as text.
- **The command:** `<id>`, plus threads, machines, settings, auth and the daemon, each with `-m <machine>` and `--json`.
- **Actions:** one router for keys, palette, buttons, extensions and `superego do`, with a log, and shortcuts editable in Settings → Keyboard.
- **Tests:** a smoke test that runs headless, and `pnpm showcase <dir>`: scripted threads with real tool calls on a fixture project, screenshotted top, middle and end in light and dark (and expanded), with `SUPEREGO_SMOKE_SHOTS=<dir>` for the smoke test's own screenshots.

---

## 6. Milestones

| # | Deliverable | Status |
|---|---|---|
| M0–M2 | Daemon, protocol, Electron shell; agents outlive the app | done |
| M3 | Extensions (both halves), slots; sidebar out of core | done (build-time) |
| M4 | Machines: ssh / via, identity, stale state | done; needs a real second machine and remote install |
| M5 | Asking the user, blocked status, end-to-end smoke | done (ask-user) |
| M6 | Framework: AppConfig, @superego/app, examples, `superego new` | done |
| M7 | Focus look, palette, sidebar modes, Base UI kit | done |
| M8 | New thread dialog | done |
| M9 | Actions: router, log, `superego do`, editable shortcuts | done, with `superego mcp` |
| M10 | macOS look; threads (markdown, runs, diffs); showcase; icons | done |
| M11 | Packaging: a signed `superego.app` with the `.icon` and its variants | done (the command inside it to come) |
| M12 | Profiles: trust, UI (JSX), daemon extensions, panes; web and phone | done |
| M13 | Sessions → threads → panes; worktrees; Fut's navigation; Tremolo's focus; the editor; attachments | done |

---

## 7. Decisions

1. **Own protocol, own TS daemon.** We never wait on or adapt to anyone else's roadmap (no `hc`, no fut protocol). We borrow their ideas.
2. **Electron, not Tauri.** Tauri's wins are bundle size and idle memory, because it uses the system webview. Rendering isn't faster, and WebKitGTK on Linux is slower. Its Rust backend would still need a Node sidecar for pi-durable, and extension authors would have to test three engines instead of Chromium. The daemon is UI-independent, so the shell stays swappable.
3. **Terminals wait** until after the PoC, as a bundled extension.
4. **Chord:** delta ops only (`applyImmutable` in the renderer), not the facet/plugin system.
5. **A framework with a generator**, Rails-style: apps depend on Superego's packages; extensions are packages any app imports.
6. **Base UI** for the kit's overlays: portals, positioning, focus and Escape done right, instead of hand-rolled.

Still open:
- **Remote install.** A machine runs a checkout installed by `scripts/install-machine.sh`, and Update (or `superego machines update`) runs that again over ssh. `superego daemon install` keeps the daemon alive as a systemd user unit (with lingering) or a launchd agent, and `hello` reports `keepsRunning`. ssh rides a shared ControlMaster, and a failed login (read from ssh's stderr only when ssh itself exited 255) is the `needs-login` state, fixed with `machines login`. Later: install over ssh without a checkout.
- **The service's lifecycle.** The unit and agent bring the daemon back after a crash or a restart, not after a stop: `Restart=on-failure` with `RestartForceExitStatus=75`, and `KeepAlive` with `SuccessfulExit=false`; a restart under a service exits 75, so `daemon stop` stays stopped (the next `connect --start` starts it). A daemon handing over to a service it doesn't run under starts the service, or spawns its successor when that fails. The service starts the successor with the unit's environment only, so the restart's own (and what earlier ones carried) is left in `restart-env.json` (0600) for it to take when it starts. Such a daemon has no `SSH_AUTH_SOCK` unless the service manager gives it one (macOS's launchd does; on Linux, a desktop session's agent usually is imported into the user manager), or a restart carried one: its links to other machines that need the agent show "needs login", and `superego machines login <machine>` on that computer leaves a master they ride without one.
- **Name and package scope.** `@superego/*` for now; publishing decides it.

## 8. Progress

- **M0 done.** pnpm workspace with `packages/{protocol,daemon,ui}` and `app/`. `pnpm typecheck` is green.
- **M1 done.** Daemon plus JSON-RPC/NDJSON protocol, thread catalog, derived OSC 7501 status, watches as snapshot + Chord ops, `superego` CLI (`daemon | connect [--start] | ls | new | send`). `pnpm test` runs vitest over the real socket with the scripted (`SUPEREGO_MODEL=faux`) model, including a restart.
- **M2 done.** Electron app with a machine `Link` (connects, says hello, relays, reconnects with backoff, keeps stale state), a detached daemon run as `ELECTRON_RUN_AS_NODE`, a sidebar with status glyphs, a streaming transcript with tool calls, and a composer (Enter sends, steers while busy, Esc stops). `pnpm --filter @superego/app smoke` is a headless two-process e2e: chat, quit, reopen, reattach.
- **Settings done (2026-11-03).** `@superego/settings` is a registry of typed sections, used by both the daemon (per-machine settings) and the Electron app (per-app settings, endpoint id `app`), over the same `settings.watch/set` methods. All model and auth handling lives in `packages/daemon/src/agent-settings.ts`:
  - the Model section: model, thinking, fast mode
  - the Providers section: API key, OpenAI sign-in, sign-out, with credentials in `<dataDir>/auth.json`
  - sign-in flows streamed over `auth.*`, so they work for remote machines too

  The app's own settings are interface font and notifications. Tremolo's permissions setting waits for a permission system. Its menu-bar setting is moot here: the daemon always outlives the app. The settings UI is drawn generically, plus custom section components keyed by `ui`. That is the seed of extensions' settings API.
- **Fonts and machines done (2026-11-03).** A generic `font` setting type, with a picker that lists installed families through the Local Font Access API. Interface and monospace fonts can be set separately.

  Settings → Machines manages SSH machines (stored in `machines.json` in the app's data dir). Each machine becomes a link over `ssh -T <target> <command>`, so the connection side of M4 is in place. What M4 still needs: a real second machine with Superego installed, and remote install.
- **Borrowed from T3 Code, and the `superego` CLI.** Feature flags in `hello`; a stable machine id (refusing a different machine at a known route, or one machine reached twice); record and replay of model turns; "All machines" bulk settings edit; machines reached through any stdio command (`via`).

  `packages/client` is shared by app and CLI: transports, `machines.json`, the identity check. `superego` (`packages/cli`, linked with `pnpm link:cli`) starts a thread in the current directory and opens it in the app, which runs as a single instance per data dir. It also covers threads, machines, settings, auth and the daemon, each with `-m <machine>` and `--json`.
- **Framework (2026-11-04).** Superego became a framework with a generator, Rails-style. `AppConfig` names everything per app. `@superego/app` is the app layer, there are two examples (`minimal`, `full`), and `superego new` copies one into a new project linked to this checkout.

  Extensions are packages with `./daemon` and `./ui` halves, imported at build time; runtime-installed extensions are later. First bundled: `threads` (sidebar) and `ask-user`.
- **Focus look, palette, sidebar modes (2026-11-04).** Explored in `design-explorations/` (main window, then the threads sidebar's modes).

  Built:
  - D's look as `@superego/ui` tokens: a floating composer that slots can take over (`useComposerClaim`)
  - UI-half settings and the `thread.aside` slot
  - thread facts: model, cost, last activity
  - the ⌘K palette
  - the sidebar's sort, rail and details modes

  The kit's overlays are on Base UI.

- **Actions (2026-11-04).** Every intent in the window, the app and the daemons is a schema'd action through one router; keys, palette, buttons, extensions and the CLI (`superego actions`, `superego do`) all dispatch, and the action log shows each with its source. Shortcuts are data (`app.keys`) with a Keyboard settings section that records keys and flags clashes. Details in §3a.
- **macOS look (2026-11-04).** System colours and the system blue, darker separators, tinted sidebars; every button a real push button (ghost buttons gone, one primary per view), pop-up selects, inset fields. The app quits on SIGTERM.
- **Threads (2026-11-04).** §4a. Markdown, runs of work, diffs and capped output, turn ends, a centred composer; the showcase harness to look at them.
- **Icons (2026-11-05).** A glyph in the menu bar (a template image macOS tints) and `superego.icon` as the app icon, kept in the app's `resources/` (the source lives in the repo's `resources/`).
- **New thread dialog (2026-11-04).** It opens from ⌘N, the palette, the sidebar's + and minimal's New. It sets a prompt, a project folder (recent folders, Browse… on this computer), the machine, the model and thinking, and a name. A thread's own model and thinking win over the machine's default on every turn. The daemon refuses a missing folder or an unknown model.

- **Profiles (2026-11-05–06).** Profiles with trust, JSX, daemon extensions and panes; the obsidian profile as proof.
- **Types for profile authors (2026-11-15).** Declarations built from the SDK's sources into the app and `~/.superego/types`; a profile's `tsconfig.json` and `node_modules` link from `profile new` and `profile types` (§3b).
- **Web and phone (2026-11-05).** Web access, the browser bridge, the phone layout, a PWA.
- **Panes and the editor (2026-11-06–09).** Panes kept with a thread; built-ins (changes, editor, preview, artifact, thread); the editor's live preview, autosave and file watch; files in a thread clickable; the `files` extension.
- **Sessions, threads, panes (2026-11-09).** The rename (a conversation is a thread), sessions, worktrees on request, Fut's navigation, the scrolling pane row, Tremolo's focus, attachments, the window's state kept across reloads, tests that stay off the screen.
- **Superego and Ego (2026-11-11).** The app, formerly mu, is Superego all the way down: the app, its id (`~/.superego`, `superego.sock`, the `superego` command, `SUPEREGO_*` variables, `superego/<slug>` branches, `.superego/profiles`), the packages (`@superego/*`, profiles import from `'superego'`), the window's bridge (`window.superego`), and the `--superego-*` tokens and `superego-*` classes. Its own agent is Ego: `AppConfig.agent` names it, for the ⌘K action, the rail and its prompt.
- **The halo icon (2026-11-11).** The first icon, a serif letter, gives way to a tilted halo over a dot: `resources/superego.icon` (halo and head layers), copied to `app/resources/superego.icon`, with the Dock, `.icns`, PWA and menu bar images made from it. The menu bar's halo is drawn heavier (`resources/superego-menubar.svg`) to hold at 16px; `resources/ego.svg` is Ego's mark, the dot alone. Explorations in `design-explorations/superego-*.html`.
- **MCP server from actions (2026-11-15).** `superego mcp` (§3a): opt-in exposure, one server per machine, and a test that drives it with an MCP client against a real daemon.
- **One daemon reaches the others (2026-11-12).** The daemon as a hub (§2): its own links to `machines.json`, `machines.watch`, `relay.call` and `relay.event`; every machine in a browser; agents start, read and message threads on other machines. The app and CLI name their computer in `hello`.

## 9. Next

- **Packaging, the rest** (M11): shipping the `superego` command inside the app, and a packaged app that doesn't share `~/.superego` with a development one.
- **Web and mobile:** accounts and TLS, a service worker, native shells as wrappers.
- **MCP, more:** watches as resources (a thread's transcript, the thread list); more actions exposed as they prove safe.
- **More bundled extensions:** git/diff, background jobs and subagents, suggestions.
- **A terminal pane**, with a bridge per platform: libghostty on desktop and mobile, something simpler on the web.
- **The code, support and readonly profiles**, as further proofs of profiles.
- **Publishing the packages**, so new apps don't need this checkout; then runtime-installed extensions.
- **Remote install** over ssh, without a checkout there.
