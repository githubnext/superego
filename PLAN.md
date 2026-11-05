# mu — plan

> One app for running agents: a desktop app, a daemon per machine, and the same window in a browser or on a phone. What an agent *is* comes from profiles: files in `~/.mu` or inside a project's own `.mu`, so a repo carries the harness it needs.

## The pivot (2026-11-05)

mu was a framework with a generator (`mu new`, each app its own build). That is tagged `pre-embedded`. Now:

- **One app** (`app/`): the desktop app, its daemon and the `mu` command. No generator, no per-app builds.
- **Profiles** (§3b): `profile.ts` (`defineProfile` from `'mu'`) in `~/.mu/profiles/<name>` or `<repo>/.mu/profiles/<name>`, with a model, a prompt, agent extensions (tools, prompt sections, hooks) and UI extensions. A session takes its folder's profile when it starts; a project's profile runs only once allowed.
- **Web and phone** (§3c): a machine's daemon serves the same window to browsers (Web access), over a WebSocket guarded by a token; narrow windows get a phone layout, and it installs as a PWA.
- Packaging the one app (`pnpm --filter mu package`) is set up and waits on installing electron-builder.

Principle 6 below (no network listener) gave way: Web access is a network listener, off by default, with a token. Real auth (accounts, TLS) is still to come.

Research sources: `~/dev/fut`, `~/dev/wt`, `~/dev/gh/tremolo`, pi-mono (`~/.cache/checkouts/github.com/badlogic/pi-mono`, v1.5.0), herdr / herdr-core / herdr-app (`~/.cache/checkouts/github.com/herdrdev/*`), pi-pocket, durable-pi.

---

## 0. Does Herdr already do this?

Partly. **herdr-core (`hc`)** already ships the runtime half:
- headless terminals that persist (PTY holder → restartable core → clients)
- machines over SSH or a `--via` command
- OSC 7501 status
- parent/child agents
- an OpenRPC JSON-RPC API

**herdr-app** is not mu:

| | herdr-app | mu |
|---|---|---|
| UI | Native GPUI. Mods are QuickJS describing native widgets; the docs explicitly say no HTML/CSS/webview. | Electron, so extensions are arbitrary web UI. |
| Agent | None. It hosts external CLI agents, and core refuses vendor logic. | Built in: pi-durable, with hooks and activity. |
| Unit of work | A terminal (PTY). | An agent session (durable conversation). Terminals are optional. |
| Extensibility | Agent-written recipes + JS mods; no versioned API. | Pi-style typed extension API, versioned. |

The niche is real. We should borrow herdr-core's protocol hygiene wholesale, and keep "use `hc` as the terminal substrate" as an option (see §7).

---

## 1. Principles

1. **The core is a runtime plus a shell, not a product.** Sidebar, bench, terminals, diff view: all extensions, some bundled. Use herdr's gate: *"if it only makes sense with a particular layout, it's not core."*
2. **Headless daemon, UI as client.** Closing the window never stops an agent. Learned in tremolo, fut and herdr alike.
3. **One method table** generates dispatch, the CLI, the TS client and the schema, with a frozen-contract test (herdr-core).
4. **State, not events.** Clients render durable state and subscribe to snapshot + ops (pi-durable 1.5 removed `watchEvents` for this reason; durable-pi broke on it).
5. **Status is a protocol.** Use the OSC 7501 vocabulary (`idle|working|done|blocked{permission|question|auth}|error`) end to end, so mu agents, Claude Code, Codex and pi all look the same.
6. **SSH does auth.** No network listener. A remote machine is `ssh host mu connect` speaking the same protocol over stdio (fut, hc).
7. **No hard-coded agent topology.** tremolo's coordinator/worker split was a regret.

---

## 2. Architecture

```
┌──────────── Electron app (one per laptop) ────────────┐
│ renderer: Shell (layout slots) + extension UI modules │
│        ▲ MessagePort / contextBridge `mu.call/on`     │
│ main:  connection manager → N machine links           │
└───────┬─────────────────────────────┬─────────────────┘
        │ unix socket                 │ ssh -T host mu connect (stdio)
┌───────▼─────────┐          ┌────────▼─────────┐
│ mu daemon (local)│          │ mu daemon (box)  │   Node, per user per machine
│  • pi-durable    │          │  same            │   ELECTRON_RUN_AS_NODE locally,
│    Harness+SQLite│          │                  │   plain `node` remotely
│  • session catalog          │                  │
│  • daemon-side extensions   │                  │
│  • docs (CAS key/value)     │                  │
│  • [pty host — optional]    │                  │
└──────────────────┘          └──────────────────┘
```

**Daemon** (`@mu/daemon`, plain Node/TS):
- owns one pi-durable `Harness` on node SQLite (one storage per daemon; durable allows a single writer)
- owns the session catalog, the extension host and the doc store
- exposes JSON-RPC 2.0 over NDJSON on a mode-0600 unix socket; `mu connect` bridges stdio to it
- streaming uses notifications on subscription ids for v0; herdr-style framed channels later, if terminals need them

**Electron main:** thin. Window management, machine catalog (`~/.mu/machines.json`: `{id,label,target,enabled}`), spawning ssh links, and relaying one generic `call/on` (no hand-maintained channel lists; that was a tremolo regret). Each machine link reconnects with backoff, and a disconnected machine stays visible but stale (fut).

**Renderer:** React 19, plain CSS on `@mu/ui` tokens, Base UI for overlays, electron-vite. The shell provides slots, the session view, Settings, the ⌘K palette and extensions' commands.

### Protocol surface (as built)

```
hello {client, version, features}         → {version, features, machine{id, build, …}, methods}
session.list                              agent.models
session.watch {id}                        → snapshot + watch.ops (Chord delta ops)
sessions.watch                            → snapshot + sessions.changed (status, model, cost, activeAt)
settings.watch                            value.watch {key} → an extension's live value + value.changed
action.list / action.run {id, params, exposure} / action.log            unwatch {sub}

actions, each also served under its id:
session.create / submit / abort / rename / seen     settings.set
auth.login / respond / cancel / logout              daemon.restart
<extension>.<name>                                  an extension's own
```

Reads and streams (`*.list`, `*.watch`) stay plain methods. Everything that changes something is an action (§3a).

Not built from the sketch: `fork`, `archive`, `doc.*`, a heartbeat/missed protocol. The current list is in `docs/structure.html`.

### Entities

```
Machine → Session (= pi-durable conversation + cwd + title + labels)
                └─ child sessions (subagents; die with parent unless detached)
Docs: opaque, per machine, versioned (layout, extension state)
```

Workspaces, tabs and splits are **not** daemon concepts. They live in a doc owned by the UI or an extension (herdr-app does the same).

---

## 3. Extension API

As built (2026-11-04). An extension is a package with up to two halves, imported by an app at **build time**: `<pkg>/daemon` (listed in the app's `src/daemon.ts`) and `<pkg>/ui` (listed in `src/renderer/main.tsx`). Runtime-installed and user extensions come later. The current shape is in `docs/structure.html`.

**Daemon half** (`defineDaemonExtension`):
- `mu.agent(ext)`: pi-durable tools, prompt sections, hooks, tasks
- `mu.settings`: register settings sections
- `mu.action(defineAction({ id: '<name>.<m>', params, run }))`: what clients can do (§3a)
- `mu.value(key, initial)`: live values, watched with `value.watch`
- `mu.status(fn)`: mark a session blocked
- `mu.harness`, `mu.sessions`
- Each one announces `ext:<name>` in `hello`.

**UI half** (`defineUiExtension`):
- Slots: `sidebar`, `session.header`, `composer.above`, `session.aside`
- `mu.tool(name, C)` and `mu.entry(kind, C)`: transcript renderers
- `mu.settings(ui, C)`: custom settings sections
- `mu.appSettings(section)`: the UI half's own settings, kept by the app
- `mu.action(defineAction({ id, title, keys, run }))`: window actions, for keys and the ⌘K palette; `mu.dispatch` runs any action
- Hooks: `useMachines`, `useSessions`, `useSelection`, `useSessionView`, `useValue`, `useAppSetting`, `useComposerClaim`, `useDispatch`, `useShortcut`, `call`, `has`.

**Kit:** `@mu/ui` (Base UI underneath for dialog, menu, popover and tooltip) and its tokens.

**Trust:** in-process, like pi. A sandboxed tier comes later, for agent-written UI.

**Bundled extensions:**
- `threads`: the sidebar, with sort, rail and details modes
- `ask-user`: a tool, the blocked status, and the question in the composer

**Layout:** for now, the shell's slots. A layout tree for arbitrary panels is still open (§9).

## 3a. Actions

Every intent is an action: an id, a title, a params schema (pi-schema), where it runs (`window`, `app` or `machine`), who may call it (`expose`: `ui`, `cli`, later `mcp`), a default shortcut, and whether it acts on the selected session. One `Router` (in `@mu/protocol`) validates and coerces params, runs the action and logs it.

- **The window** has its own router. `dispatch(id, params)` runs window actions there, forwards app actions to the main process and machine actions to the right machine (`machine` option, else the selection's), filling in the session from the selection. Keys, the palette, buttons and extensions all dispatch.
- **The log:** every dispatch with its source (`keys`, `palette`, `cli`, `composer`, an extension) and timing. *Show action log* in the window; `action.log` per machine; `mu actions log`.
- **The command line:** `mu actions` lists what a machine takes, `mu do <id> --param value…` runs one (values coerced to the schema, or `--params <json>`).
- **Shortcuts are data.** The setting `app.keys` holds only the user's changes by action id (`null`: none). Settings → Keyboard lists every action that runs without more input, records new shortcuts, and marks clashes; the first registered wins a clash. Plain keys without ⌘/⌃/⌥ are refused so typing stays typing.
- **Not a store.** Streams (sessions, transcripts, settings, values) stay on watches; actions are intents only. Snapshots and the log make debugging output easy without one global state.

**MCP (planned, not built):** a `mu mcp` server generated from the actions exposed to `mcp`: each becomes a tool with its schema, run through `action.run` with `exposure: 'mcp'`, so it lands in the same log. Watches could become resources. Open: which actions an outside agent may run by default, and per-machine routing (a `machine` param on every tool, or one server per machine).

---

## 3b. Profiles

- **Where:** `~/.mu/profiles/<name>/profile.ts` (yours) and `<repo>/.mu/profiles/<name>/profile.ts` (the project's; the nearest `.mu/profiles` at or above a session's folder). A project's replaces yours of the same name, unless it `extends: 'user:<name>'`.
- **What:** `defineProfile({ description, model, thinking, prompt, extensions, ui, without, extends })`. `extensions` are agent extensions (pi-durable `defineExtension`: tools, prompt sections, hooks); `ui` are UI extensions (`defineUiExtension`); `without` drops built-ins (`coding-tools`, `ask-user`).
- **'mu':** profiles and their extensions `import … from 'mu'` (the daemon's SDK, through a loader hook: nothing to install) and `'mu/ui'` (the window's hooks and components, `h` for elements; JSX isn't compiled yet).
- **Sessions:** a session takes the folder's `default` (or a named) profile when it starts, and keeps it. Each turn selects that profile's extensions and instructions in the one harness (pi-durable selects extensions per conversation); a session without a profile gets the built-ins. Edits reload from the next turn.
- **Trust:** a project's profile is that repo's code: it runs only once allowed (`mu profile allow`, or Allow and start in the app), and again after any of its files change.
- **UI:** the daemon serves a profile's UI modules (types stripped, only once allowed); the window rewrites their imports to its own React and `mu/ui` and installs them for that profile's sessions only.
- **The command:** `mu profile` (list), `mu profile new [name] [--user]`, `mu profile allow [name]`, `-P <profile>` when starting.
- Not yet: profile extensions with actions, values or settings; JSX in UI extensions; a profile's UI in the sidebar.

## 3c. Web and phone

- **Web access** (a machine setting: off, to this computer, to the local network; a port): the daemon serves the window's build over HTTP and the protocol over a WebSocket at `/rpc`, guarded by a token in its data dir. Settings shows the address with the token.
- **In a browser** the window has no preload: `window.mu` is a WebSocket bridge to that daemon (the one machine, "local"); app settings live in the browser; machines and folder picking are desktop-only.
- **Phones:** under 760px wide, one column: a bar with the sessions in a drawer, the composer at the bottom, full-screen dialogs. A web manifest and icons for the home screen.
- Not yet: accounts and TLS (put it behind Tailscale or a proxy for now), a service worker for offline, the desktop app as a wrapper of a remote daemon's web UI.

## 4. Agent and activity

- One agent runtime: pi-durable 1.5 with `CodingTools` and pi-ai models. Credentials are mu's own (`<dataDir>/auth.json`), managed in Settings.
- **Derived status** per session, from `pi.live` plus extension contributions:
  - `run` present → `working`
  - an extension says blocked (ask-user's pending question) → `blocked{question}`
  - `runFailure` → `error`
  - an answer the user hasn't seen → `done`
  - otherwise `idle`

  "Seen" is stored per session, so every client agrees.
- **Asking the user** is the `ask-user` extension, not core. A restart re-asks the question (the tool is `replay: "safe"`).
- **Subagents and background jobs** are still to come, as an extension.
- **External agents** (Claude Code, Codex) in terminals report via OSC 7501, once a terminal extension exists.

---

## 4a. Threads

How a session reads. One list of your turns, the agent's text and runs of work:

- **Markdown** for the agent's text (GFM: tables, task lists); links open in the browser.
- **Runs of work:** tool calls and thinking back to back, even across the agent's turns, fold into one row that says what was done: "Edited `src/dates.mjs` and ran a command +3 −1". Open while running, closed once the agent moves on.
- **Rows:** an icon on the text's edge, a verb ("Read", "Ran", "Edited", "Edit failed"), what it acted on in mono. Chevrons hang in the gutter and show on hover.
- **Output** is capped at a dozen lines ("Show all N lines"); edits show their diff with old and new line numbers; code never wraps, it scrolls and fades only while a line overflows.
- **Turns:** your messages are tinted bubbles with clear air above; a turn that did work ends with what it did ("5 steps · +3 −1"). The title is the first message's first sentence or clause; the bubble shows the rest.

Styled over eight rounds of impartial review of the showcase screenshots (scores 5.75 → 6.75 of 10, flat for the last rounds as reviewers began contradicting each other). Pacing is the weakest point left.

## 5. What a new app gets

- **`mu new <dir> [--minimal]`** copies `examples/full` or `examples/minimal`. Every name comes from `AppConfig`: data dir, socket, command, env prefix, menu bar glyph. `@mu/*` links to this checkout until the packages are published.
- **The shell:**
  - a macOS look: system colours, the system blue, real push buttons, pop-up selects
  - threads that read well (§4a)
  - Settings: app, machines, every machine's own, "All machines"
  - the ⌘K palette
  - menu bar and Dock
  - the restart notice
  - single instance; quits on SIGTERM (only the ⌘Q item keeps it in the menu bar)
  - notifications
- **Icons:** the app's `resources/`: `trayTemplate.png` (+ @2x) for the menu bar, `mu.icon` (Icon Composer) for the app, with `icon.png` for the Dock when run from source. Without them, the glyph is drawn as text.
- **The command:** `<id>`, plus sessions, machines, settings, auth and the daemon, each with `-m <machine>` and `--json`.
- **Actions:** one router for keys, palette, buttons, extensions and `mu do`, with a log, and shortcuts editable in Settings → Keyboard.
- **Tests:** a smoke test that runs headless, and `pnpm showcase <dir>`: scripted threads with real tool calls on a fixture project, screenshotted top, middle and end in light and dark (and expanded), with `MU_SMOKE_SHOTS=<dir>` for the smoke test's own screenshots.

---

## 6. Milestones

| # | Deliverable | Status |
|---|---|---|
| M0–M2 | Daemon, protocol, Electron shell; agents outlive the app | done |
| M3 | Extensions (both halves), slots; sidebar out of core | done (build-time) |
| M4 | Machines: ssh / via, identity, stale state | done; needs a real second machine and remote install |
| M5 | Asking the user, blocked status, end-to-end smoke | done (ask-user) |
| M6 | Framework: AppConfig, @mu/app, examples, `mu new` | done |
| M7 | Focus look, palette, sidebar modes, Base UI kit | done |
| M8 | New session dialog | done |
| M9 | Actions: router, log, `mu do`, editable shortcuts | done; MCP planned |
| M10 | macOS look; threads (markdown, runs, diffs); showcase; icons | done |
| M11 | Packaging: a signed `mu.app` with the `.icon` and its variants | in progress |

---

## 7. Decisions

1. **Own protocol, own TS daemon.** We never wait on or adapt to anyone else's roadmap (no `hc`, no fut protocol). We borrow their ideas.
2. **Electron, not Tauri.** Tauri's wins are bundle size and idle memory, because it uses the system webview. Rendering isn't faster, and WebKitGTK on Linux is slower. Its Rust backend would still need a Node sidecar for pi-durable, and extension authors would have to test three engines instead of Chromium. The daemon is UI-independent, so the shell stays swappable.
3. **Terminals wait** until after the PoC, as a bundled extension.
4. **Chord:** delta ops only (`applyImmutable` in the renderer), not the facet/plugin system.
5. **A framework with a generator**, Rails-style: apps depend on mu's packages; extensions are packages any app imports.
6. **Base UI** for the kit's overlays: portals, positioning, focus and Escape done right, instead of hand-rolled.

Still open:
- **Remote install.** v0 expects `node` and mu on the remote PATH. Later: self-install over ssh.
- **Name and package scope.** `@mu/*` for now; publishing decides it.

## 8. Progress

- **M0 done.** pnpm workspace with `packages/{protocol,daemon,ui}` and `app/`. `pnpm typecheck` is green.
- **M1 done.** Daemon plus JSON-RPC/NDJSON protocol, session catalog, derived OSC 7501 status, watches as snapshot + Chord ops, `mu` CLI (`daemon | connect [--start] | ls | new | send`). `pnpm test` runs vitest over the real socket with the scripted (`MU_MODEL=faux`) model, including a restart.
- **M2 done.** Electron app with a machine `Link` (connects, says hello, relays, reconnects with backoff, keeps stale state), a detached daemon run as `ELECTRON_RUN_AS_NODE`, a sidebar with status glyphs, a streaming transcript with tool calls, and a composer (Enter sends, steers while busy, Esc stops). `pnpm --filter @mu/app smoke` is a headless two-process e2e: chat, quit, reopen, reattach.
- **Settings done (2026-11-03).** `@mu/settings` is a registry of typed sections, used by both the daemon (per-machine settings) and the Electron app (per-app settings, endpoint id `app`), over the same `settings.watch/set` methods. All model and auth handling lives in `packages/daemon/src/agent-settings.ts`:
  - the Model section: model, thinking, fast mode
  - the Providers section: API key, OpenAI sign-in, sign-out, with credentials in `<dataDir>/auth.json`
  - sign-in flows streamed over `auth.*`, so they work for remote machines too

  The app's own settings are interface font and notifications. Tremolo's permissions setting waits for a permission system. Its menu-bar setting is moot here: the daemon always outlives the app. The settings UI is drawn generically, plus custom section components keyed by `ui`. That is the seed of extensions' settings API.
- **Fonts and machines done (2026-11-03).** A generic `font` setting type, with a picker that lists installed families through the Local Font Access API. Interface and monospace fonts can be set separately.

  Settings → Machines manages SSH machines (stored in `machines.json` in the app's data dir). Each machine becomes a link over `ssh -T <target> <command>`, so the connection side of M4 is in place. What M4 still needs: a real second machine with mu installed, and remote install.
- **Borrowed from T3 Code, and the `mu` CLI.** Feature flags in `hello`; a stable machine id (refusing a different machine at a known route, or one machine reached twice); record and replay of model turns; "All machines" bulk settings edit; machines reached through any stdio command (`via`).

  `packages/client` is shared by app and CLI: transports, `machines.json`, the identity check. `mu` (`packages/cli`, linked with `pnpm link:cli`) starts a session in the current directory and opens it in the app, which runs as a single instance per data dir. It also covers sessions, machines, settings, auth and the daemon, each with `-m <machine>` and `--json`.
- **Framework (2026-11-04).** mu became a framework with a generator, Rails-style. `AppConfig` names everything per app. `@mu/app` is the app layer, there are two examples (`minimal`, `full`), and `mu new` copies one into a new project linked to this checkout.

  Extensions are packages with `./daemon` and `./ui` halves, imported at build time; runtime-installed extensions are later. First bundled: `threads` (sidebar) and `ask-user`.
- **Focus look, palette, sidebar modes (2026-11-04).** Explored in `design-explorations/` (main window, then the threads sidebar's modes).

  Built:
  - D's look as `@mu/ui` tokens: a floating composer that slots can take over (`useComposerClaim`)
  - UI-half settings and the `session.aside` slot
  - session facts: model, cost, last activity
  - the ⌘K palette
  - the sidebar's sort, rail and details modes

  The kit's overlays are on Base UI.

- **Actions (2026-11-04).** Every intent in the window, the app and the daemons is a schema'd action through one router; keys, palette, buttons, extensions and the CLI (`mu actions`, `mu do`) all dispatch, and the action log shows each with its source. Shortcuts are data (`app.keys`) with a Keyboard settings section that records keys and flags clashes. Details in §3a.
- **macOS look (2026-11-04).** System colours and the system blue, darker separators, tinted sidebars; every button a real push button (ghost buttons gone, one primary per view), pop-up selects, inset fields. The app quits on SIGTERM.
- **Threads (2026-11-04).** §4a. Markdown, runs of work, diffs and capped output, turn ends, a centred composer; the showcase harness to look at them.
- **Icons (2026-11-05).** The µ in the menu bar (a template image macOS tints) and `mu.icon` as the app icon, kept in the app's `resources/` (the source lives in the repo's `resources/`).
- **New session dialog (2026-11-04).** It opens from ⌘N, the palette, the sidebar's + and minimal's New. It sets a prompt, a project folder (recent folders, Browse… on this computer), the machine, the model and thinking, and a name. A session's own model and thinking win over the machine's default on every turn. The daemon refuses a missing folder or an unknown model.

## 9. Next

- **Packaging** (M11): electron-builder; everything bundled into `out/` so the app needs no `node_modules`; `mu.icon` compiled into the bundle so macOS draws its light, dark, tinted and clear variants; the `mu` command shipped inside the app.
- **Web and mobile (direction):** the daemon on the network (WebSocket, token auth), a browser bridge with app state moved into the daemon, a PWA served by the daemon, a responsive shell; Electron and native shells as wrappers. Then extensions that own data and the main view, so apps that aren't agent sessions (notes, say) can be built on mu.
- **MCP server from actions** (§3a): designed, not built.
- **More bundled extensions:** git/diff, background jobs and subagents, suggestions.
- **A layout tree for panels**, beyond fixed slots.
- **Publishing the packages**, so new apps don't need this checkout; then runtime-installed extensions.
- **Remote install** over ssh.
