# Native macOS shell spike

## Verdict

**Go for a macOS replacement project; not ready to replace Electron yet.** The size hypothesis holds: a standalone,
ad-hoc-signed AppKit + system WKWebView app, compiled Bun daemon and locally bundled renderer is **94.90 MB / 42.14 MB
zipped** (90.50 / 40.19 MiB). Against the investigation's approximate Electron 260/125 MB baseline, that is about
64% less installed and 66% less downloaded. No Electron, Node installation, source checkout or node_modules is needed
to run the built app. Electron remains unchanged and available alongside it.

Amp's ~26 MB bundle is not a realistic target with this architecture: it loads remote web code and uses system
JavaScriptCore, whereas our daemon still needs Bun (~90 MB including code). Getting substantially below this needs
a different daemon runtime or a remote-only client. This spike proves local chat, not desktop feature parity.

## Reproduce (macOS, Bun and Swift command-line tools)

```sh
pnpm install --frozen-lockfile
bash app/native/build.sh
node app/native/smoke.ts
```

Output: `app/dist/Superego Native.app` and `app/dist/Superego-Native.zip` (ignored build artifacts).
The smoke creates a fresh temporary `SUPEREGO_HOME`, uses faux/replay models, sets an isolated agents folder, and never
orders a window, activates the application, posts notifications or shows a Dock icon. Logs and `webkit.png` remain in
the printed temporary directory. Do not point the spike at an existing production home. Both shell and daemon require
an explicit `SUPEREGO_HOME`; the spike intentionally has no implicit launch against real user data.

Normal interactive launch is supported by the executable, but **was not exercised**: all checks here were hidden.

## Architecture chosen

Use the existing web bridge, not a second implementation of `SuperegoBridge` in Swift. Bundle the renderer locally,
serve it from the compiled daemon on `127.0.0.1` with an OS-assigned port, and load its token-bearing URL in WKWebView.
The existing bridge takes the token out of the URL and speaks the normal JSON-RPC WebSocket protocol. No app resources
come from a remote website. The same React components, subscriptions, composer and sidebar work unmodified.

`app/native/daemon.ts` is a separate entry using the real daemon, bundled extensions and machine store. It publishes a
mode-0600 `native-endpoint.json` with PID and URL; Swift finds a running instance or launches the compiled binary via
`nohup`, with stdin ignored and stdout/stderr redirected to the isolated home. It does not terminate that daemon when
the app exits. Smoke verifies this by connecting over the socket after the shell process has exited.

The Swift shell is AppKit + WKWebView compiled by `swiftc`, with no Xcode project or third-party native framework.
The only script-message handler is **headless test logging**, not a privileged application bridge. A hidden NSWindow
hosts the view; the test uses DOM interaction and a WebKit snapshot. Production native capabilities should be a small,
origin-checked bridge supplementing the shared web implementation rather than another entire RPC client in Swift.

One shared change: `serveWeb` now returns the actual bound port, allowing port 0. Existing fixed-port callers continue
to receive their configured port. Web access in the normal daemon is still opt-in; the spike has its own loopback
listener and entry point, rather than changing that setting.

## Bun compatibility findings

* Node's `node:module.registerHooks` is unavailable. Import the module as a namespace and select the implementation at
  runtime. Node retains its loader hook; Bun uses `Bun.plugin` **runtime `build.module('superego', …)`** with object
  exports. Tried `onResolve`/`onLoad` first: they did not resolve a bare runtime import on Bun 1.4.4. Virtual modules did.
* Compiled Bun dynamically imports the user's TypeScript profile from outside the executable and supplies the real SDK.
  Tested a profile importing `defineProfile` from `superego`; confirmed its prompt in the thread's durable agent document.
* Real socket protocol, faux model streaming, `node:sqlite` storage, persistence across daemon restarts, and the built-in
  `bash` tool spawning a real shell all passed. Tool verification uses a replay model issuing a tool call and checks the
  file the child wrote. No stubbed loader, tool, SQLite adapter or daemon was used.
* Built directly from the native source entry with `bun build --compile --minify`; Bun bundles the 636 modules. The
  renderer is a normal electron-vite build, but only its static output is copied into the native app.
* Not established: real provider auth/OAuth, every provider SDK, project profile trust/reload and transitive extension
  reload under Bun, profile UI compilation, attachments, remote transports, durable recovery mid-tool, daemon restart
  action and cross-architecture builds. Existing Node tests passing is not proof of these paths under Bun.

## Verified behavior and exact results

Host: Apple Silicon, macOS 27.2.1 (26B131); Bun 1.4.4; Node 26.13.0 for the independent socket client.

* `bash app/native/build.sh`: exit 0; Swift compilation, Bun compilation, ad-hoc signing and ZIP generation pass.
  Vite reports existing ineffective dynamic-import warnings (React/UI modules).
* `node app/native/smoke.ts`: exit 0, including native shell startup of the daemon and daemon survival after shell exit.
  Creates a profile, creates and messages a thread over the Unix socket with the Node client, verifies profile prompt,
  stops/reopens the daemon to check SQLite, runs a replayed real bash child, then opens the hidden WebKit UI, clicks the
  seeded sidebar thread, types into the actual React composer and presses Enter. Observed **4 `watch.ops` events** and
  rendered `echo: Native WebKit message`, independently checked again over the socket after the shell exits.
  Post-refactor artifacts: `/var/folders/3b/746_pb8955dcdfq0zl1pnk4c0000gn/T/superego-native-Asg4oX`.
* `pnpm typecheck`: exit 0. The normal workspace checks do not include `app/native/`; those entries are exercised by
  Bun/Swift compilation and the Node smoke script, not claimed as TypeScript typechecked by this command.
* Post-refactor `pnpm test`: exit 0, **24 files / 99 tests passed**, 18.26 s.
  First cold run was 23 files passed / 1 failed, 97 tests passed / 2 failed: CLI JSON received a `Downloading…` prefix,
  plus the CLI restart test missed the expected API-key auth source. The unchanged rerun passed both. No test expectation
  or auth implementation was modified to make this green.

Early UI attempts timed out; the successful test requests an offscreen snapshot after navigation and uses the sidebar's
actual `role="option"` rows (not buttons). Hidden web views can throttle JS timers, so wait loops must be bounded and
fail visibly. No manual keyboard or interactive rendering validation was performed. Enter dispatch through the DOM
works; this does **not** prove native Cmd-key routing, IME behavior, focus, drag regions, fonts or all CSS match Chromium.

## Size breakdown

Final build; decimal MB uses 1,000,000 bytes. Logical file sizes and allocated `du -sk` are both recorded:

| Component | Logical bytes | Allocated KiB |
| --- | ---: | ---: |
| Compiled Bun daemon (runtime + all daemon code) | 89,971,408 | 87,864 |
| Swift shell | 98,320 | 100 |
| Resources (renderer + headless smoke script) | 4,792,804 | 4,912 |
| Entire signed .app (includes metadata/signature) | 94,898,884 | 92,916 |
| ZIP (`ditto -c -k --keepParent`) | 42,140,930 | 42,024 |

Installed allocation is approximately 95.1 MB. ZIP sizes vary slightly with code signatures and timestamps. This is an
arm64 development build, not universal, notarized or a release installer. No icons, updater or bundled CLI yet; these
must be included in a release comparison. No memory/performance claim follows from the bundle-size result.

## Electron responsibility inventory

Estimates are engineering days for an initial implementation, excluding release QA. None appears intrinsically
impossible on macOS. The heavy work is maintaining shared behavior, not drawing a native window.

| Responsibility | Native/shared destination | Spike status / estimate |
| --- | --- | --- |
| Windows and lifetime | NSWindow + WKWebView, app delegate | One window, hidden test works; multi-window/restore 1–2d |
| Application menu | NSMenu, normal Edit responder chain | Missing; 1d including copy/paste/undo and Cmd-Q |
| Tray/menu bar | NSStatusItem + NSMenu | Missing; 1–2d |
| Notifications | UNUserNotificationCenter; daemon status subscriptions | Missing; 1–2d plus permissions/deep links; never exercised on screen |
| Folder picker | NSOpenPanel via restricted bridge | Missing; 0.5–1d; existing web mode intentionally disables it |
| Message boxes | NSAlert sheet via restricted bridge | Missing; 0.5d |
| Dock hiding/icon | Activation policy + NSApp.applicationIconImage, bundle icon | Headless prohibited policy implemented; settings/icon 0.5–1d |
| Single-instance lock | Per-home lock + local IPC for open-thread requests | Missing; 1–2d. PID endpoint lookup is not a race-safe lock |
| Artifact protocol | Existing daemon `/artifact` HTTP path, sandbox CSP | Web bridge builds URL, but spike entry does not wire artifact callback; 1–2d including security tests |
| Key forwarding (`app.keys`/`app.key`) | Shared renderer shortcuts plus NSMenu/performKeyEquivalent | Browser settings/DOM Enter work; OS-reserved keys, custom menus, IME need 2–3d QA/implementation |
| SSH / machine links | Reuse `@superego/client` in Bun gateway; multiplex to browser bridge | Not implemented, local-only bridge; 3–5d + real SSH tests, avoid rewriting transports in Swift |
| App settings | Shared settings registry, daemon-backed client-settings endpoint | Browser localStorage only; 1–2d to restore shared per-home settings |
| Daemon restart service | Bun supervisor/relaunch using executable path + renderer restart state | Not wired by spike entry; 2–3d including failure/recovery and update coordination |
| CLI using Electron as Node | Add CLI mode to the same compiled Bun executable | Not shipped; 1–2d. Socket client is proven, packaged CLI behavior isn't |
| External links/navigation | WKNavigationDelegate policy + NSWorkspace.open | Missing; 1d. Restrict app navigation to the trusted loopback origin |

## Remaining blockers / next work

1. Production lifecycle: race-safe per-home singleton, endpoint liveness handshake instead of PID alone, stale endpoint
   handling, parallel launch/update coordination, explicit daemon restart. `nohup` survival is proven; it is not a complete
   supervisor or a replacement for single-instance IPC. A manual binary has no automatic launch environment/PATH setup.
2. Settings currently live in a browser origin keyed by the ephemeral port. Restarting the daemon changes the origin
   and loses that apparent settings/selection store. Move client settings to a per-home service or choose a stable
   origin before shipping. Don't paper over this with migrations in this pre-release app.
3. Restore remote machines and desktop actions; retain one bridge contract with native capabilities, don't fork the UI.
4. WebKit audit: actual OS keyboard commands and Edit menu, CodeMirror editing/IME, Base UI popovers, drag/drop,
   clipboard/images, local fonts (Chromium Local Font Access is not portable), file/preview/artifact sandbox behavior.
   Electron's `-webkit-app-region` draggable titlebar has no automatic AppKit equivalent. None blocked the tested chat.
5. Threat-model the always-on loopback gateway, token-bearing endpoint, WebSocket Origin policy, artifact isolation and
   future privileged message handlers. Restrict navigation before adding native permissions. No token is logged by the
   spike daemon; the endpoint file contains it and must remain private.
6. Release work: CLI mode, icon, signed/notarized binaries, hardened-runtime/Bun executable-memory entitlements tested
   under distribution signing, update strategy, Intel build if supported. Ad-hoc codesigning here is not that proof.

Recommended next slice: make a production-quality local shell (settings origin, singleton, menu/Edit/keys, artifact
security, restart) with headless parity tests, then the Bun multi-machine gateway. Keep Electron as the reference until
real-provider and editing tests pass. The measurable size saving is large enough to justify that work, but not enough
to skip these desktop behaviors.
