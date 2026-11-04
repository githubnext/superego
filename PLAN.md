# mu — plan v0

> An Electron version of pi: a sturdy, bare-bones core with an agent, sessions across machines, and an extension API that lets you turn it into whatever a browser can show.

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
session.list / create {cwd, title?} / rename / submit / abort / seen
session.watch {id}                        → snapshot + watch.ops (Chord delta ops)
sessions.watch                            → snapshot + sessions.changed (status, model, cost, activeAt)
settings.watch / settings.set             auth.login / respond / cancel / logout
value.watch {key}                         → an extension's live value + value.changed
<extension>.<method>                      an extension's own methods
daemon.restart {build, interrupt?}        unwatch {sub}
```

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
- `mu.method('<name>.<m>', fn)`: methods for clients
- `mu.value(key, initial)`: live values, watched with `value.watch`
- `mu.status(fn)`: mark a session blocked
- `mu.harness`, `mu.sessions`
- Each one announces `ext:<name>` in `hello`.

**UI half** (`defineUiExtension`):
- Slots: `sidebar`, `session.header`, `composer.above`, `session.aside`
- `mu.tool(name, C)` and `mu.entry(kind, C)`: transcript renderers
- `mu.settings(ui, C)`: custom settings sections
- `mu.appSettings(section)`: the UI half's own settings, kept by the app
- `mu.command({ id, title, keys, run })`: keys and the ⌘K palette
- Hooks: `useMachines`, `useSessions`, `useSelection`, `useSessionView`, `useValue`, `useAppSetting`, `useComposerClaim`, `call`, `has`.

**Kit:** `@mu/ui` (Base UI underneath for dialog, menu, popover and tooltip) and its tokens.

**Trust:** in-process, like pi. A sandboxed tier comes later, for agent-written UI.

**Bundled extensions:**
- `threads`: the sidebar, with sort, rail and details modes
- `ask-user`: a tool, the blocked status, and the question in the composer

**Layout:** for now, the shell's slots. A layout tree for arbitrary panels is still open (§9).

---

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

## 5. What a new app gets

- **`mu new <dir> [--minimal]`** copies `examples/full` or `examples/minimal`. Every name comes from `AppConfig`: data dir, socket, command, env prefix, menu bar glyph. `@mu/*` links to this checkout until the packages are published.
- **The shell:**
  - the focus look
  - Settings: app, machines, every machine's own, "All machines"
  - the ⌘K palette
  - menu bar and Dock
  - the restart notice
  - single instance
  - notifications
- **The command:** `<id>`, plus sessions, machines, settings, auth and the daemon, each with `-m <machine>` and `--json`.
- **Tests:** a smoke test that runs headless.

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
| M8 | New session dialog | in progress |

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

## 9. Next

- **New session dialog:** project, prompt, machine, model and thinking for that session.
- **More bundled extensions:** git/diff, background jobs and subagents, suggestions.
- **A layout tree for panels**, beyond fixed slots.
- **Publishing the packages**, so new apps don't need this checkout; then runtime-installed extensions.
- **Remote install** over ssh.
