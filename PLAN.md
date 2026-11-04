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

**Renderer:** React 19, Tailwind 4, shadcn/base-ui (tremolo stack, electron-vite). The shell provides only layout slots, the command palette, the action/keymap registry (port tremolo `src/actions`, `keymap`, `focus`) and the extension loader.

### Protocol surface (v0)

```
hello {client, caps}                      → {version, methods, features, machine}
session.list / create {cwd, title?} / fork / archive
session.watch {id, window}                → snapshot + ops   (wraps conversation.watch)
session.submit {id, text, requestId, whenBusy}
session.abort {id}
session.answer {id, promptId, value}      ← durable "ask the user" primitive (see §4)
status.watch                              → per-session derived status, rollup per machine
doc.get / doc.set {key, value, ifVersion} / doc.watch
ext.list / ext.call {ext, method, params} / ext.reload
events.subscribe                          → snapshot + seq + heartbeat + missed{snapshot}
```

### Entities

```
Machine → Session (= pi-durable conversation + cwd + title + labels)
                └─ child sessions (subagents; die with parent unless detached)
Docs: opaque, per machine, versioned (layout, extension state)
```

Workspaces, tabs and splits are **not** daemon concepts. They live in a doc owned by the UI or an extension (herdr-app does the same).

---

## 3. Extension API

pi-style: trusted TypeScript, loaded with jiti, hot-reloaded. One package, two sides; the shape is proven by pi-pocket's `(host, web)` split.

```
~/.mu/extensions/<name>/        (and <project>/.mu/extensions/ once trusted)
  package.json   { "mu": { "api": 1, "daemon": "daemon.ts", "ui": "ui.tsx" } }
  daemon.ts      export default (mu: DaemonAPI) => void
  ui.tsx         export default (mu: UIAPI) => void
```

**`DaemonAPI`**: pi-durable's `Extension` plus what pi's CLI host adds.
- `mu.agent(ext: Extension)`: tools, sections, hooks (`beforeRequest`, `beforeTool`/`afterTool`, `afterRun`…), wraps, tasks, docs. Passed straight through to Durable.
- `mu.on('session_start' | 'session_end' | 'status' | 'input' | 'model_select' …)`: lifecycle derived from `pi.live` transitions.
- `mu.method(name, schema, handler)`: RPC that the extension's UI side calls via `ext.call`.
- `mu.registerProvider`, `mu.settings(schema)`, `mu.ask(sessionId, prompt)` → Promise (durable).
- `mu.exec`, and later `mu.env(machine)`, which is pi-env's `RemoteExecutionEnv`.

**`UIAPI`**: browser equivalents of pi's TUI hooks, plus panels.

| pi TUI | mu UI |
|---|---|
| `setStatus`, `setWidget` | `mu.slot('statusbar' \| 'composer.above' \| 'sidebar' \| 'topbar', key, Component)` |
| `setHeader`, `setFooter` | slot replacement |
| `custom(..., {overlay})` | `mu.overlay(Component) → Promise<T>` |
| `select`, `confirm`, `input` | `mu.dialog.*` |
| `notify` | `mu.toast` |
| `setEditorComponent`, autocomplete | `mu.composer.replace / decorate / complete` |
| `registerMessageRenderer`, `renderCall`/`renderResult` | `mu.render.entry(kind, C)`, `mu.render.tool(name, C)` (fed by Durable's `details` channel) |
| `registerCommand`, `registerShortcut` | `mu.command(id, {title, run})` and `mu.keys` (go through the action registry) |
| — | `mu.panel(id, {title, Component})`: a full surface, placeable by the layout |
| — | `mu.client`: typed `call/on` to the daemon (any machine), `ext.call` to its own daemon side |

The UI side gets React plus `@mu/ui` (a shadcn-derived kit: Button, Input, List, Panel, Tabs, Dialog, Markdown, CodeBlock, StatusGlyph, Composer, Transcript).

**Trust:** in-process and trusted, like pi. A sandboxed-iframe tier (tremolo's `bench-frame.html` pattern) comes later for agent-authored or untrusted panels.

**Where extensions live:** daemon sides run on the machine they're installed on; UI sides load from the client machine. A remote daemon advertises its extensions in `ext.list`, and if the client lacks the UI half, its panels show "not installed here". That's good enough for v0.

### Layout

The core ships a **layout tree** primitive borrowed from herdr-app: `row | column | stack | block{panel, props}`, persisted in a doc, with `resizable`, `size`, `hidden`. The default layout and the sidebar are **bundled extensions** built on it, which proves the API is enough. The bench (tremolo) is an extension too: an agent-writable panel in a doc, with a sandboxed figure.

---

## 4. Agent and activity

- One agent runtime: pi-durable 1.5 with `CodingTools`, pi-ai models and auth (reuse `~/.pi/agent/auth.json` via pi-coding-agent's model registry, as pi-pocket does).
- **Derived status** per session, computed from `docs["pi.live"]` plus mu's pending prompts:
  - `run` present → `working`
  - a pending `mu.ask` → `blocked{question|permission}`
  - `runFailure` → `error`
  - run ended with the result unseen → `done`
  - otherwise `idle`

  Attention/seen revisions are shared across clients (fut's read revision).
- **Durable "ask the user"** (`mu.ask`), because Durable has no blocked state and both reference apps had to invent one. It's a durable task waiting on `session.answer`, which survives restarts and is shown on every client.
- **Subagents:** `mu.spawn(childSession)` with die-with-parent, and child status changes delivered as a note into the parent (herdr's `notes.rs`, with a "can it take it" guard).
- **External agents** (Claude Code, Codex) in terminals report via OSC 7501. That needs the pty extension and is post-v0.

---

## 5. Proof of concept: scope

**In:**
1. The daemon: Harness + SQLite, the session catalog, the protocol above, and `mu connect` (stdio).
2. Electron: one window, the machine catalog (local + ssh), generic relay, reconnect + stale state.
3. Shell: layout tree, slots, command palette, action/keymap registry, extension loader with hot reload.
4. `@mu/ui`: about 10 components.
5. Bundled extensions written **only** against the public API:
   - `sessions-sidebar`: machines → sessions with status glyphs
   - `chat`: transcript + composer, with tool renderers
   - `status-bar`
6. Example third-party extension, `todo`: an agent tool, a renderer and a sidebar panel. It proves both halves.
7. A headless e2e smoke test with a real model (a tremolo lesson).

**Out (next):** terminals/pty (or hc), bench, diff/changes view, iframe sandbox tier, MCP server for outside agents, `mu` CLI beyond `connect`/`daemon`, extension package manager, worktrees (wt integration via hooks), mobile/web client.

---

## 6. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Repo skeleton: pnpm workspace with `packages/{protocol,daemon,ui,sdk}`, `app/` (electron-vite), `extensions/*` | builds, lint/typecheck green |
| M1 | Daemon + protocol + Node test client: create session, submit, watch ops, status | vitest against a real Harness in MemoryStorage |
| M2 | Electron shell talking to the local daemon; chat as a hard-coded panel | can chat; quit app → agent keeps running → reopen and reattach |
| M3 | Extension loader (both sides) + slots + layout tree; move chat and sidebar into extensions | sidebar and chat contain no core imports beyond `@mu/sdk` |
| M4 | Machines: `ssh host mu connect`, federation, stale state | sessions on two machines in one sidebar |
| M5 | `mu.ask` + derived status + `todo` example + e2e smoke | blocked/working/done visible across a restart |

---

## 7. Decisions

1. **Own protocol, own TS daemon.** We never wait on or adapt to anyone else's roadmap (no `hc`, no fut protocol). We borrow their ideas.
2. **Electron, not Tauri.** Tauri's wins are bundle size and idle memory, because it uses the system webview. Rendering isn't faster, and WebKitGTK on Linux is slower. Its Rust backend would still need a Node sidecar for pi-durable, and extension authors would have to test three engines instead of Chromium. The daemon is UI-independent, so the shell stays swappable.
3. **Terminals wait** until after the PoC, as a bundled extension.
4. **Chord:** delta ops only (`applyImmutable` in the renderer), not the facet/plugin system.

Still open:
- **Remote install.** v0 expects `node` and mu on the remote PATH. Later: self-install over ssh.
- **Name and package scope.** `@mu/*` for now.
- **Extension placement.** Daemon side per machine, UI side per client; revisit at M3.

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
- **Next:**
  - more bundled extensions: git/diff, background jobs and subagents, suggestions
  - a layout tree for panels
  - publishing the packages, so new apps don't need the checkout
