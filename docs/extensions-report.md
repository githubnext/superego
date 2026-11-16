# How much of Superego could be extensions?

A report on the extension API as it stands, what of the core could move out into extensions, what the API would need
for that, and in what order. It's an investigation only: nothing here has been changed.

As read at `5218cf3` ("Number the suggestions over the composer"). References are `path:line` from the repository root,
at that commit. Ego was reworked right after it (`b142933`..`dd3a908`: one hidden thread that only reads), so the Ego
rows below describe it as it was; the extension points they ask for still apply. "The core" means `packages/{protocol,settings,daemon,client,cli,ui,app}` and `app/`.

---

## 0. Summary

**Numbers**

- Non-test TypeScript source: **~12.2k lines**, of which the six extensions are **~1.3k (11%)**.
- I went through **33 core features**. **9** could be extensions with today's API or one small addition, **10** could
  partly be, and **14** should stay in core (§2).
- Moving the 9 "yes" features and the movable parts of the 10 "partly" ones would take **~1.2–1.5k lines** out of the
  core, so roughly 20% of the source would be extensions. What's left in core would be the runtime and the shell.
- About **20 new extension points** are needed (§3). Ten of them are small (an export, a field, scoping something), and
  **six are structural**: thread lifecycle hooks, per-thread extension state, read and watch methods, a tool-row
  descriptor, composer providers, and link handlers.
- On top of those, **declared UI with configured placement** (§3b). Extensions declare views and the places
  each fits; the shell knows no extension; a layout setting decides what goes where, as `app.keys` does for shortcuts.
  About 2–3 weeks, with the user-facing core of it in one.

**Top recommendations**

1. **Fix the API's leaks first (Phase 0, ~1–2 days).** A profile's tool renderers, entry renderers and settings
   components aren't scoped to that profile and are never removed (`packages/app/src/renderer/extension.tsx:183-189`,
   `:161-171`). A profile's daemon settings aren't undone on reload, so the second load throws
   (`packages/daemon/src/daemon.ts:438`, `packages/settings/src/registry.ts:84-86`). Profile UI is keyed by folder path
   with no machine in the key (`extension.tsx:161`, `:234`). Every `useValue` and `useAppSetting` opens a watch of its
   own (`packages/app/src/renderer/client.ts:50-113`). Each of these gets worse with every extension added.
2. **Dogfood with a `git` (Changes) extension, then `skills`.** Changes is the cleanest candidate: one daemon method
   (`daemon.ts:914-922`), one pane (`panes.tsx:253-331`), one action (`actions.tsx:146-149`). Moving it forces the
   right small additions: pane icons, pane descriptions for the agent, and read methods. Skills then forces the two big
   ones: composer providers and submit transforms.
3. **Next, give the daemon half thread lifecycle hooks and per-thread state.** These are what let worktrees, Ego and
   thread tools leave `daemon.ts`. Today they're woven through `startThread`, `archive`, `agentOf` and `ThreadMeta`
   (`daemon.ts:39-61`, `:517-536`, `:633-662`, `:727-758`).
4. **Make placement configuration, not code (§3b).** Extensions declare views (a title, an icon, the context needed,
   the places they fit: space, aside, pane, header). The shell has places and no extension names. An `app.layout`
   setting puts views in places. That covers a new space in the rail, adding a view to the pane menu, and moving thread
   details between the aside and a pane, and it replaces the hand-rolled toggles in `threads` and `files`.

**The biggest API gaps**

- **Placement is hard-coded on both sides.** Extensions name the slot they go in (`threads/src/ui.tsx:41-44`). The
  shell names the features it knows: Ego's button and the Unread fallback in the rail (`Shell.tsx:116-123`). There's
  one sidebar and no spaces (`extension.tsx:13`), and the pane menu is a boolean (`extension.tsx:50`).

- **No thread lifecycle hooks or per-thread state on the daemon side.** An extension can't take part in creating,
  submitting, archiving or describing a thread, and can't add facts to `ThreadInfo`.
- **No read or watch methods.** Extensions read data through actions, which are logged and exposed
  (`extensions/files/src/daemon.ts:47-59`). Live values are global, held in memory and broadcast whole to every client
  (`daemon.ts:440-450`).
- **Built-in tool rendering is hard-coded** (`ThreadView.tsx:559-594`, `:626-707`). The only extension hook replaces a
  row wholesale (`extension.tsx:96`).
- **The composer is closed.** Skill completion, attachments and the suggestion keys are core code
  (`ThreadView.tsx:742-960`).
- **No link-scheme handlers.** `thread:` and file links are hard-coded in `Markdown.tsx:95-135`, and `links` scrapes
  the DOM to find them (`extensions/links/src/ui.tsx:36`).
- **Actions can't say when they apply, and can't reach state.** `WindowContext` is a closed type
  (`actions.tsx:16-35`). `threads` works around it with module globals that rendering sets
  (`extensions/threads/src/ui.tsx:25`, `:76`, `:99`).

---

## 1. The extension API as it stands

### 1.1 How extensions load

| | Bundled | A profile's |
|---|---|---|
| Daemon half | listed at build time in `app/src/daemon.ts:18` (`[askUser, files, tasks, suggestions]`), set up in order before interrupted work resumes (`daemon.ts:468`, resume at `:883`) | `profile.ts` `extensions: [...]`, loaded lazily when a thread with the profile first needs it (`daemon.ts:481-514`); torn down and set up again when the profile's files change |
| UI half | listed at build time in `app/src/renderer/main.tsx:10` (`[threads, askUser, files, tasks, suggestions, links]`) | `profile.ts` `ui: [...]`: TSX served by the daemon through sucrase (`profiles.ts:238-256`), imports rewritten to blob URLs (`profile-ui.ts:32-61`), installed when a thread with the profile is shown (`profile-ui.ts:76-88`) |
| Imports | `@superego/daemon`, `@superego/app/ui`, `@superego/protocol`, `@superego/ui`, pi-durable | `'superego'` (the SDK object, through a Node loader hook, `profiles.ts:165-187`), `'superego/ui'` (all of `renderer/index.tsx` plus the kit, `profile-ui.ts:15-18`), `react` |
| Feature flag | `ext:<name>` in `hello` (`daemon.ts:473`) | **none**: profile daemon halves don't appear in `features` |

The core registers its own UI through the same API: `mountApp` calls `createRegistry(app, extensions, core => …)`, and
the core half sets up the built-in panes, the core actions and three custom settings components
(`renderer/index.tsx:21-33`). That's a good sign. The UI API is already the core's own seam for panes, actions and
settings sections, so they can move out cheaply.

### 1.2 Daemon half: `DaemonApi` (`packages/daemon/src/extension.ts:28-53`, built in `daemon.ts:431-466`)

| Member | What it does | Notes |
|---|---|---|
| `name`, `title`, `description` | identity; title and description feed Settings → Extensions (`extension-settings.ts:20-30`) | name must match `^[a-z][a-z0-9-]*$` (`daemon.ts:432`); **duplicates aren't checked** |
| `setup(api)` → cleanup | runs once (bundled) or per profile load | an error undoes what was registered (`daemon.ts:458-463`) |
| `app` | `AppConfig` | |
| `harness` | the raw pi-durable `Harness` | an escape hatch, and therefore a versioning liability |
| `agent(ext)` | install a pi-durable extension: tools, prompt sections, hooks, wraps, tasks | bundled: becomes a built-in, switchable per machine (`daemon.ts:242-247`, `:468`); profile: renamed `<scope>:<name>/<ext>` (`daemon.ts:494-497`) |
| `settings` | the machine's **raw** `SettingsRegistry` | **not scoped and not undone on teardown** (`daemon.ts:438`). `register` throws on a duplicate id (`registry.ts:84-86`), so a profile that registers settings fails on its second load |
| `action(def)` | a machine action `<name>.<id>`, `runs: 'machine'` (`daemon.ts:440`) | the name prefix is enforced (`daemon.ts:426-429`) |
| `value(key, initial)` | a live value `<name>.<key>`, in memory; clients `value.watch` it (`daemon.ts:441-451`, `:983-991`) | global (not per thread), the whole value goes to every watcher on every change, nothing persists |
| `status(fn)` / `invalidate()` | contribute `blocked{kind,msg}` to a thread's derived status (`daemon.ts:413-419`, `:452-453`) | first contributor wins; blocked is the only kind of status an extension can add |
| `threads.list()` / `conversation(id)` / `of(convId)` | reach threads | **no `get(id)`**: `files` lists every thread to find one (`extensions/files/src/daemon.ts:51`); no meta, no create, no lifecycle |

What it doesn't have: read or watch methods, notifications, thread lifecycle hooks, a way to change a message as it's
submitted, per-thread state, facts added to `ThreadInfo`, HTTP routes on the web server, pane descriptions for the
agent, and a version.

### 1.3 UI half: `UiApi` (`packages/app/src/renderer/extension.tsx:92-122`)

| Member | What it does | Profile allowed? |
|---|---|---|
| `slot(name, C, {order})` | 8 slots (`extension.tsx:10-26`): `sidebar`, `rail`, `thread.header`, `composer.above`, `thread.aside`, `editor.side`, `editor.bar`, `overlay` | not `sidebar` or `rail` (`:178`) |
| `tool(name, C)` | replace a tool call's whole row in the transcript (`ThreadView.tsx:638-652`) | yes, but **global, last one wins, never removed** (`:183`) |
| `entry(kind, C)` | draw custom entries (`ThreadView.tsx:468-472`) | yes, but global as well (`:184`) |
| `work(divide)` | split a run of work into titled parts; the first divider to answer wins (`:241-249`) | no (`:186`) |
| `settings(ui, C)` | a component under a settings section that names `ui` (`SettingsView.tsx:55-71`) | yes, but global (`:189`) |
| `pane(kind, PaneKind)` | `{title, component, menu?, opens?, folders?, width?}` (`:47-58`) | yes, scoped to the profile (`:190-193`) |
| `action(WindowAction)` | window actions with `keys`, in the palette | no (`:196`) |
| `dispatch` | the window router (`actions.tsx:55-72`) | yes |
| `appSettings(section)` | per-user settings in General (`:200-206`, registered with main at `index.tsx:36`) | no (`:201`) |

Exports from `@superego/app/ui` (`renderer/index.tsx:46-67`): hooks (`useMachines`, `useAllThreads`, `useThreads`,
`useSelection`, `useSessions`, `useSidebar`, `useShell`, `useThreadView`, `useValue`, `useWatch`, `useSettings`,
`useAppSetting`, `useLocalState`, `useComposer`, `useComposerClaim`, `useDispatch`, `useShortcut`, `useActions`,
`useKeymap`), helpers (`call`, `has`, `machine`, `score`, `keyLabel`, `fileKind`, `showSession`, `groupSessions`,
`unread`), components (`Markdown`, `FileEditor`, `Slot`), and `livePreview`.

**Not exported, though panes need them:** `PaneHeader` and `useTabNote` (`panes.tsx:198-210`). Only the built-in panes
can put tools in a pane's header or a count on its tab (`DiffPane`, `panes.tsx:261`, `:269-272`).

### 1.4 What each extension uses

| | ask-user | files | links | suggestions | tasks | threads |
|---|---|---|---|---|---|---|
| **Daemon** `agent` (tools) | `ask_user` | | | hook `GenerationTask.beforeRequest/afterRun` | `task_start`, `task_finish`, section | |
| `action` | `ask-user.answer` | `files.list` (really a read) | | | | |
| `value` | `ask-user.pending` | | | `suggestions.next` | | |
| `status` / `invalidate` | ✓ | | | | | |
| `threads.*` | | `list` (to find one) | | `of`, `conversation` | | |
| harness `models` (through the hook api) | | | | ✓ side call | | |
| **UI** slots | `composer.above` | `editor.side`, `editor.bar`, `overlay` | `overlay` | `composer.above` | | `sidebar`, `rail`, `thread.aside`, `thread.header` |
| `tool` | `ask_user` | | | | | |
| `work` | | | | | `divide` | |
| `pane` | | `folder` | | | | |
| `action` (keys) | | `files.tree` ⌘⇧T, `files.open` ⌘P | `links.list` ⌃O | | | 7, incl. ⌘\\, ⌘I, ⌘⌥↑↓ |
| `appSettings` | | | | | | Sidebar section |
| Hooks | `useValue`, `useComposer`, `useComposerClaim`, `useDispatch`, `has` | `useSelection`, `useMachines`, `useAllThreads`, `useRegistry`, `fileKind`, `score` | `useSelection`, `score` | `useValue`, `useComposer` (`suggest`, `picked`, `fill`), `has` | | `useSessions`, `useSelection`, `useSidebar`, `useShell`, `useThreadView`, `useAppSetting`, `useLocalState`, `call`, `showSession` |
| Own state | | hand-rolled `localStorage` stores (`files/src/ui.tsx:18-33`) | module flag (`links/src/ui.tsx:10-13`) | | | module globals `current`, `step`, `unfolded` (`threads/src/ui.tsx:25`, `:64-66`, `:76`) |
| Leans on core internals | `dock__join` class | `palette__*` classes, `pane.open` | DOM scraping of `.transcript`, `md__file`, `md__pane-link` | composer keys built into core | `WorkPart` drawn by core `Task` | `thread.list {archived}`, `SORT` key defined in core |

### 1.5 Gaps and awkward spots

1. **Profile UI leaks across profiles.** `installProfile` clears slots and panes but not `tools`, `entries` or
   `settings` (`extension.tsx:161-171`). Those are one global `Map` where the last registration wins (`:183-189`), so a
   profile's `superego.tool('find_order', …)` draws that tool in every thread and outlives the profile's reload.
2. **Profile UI is keyed by folder, not machine and folder.** `registry.installProfile(profile.dir, …)`
   (`profile-ui.ts:72`), and the Slot filter compares `thread.profile.dir` (`extension.tsx:234`). Two machines with a
   profile at the same path (`~/.superego/profiles/default` is likely) overwrite each other's UI.
3. **Profile daemon settings break reloads.** `api.settings` is the raw registry (`daemon.ts:438`), so its sections
   aren't undone, and `register` throws on the second load (`registry.ts:84-86`). The skill says "Everything it
   registered is removed on reload, so register freely" (`packages/cli/skill/daemon.md`). That's true for actions,
   values and status, not for settings.
4. **Profile daemon halves have no feature flag** (`daemon.ts:473`), and their values only exist once the profile has
   loaded (`daemon.ts:481`). A profile UI calling `useValue` before then gets `not_found` (`daemon.ts:985`) and the
   watch logs an error (`client.ts:74`).
5. **Profile extensions aren't loaded before `harness.resume()`** (`daemon.ts:883`). Profiles load lazily in
   `agentOf`, `startThread` and `profile.ui` (`:518`, `:641`, `:926`). This needs checking: a run interrupted inside a
   profile tool could resume without its extension installed.
6. **Reads go through actions.** `files.list` is an action (`files/src/daemon.ts:47`), so every tree refresh is logged,
   shows in the palette's data and is exposed to the CLI. Core reads are plain methods (`file.read`, `thread.diff`,
   `skill.list`, `daemon.ts:904-922`), which extensions can't add.
7. **One watch per hook call.** `useWatch` doesn't share subscriptions (`client.ts:50-82`). `useAppSetting` opens a
   whole `settings.watch` on `app` each time it's called (`client.ts:109-113`). The `threads` sidebar alone calls it
   from `Threads` (3×), `ThreadsRail`, `ModelButton` and `Details`. `DetailsPane` opens a second `thread.watch` on the
   shown thread (`threads/src/ui.tsx:321`).
8. **Live values are all or nothing.** `suggestions.next` is a `Record<thread, …>` of every thread, sent whole on every
   change to every watcher (`suggestions/src/daemon.ts:13`, `:56`). `ask-user.pending` is the same (`ask-user/src/daemon.ts:18`).
9. **The agent is told only the built-in pane kinds.** The `pane_open` description is a hard-coded string
   (`daemon.ts:254-257`). Only profiles can add to it (`daemon.ts:532-534`). The `folder` pane that `files` adds
   (`files/src/ui.tsx:56`) is never described to the agent.
10. **Pane kinds have no icon.** The strip's icons are a core table (`panes.tsx:190-192`), and the file-name style is
    special-cased to `editor` and `artifact` (`panes.tsx:152`).
11. **Rendering tools means all or nothing.** Verbs, icons, the one-line summary and the run summary ("Read 2 files and
    ran a command") are tables in core that name core tools and the thread tools (`ThreadView.tsx:559-594`,
    `:626-636`, `:699-707`). `ToolCall` special-cases `thread_*` (`:658-668`).
12. **Actions have no `when`.** The palette lists every bare action (`Palette.tsx:27`). `files.open` opens a dialog that
    then renders nothing without a selection (`files/src/ui.tsx:177`). Nothing can say "only while a pane of kind X has
    the focus" either.
13. **Actions can't reach state.** `WindowContext` is a fixed type (`actions.tsx:16-35`), set by `Shell` on every render
    (`Shell.tsx:63-71`). `threads` keeps `current` and `step` as module globals that its components set while rendering
    (`threads/src/ui.tsx:25`, `:76`, `:82`, `:99`), so `threads.next` does nothing while the sidebar is hidden. The core
    also has its own `thread.next` (`actions.tsx:106`) doing much the same.
14. **Keys are global and first-registered wins** (`Shell.tsx:221-233`). Local key handling is ad hoc: ⌃1–⌃9 now means
    three things, each handled on its own. ask-user picks an option in the composer (`ask-user/src/question.ts:28-40`),
    links follows a link in its dialog (`links/src/ui.tsx:31`), and the core composer sends a suggestion through a
    window-wide listener added for the `suggestions` extension (`ThreadView.tsx:834-851`, using `ctrlDigit` from
    `shortcuts.ts:39`, which `@superego/app/ui` doesn't export). They don't collide today only because a claim hides
    the suggestions.
15. **Ownership is inverted.** The core defines and reads `threads.sort` (`sessions.ts:10`, `:64`), a key the `threads`
    extension registers (`threads/src/ui.tsx:34`). Settings → Extensions' core `threads` switch is the thread tools
    (`extension-settings.ts:14`), while the `threads` extension is the sidebar. One name means two things.
16. **No transcript access.** `links` reads the DOM (`links/src/ui.tsx:36`, `links.ts:30-42`), and `threads` re-parses
    entries for the details pane (`threads/src/ui.tsx:323-344`). There is no `useTranscript` or `useLinks`.
17. **No shared picker.** `files` quick open and `links` both copy the palette's markup and classes
    (`files/src/ui.tsx:204-221`, `links/src/ui.tsx:56-71`).
18. **Some doc comments are stray.** `extension.tsx:42-46` has a tool-call comment above `PaneProps` and two comments for
    `PaneKind`.
19. **Nothing for the narrow layout.** `thread.aside` and `rail` aren't drawn when narrow (`Shell.tsx:115`, `:146`), and
    extensions can't add to the mobile bar (`Shell.tsx:135-141`).
20. **No UI test harness.** Extension tests cover pure logic (`links.test.ts`, `groups.test.ts`, `divide.test.ts`) and
    daemon halves over a real socket (`ask-user/test/daemon.test.ts`). Nothing mounts a `UiExtension` against a
    registry; only the app's smoke test touches them (`app/test/smoke.mjs`).

---

## 2. Inventory of core features

Verdicts: **Yes**: could be an extension with today's API or a small addition. **Partly**: the visible half moves, but
a piece stays in core or needs a structural addition. **No**: it's the runtime or the shell itself.

| # | Feature | Where | Verdict | Why / what's missing |
|---|---|---|---|---|
| 1 | **Changes pane** (git diff), `thread.diff`, ⌘⇧D, the tab's +/− | `panes.tsx:243`, `:253-331`; `daemon.ts:914-922`; `actions.tsx:146-149` | **Yes** | A pane, an action and one read. Missing: a read method (§3 D3), a pane icon (U1), exported `PaneHeader` and `useTabNote` (U1), a pane description for the agent (D6). Would be `extensions/git`, which PLAN §9 already wants ("git/diff") |
| 2 | **Preview pane** (web page) and "open in a pane" beside links | `panes.tsx:245`, `:349-359`; `ThreadView.tsx:196-201`; `Markdown.tsx:117-123` | **Yes** | The pane moves as is. Opening links in a pane is core (`OpenUrl`), which needs link handlers (U5) |
| 3 | **Artifact pane** | `panes.tsx:246`, `:362-375`; main `superego-artifact:` protocol `start.ts:486-500`; web route `web.ts:40-43`, `daemon.ts:1050` | **Partly** | The pane moves. The sandboxed origin is served by the Electron main process and the daemon's HTTP server, and neither has an extension seam (D8) |
| 4 | **Editor pane** | `panes.tsx:244`, `:337-346`; `FileEditor` `file-editor.tsx`; `file.read`, `file.write`, `file.watch` | **Partly** | The pane registration could go to `files`. `FileEditor` stays a core library (profiles use it), and `file.*` stay core methods |
| 5 | **Thread pane** (another thread beside) | `panes.tsx:247`, `:378-386` | **Yes** | Ten lines over the exported `ThreadBody`. Belongs with #6 |
| 6 | **Thread tools** (`thread_start`, `thread_read`, `thread_send`, `thread_list`), their rows, `thread:` links, `ThreadRef`, the "from" chip | `thread-tools.ts` (115 lines); `daemon.ts:271-287`; `ThreadView.tsx:585-588`, `:626-668`, `:699-702`; `Markdown.tsx:96`, `:131`; `thread-ref.tsx`; `ThreadView.tsx:141` | **Yes** | Missing: a way for a daemon extension to start threads (`threads.create`, D1), tool-row descriptors (U2), link handlers (U5). A daemon half for `extensions/threads` |
| 7 | **Skills**: prompt section, `skill.list`, `$name` expansion, composer completion, the skill chip on sent messages | `skills.ts` (113); `daemon.ts:268`, `:557-568`, `:912`; `ThreadView.tsx:774-815`, `:914-924`, `:375-387`; `skill-names.ts` | **Yes** | The section works today. Missing: a submit transform (D2), a read method (D3), composer completion providers (U3), message chips (U3). Stays switchable through `without: ['skills']` |
| 8 | **AGENTS.md** | `daemon.ts:269`, `skills.ts:95-113` | **Yes** | One prompt section. Moves today, with `skills` or alone |
| 9 | **Worktrees**: create, archive removes a clean one, unarchive restores it, the branch chip, the dialog's checkbox, `worktree:` in profiles | `daemon.ts:47-48`, `:644-660`, `:727-758`; `ThreadView.tsx:142`; `NewThread.tsx` | **Partly** | Needs lifecycle hooks: choose the cwd at create, act on archive and unarchive (D1), per-thread state and a `ThreadInfo` fact (D4), a field in the New thread dialog (U8). The profile key `worktree` would become extension options |
| 10 | **Ego** (the meta agent): tools, prompt, `thread.meta`, `app.meta`, the rail button | `meta.ts` (133); `daemon.ts:410-411`, `:521-526`, `:681-693`; `actions.tsx:123-129`; `Shell.tsx:118-120` | **Partly** | The tools, prompt and button move. Missing: a thread kind that picks its own agent (the `meta` flag and `agentOf` override, D5), and a sanctioned way to reach the router (it uses `router` directly, `meta.ts:66`) |
| 11 | **Web access**: HTTP and WebSocket server, token, settings section, address UI | `web.ts` (105); `daemon.ts:1034-1083`; `SettingsView.tsx:166-183` | **Partly** | The server and settings could be a daemon extension with HTTP routes and a `serve(peer)` hook (D8). The browser bridge (`web-bridge.ts`, `token-gate.ts`) is a client transport and stays core |
| 12 | **Attachments** | `daemon.ts:568-598`; composer `ThreadView.tsx:760-770`, `:898-908`, `:932-938`; `attachments.ts` | **Partly** | The protocol (`Attachment` in `thread.send`) stays. Saving files and inlining text could be a submit transform (D2), the composer's attach button a composer provider (U3). Low value: keep it in core for now |
| 13 | **Unread** button and ⌘. | `Unread.tsx`; `Shell.tsx:121`, `:131`; `actions.tsx:110`, `:205-215`; `index.tsx:25-30` | **Yes** | It already falls back to the `rail` slot. Moving it needs the action to read `sessions` (U6) |
| 14 | **Action log** dialog | `actions.tsx:144`, `:246-269`; `Shell.tsx:154` | **Yes** | An overlay and an action. Needs read access to the window router's log (U6) |
| 15 | **Notifications** (done, failed, needs you) | `start.ts:207-222`; `app-settings.ts:35-41` | **Partly** | They run in the Electron main process, which has no extension API. A renderer `onThreadStatus` hook with the Notification API, plus a main-side "focused?" check, would do (U9) |
| 16 | **Title-bar facts**: cost, branch, profile, "from" | `ThreadView.tsx:136-158` | **Yes** | `thread.header` exists; `threads` already puts the model there (`threads/src/ui.tsx:44`). Branch goes with #9, "from" with #6 |
| 17 | **Coding tools** and how their rows look | `daemon.ts:248`; `ThreadView.tsx:559-594`, `:626-636`, `:684-707`, `:709-740` | **Partly** | The agent side is pi-durable's `createCodingTools`. The rows (verbs, icons, summaries, diffs) could register as tool-row descriptors (U2), core using its own API. The diff renderer stays as a kit component |
| 18 | **Thread and session stepping** (⌘⇧[ ], `session.next`) | `actions.tsx:105-110`, `:177-215` | **Partly** | Duplicates `threads.next` and `threads.previous`. Order is the sidebar's, so it could belong to `threads` once actions can read sessions (U6) |
| 19 | **Command palette** ⌘K | `Palette.tsx` | **No** | The window's own. Extensions contribute through actions; add `when` (U6) and a shared Picker (U7) |
| 20 | **Navigator** ⌘L | `Navigator.tsx` | **No** | The shell's model (session → thread → pane). It already takes pane titles from kinds (`Navigator.tsx:44`) |
| 21 | **New thread dialog** | `NewThread.tsx` (201) | **No** | Core, but it needs fields extensions can add (worktree, a profile's own options) (U8) |
| 22 | **Settings shell**: generic rendering, General, Keyboard | `SettingsView.tsx`, `Keymap.tsx`, `merge-settings.ts` | **No** | Sections already plug in (daemon `settings.register`, UI `settings(ui, C)`, `appSettings`). Pages don't (U8) |
| 23 | **Machines** (links, list, settings page, trust) | `main/link.ts`, `client/machines.ts`, `start.ts:338-367`, `SettingsView.tsx:328-441` | **No** | Transport and identity |
| 24 | **Providers, sign-in, model and thinking** | `agent-settings.ts` (305), `SettingsView.tsx:216-326` | **No** | The harness's model registry is built from them (`daemon.ts:297-305`) |
| 25 | **Profiles and trust** | `profiles.ts`, `daemon.ts:476-536`, `profile-ui.ts` | **No** | They're the extension loader |
| 26 | **Pane row, strip, pane menu, `pane.*` actions** | `panes.tsx:29-235`; `daemon.ts:605-625`, `:760-810`; `ThreadView.tsx:963-978` | **No** | Layout and protocol |
| 27 | **Composer** (send, steer, queue, stop, claims, drafts) | `ThreadView.tsx:742-960` | **No** | Core, opened up through providers (U3) |
| 28 | **Transcript** (flatten, runs, tasks, turn ends) | `ThreadView.tsx:303-557` | **No** | Core, already extensible through `work`, `entry` and `tool` |
| 29 | **Focus, regions, scroll, pane stepping** | `focus.ts`, `scroll.ts`, `actions.tsx:111-121`, `:217-236` | **No** | The window's focus model |
| 30 | **Restart and service notice** | `restart.ts`, `ServiceNotice.tsx`, `daemon.ts:865-879` | **No** | Daemon lifecycle |
| 31 | **Menu bar, Dock, appearance** | `tray.ts`, `start.ts:284-330`, `app-settings.ts:17-58`, `Shell.tsx:184-208` | **No** | Electron main, no seam (and there needn't be one) |
| 32 | **Rename, archive, seen** | `daemon.ts:727-831`; `ThreadView.tsx:81-133` | **No** | Thread basics. Archive's worktree part moves with #9 |
| 33 | **Markdown and finding links** (`file.find`, `locate`) | `Markdown.tsx:87-153`; `daemon.ts:186-235`, `:913` | **Partly** | Rendering stays core. Schemes (`thread:`, `superego-file:`, bare paths) could be handlers (U5) |

The tallies: **Yes 9** (1, 2, 5, 6, 7, 8, 13, 14, 16), **Partly 10** (3, 4, 9, 10, 11, 12, 15, 17, 18, 33), **No 14**
(19–32).

### Where the "yes" and "partly" features would go

| Extension | Takes | Size moved (approx.) |
|---|---|---|
| `git` (new) | #1 Changes, later commit and branch actions | ~110 lines |
| `web-panes` (new), or added to `links` | #2 Preview, #3 Artifact (the panes only) | ~40 |
| `threads` (gets a daemon half) | #5, #6, #16's "from" chip, #18 | ~220 |
| `skills` (new) | #7, #8 | ~230 |
| `worktrees` (new) | #9, the branch chip | ~120 |
| `ego` (new) | #10 | ~180 |
| `web-access` (new) | #11's server and settings | ~170 |
| `unread` (new), or into `threads` | #13 | ~60 |
| `devtools` (new) | #14 action log | ~35 |
| `notifications` (new) | #15 | ~40 |
| core, through its own API | #17 rows as descriptors, #33 schemes as handlers | (stays, reorganised) |

---

## 3. What the API would need

Daemon-side points are **D1–D9**, UI-side **U1–U10**. Each has a TypeScript sketch, what it's for, and its size
(S: under a day, M: 1–3 days, L: about a week).

### D1. Thread lifecycle hooks (M), for worktrees, thread tools and Ego

Today `startThread`, `archive` and `unarchive` are closed functions (`daemon.ts:633-662`, `:727-758`).

```ts
type ThreadHooks = {
  /** Before a thread exists: may change where it works and add state. `want` is what the caller asked for (options it doesn't know are kept). */
  creating?(draft: { cwd: string; root: string; profile?: ProfileRef; title: string; prompt?: string; want: Record<string, Json> },
            ctx: { checkout?: { top: string; root: string } }): Promise<void | { cwd?: string; state?: Json }>
  created?(thread: ThreadInfo): void | Promise<void>
  /** May refuse ("uncommitted changes") or report what it did. */
  archiving?(thread: ThreadInfo, state: Json | undefined): Promise<void | { state?: Json; note?: string }>
  unarchiving?(thread: ThreadInfo, state: Json | undefined): Promise<void | { state?: Json }>
}
interface DaemonApi {
  thread(hooks: ThreadHooks): void
  threads: DaemonApi['threads'] & {
    get(id: string): Promise<ThreadInfo>                 // instead of list().find
    create(params: NewThread & { parent?: string }): Promise<ThreadInfo>   // thread_start without reaching into the daemon
    submit(id: string, text: string, whenBusy?: 'steer' | 'followUp'): Promise<void>
    lastAnswer(id: string): Promise<string | undefined>
  }
}
```

`NewThread` (`protocol/src/methods.ts:78`) would get `options?: Record<string, Json>`, so `worktree: true` becomes
`options: { worktrees: { enabled: true } }` and `superego -w` keeps working as a shorthand.

### D2. Submit transforms (S), for skills and attachments

Skill expansion and attachments are inlined in `submit` (`daemon.ts:548`, `:557-598`).

```ts
type Content = string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
interface DaemonApi {
  /** Runs in registration order on every message a thread is sent (not on tool results). Profiles' `without` skips it. */
  submit(transform: (message: { thread: ThreadInfo; text: string; content: Content; attachments: Attachment[] }) => Promise<Content | void>): void
}
```

### D3. Read and watch methods (M), for git, files, skills and anything a pane reads

```ts
interface DaemonApi {
  /** `<name>.<method>`: a plain request, not an action. Not logged, not in the palette, not exposed to MCP. */
  method<P, R extends Json>(name: string, schema: JsonSchema | undefined, run: (params: P, ctx: DaemonContext) => Promise<R>): void
  /** `<name>.<watch>`: a snapshot then deltas, served under `watch.ops` like `thread.watch`, ended by `unwatch`. */
  watch<P, T extends Json>(name: string, start: (params: P, emit: (next: T) => void) => { value: T; stop(): void } | Promise<…>): void
}
// UI
export function useMethod<R>(machine: string, method: string, params: unknown, deps?: unknown[]): { data?: R; error?: Error; reload(): void }
```

`files.list`, `thread.diff` and `skill.list` all become methods. The handler table is per connection
(`daemon.ts:894-1004`) and copies the router once at connect (`:1007-1009`), so registrations made later (by a
profile) must be looked up when a call comes in, as `action.run` already does.

### D4. Per-thread extension state and thread facts (M), for worktrees, Ego and anything that's "about a thread"

```ts
interface DaemonApi {
  /** State kept with the thread (a namespaced field of its ThreadDoc, so it persists, forks and archives with it). */
  state<T extends Json>(key: string): {
    get(thread: string): Promise<T | undefined>
    set(thread: string, next: T | undefined): Promise<void>
  }
  /** Facts every client sees in ThreadInfo.ext[<name>]: small, derived, recomputed on `invalidate()`. */
  facts(describe: (thread: string) => Json | undefined): void
  /** A live value per thread: `value.watch { key, thread }` sends only that thread's value. */
  threadValue<T extends Json>(key: string, initial: T): { get(thread: string): T; set(thread: string, next: T): void }
}
```

`ThreadInfo` (`protocol/src/methods.ts:23`) would get `ext?: Record<string, Json>`. `worktree`, `parent` and `meta`
would become facts of their extensions over time (keeping the old fields for one protocol feature version). That also
fixes gap 8: `suggestions.next` and `ask-user.pending` become per-thread values.

### D5. Agent selection (S), for Ego and any thread kind

`agentOf` hard-codes the `meta` branch (`daemon.ts:521-526`).

```ts
interface DaemonApi {
  /** Choose a thread's agent: the first answer wins over profile and settings. */
  agentFor(choose: (thread: { id: string; state: (ext: string) => Json | undefined; profile?: LoadedProfile }) =>
    { extensions?: 'builtins' | Extension[]; instructions?: string; model?: string } | undefined): void
}
```

### D6. Pane kinds described to the agent (S)

```ts
interface DaemonApi {
  /** Told to the agent in pane_open's description (and to Ego). The UI half registers the component under the same kind. */
  pane(kind: string, about: string): void
}
```

`pane_open`'s description (`daemon.ts:254-257`) is then built from the registered kinds plus the profile's `panes`
(`daemon.ts:532-534`), and `meta.ts:30` stops listing kinds by hand.

### D7. Scoped settings (S)

```ts
interface DaemonApi {
  settings: Pick<SettingsRegistry, 'get' | 'onChange'> & {
    /** Undone with the extension; ids and keys must start with `<name>.` */
    register(section: SectionSpec): void
  }
}
```

This fixes gap 3. Profile settings ("a profile's settings", PLAN §3b "Not yet") then come almost for free.

### D8. HTTP routes and connections (M), for web access and artifacts

```ts
interface DaemonApi {
  /** Under the daemon's web server, when one runs: `/x/<name>/…`. Token checked by core unless `public`. */
  route(path: string, handler: (req: IncomingMessage, res: ServerResponse) => void, options?: { public?: boolean }): void
  /** Serve the protocol to a peer this extension accepted (WebSocket, a pipe). */
  serve(peer: RpcPeer): () => void
}
```

The server itself (`web.ts`) could then move into a `web-access` extension, with core keeping only `serve(peer)`.
Artifacts need a desktop counterpart: the main process would ask the daemon for the bytes (it already does,
`start.ts:488`), so only the route registration moves.

### D9. A manifest and version (S)

```ts
type DaemonExtension = {
  name: string; title?: string; description?: string
  /** Bumped when its actions, values or methods change incompatibly; announced as ext:<name>@<version>. */
  version?: number
  setup(api: DaemonApi): …
}
```

`hello.features` gets `ext:<name>@<v>` for bundled and loaded profile extensions, and `has(machine, 'ext:x', minVersion)`
compares. Today skew is handled by hand: `ask-user` copes with old daemons sending string options
(`ask-user/src/ui.tsx:39-40`).

---

### U1. Pane kinds, completed (S)

```ts
type PaneKind = {
  title: string | ((pane: Pane) => string | undefined)
  component: ComponentType<PaneProps>
  icon?: ComponentType<{ size?: number }>        // replaces KIND_ICONS (panes.tsx:190)
  file?: boolean                                 // its title is a file name (panes.tsx:152)
  menu?: boolean; opens?: (path: string) => boolean; folders?: boolean; width?: number
}
export { PaneHeader, useTabNote } from './panes.tsx'   // panes.tsx:198-210
```

### U2. Tool-row descriptors (M), for coding tools, thread tools, and any extension's tools

Today an extension either replaces the row or gets `name` and JSON arguments (`ThreadView.tsx:684-689`).

```ts
type ToolRow = {
  icon?: ComponentType<{ size?: number; className?: string }>
  /** done, working, failed: "Read", "Reading", "Read failed". */
  verbs?: [done: string, working: string, failed: string]
  /** What it acted on, in a line (mono): a path, a command. Or a component (a thread ref). */
  subject?: (args: Record<string, unknown>, result?: ToolResult) => string | ReactNode
  /** In a run's summary: "read 2 files". `count` calls of it. */
  phrase?: (count: number, only?: string) => string
  /** Its weight when a run says what it mostly did (edit > bash > read today, ThreadView.tsx:559). */
  weight?: number
  /** What it opens to; default: its output, capped. */
  body?: ComponentType<ToolCallProps>
  /** +/− it contributes to the turn's stats. */
  stat?: (result?: ToolResult) => { added: number; removed: number } | undefined
}
interface UiApi { toolRow(name: string, row: ToolRow): void }   // `tool(name, C)` stays for full control
```

The core then registers `read`, `bash`, `edit` and `write` through `toolRow`, and `threads` registers `thread_*`.
`verbOf`, `ROW_ICONS`, `describe`'s switch and the `thread_*` branch of `ToolCall` all go.

### U3. Composer providers (M–L), for skills, attachments and suggestions

```ts
type CompletionProvider = {
  /** The word being completed at the caret: `$co`, `/skill:co`, `@src/a`. */
  trigger: RegExp | ((text: string, caret: number) => { start: number; query: string } | undefined)
  items(query: string, ctx: { machine: MachineEntry; thread: ThreadInfo }): Promise<{ label: string; detail?: string; insert: string }[]>
}
interface UiApi {
  composer: {
    complete(provider: CompletionProvider): void
    /** A button in the box's actions (attach), and a drop/paste handler. */
    button(C: ComponentType<{ machine: MachineEntry; thread: ThreadInfo; composer: Composer }>, options?: { order?: number }): void
    /** Show something with a sent message (the skill chip, files). */
    sentWith(render: (message: { text: string; blocks: WorkBlock[] }) => ReactNode | null): void
  }
}
type Composer = { /* today's text, fill, suggest, picked */ attach(files: Attachment[]): void; insert(text: string): void }
```

The suggestion keys (←/→, ⇥, ⏎ on an offer, `ThreadView.tsx:864-874`, and since `daca0ad` ⌃1–⌃9 through a window-wide
listener, `:834-851`) can stay as core behaviour of `suggest()`. They're generic, but the window-wide ⌃1–⌃9 listener
should go through U6's focus-scoped keys rather than `window.addEventListener`.

### U4. Thread title bar, finer (S)

`thread.header` takes everything after the title. Add `thread.crumb` (the chips: branch, profile, from), so `worktrees`,
`threads` and profiles put their chips in the right place, and leave `thread.header` for buttons. Expose `ThreadRef`.

### U5. Link handlers (M), for `thread:`, files and future schemes

`Markdown`'s `a` and `code` renderers are fixed (`Markdown.tsx:128-142`).

```ts
type LinkHandler = {
  /** `thread:`, or a test on the href or inline code. */
  match: string | ((href: string, kind: 'link' | 'code') => boolean)
  render?: ComponentType<{ href: string; children: ReactNode; machine: string; thread?: ThreadInfo }>
  open?(href: string, ctx: { machine: string; thread?: ThreadInfo; beside: boolean }): void | Promise<void>
}
interface UiApi { link(handler: LinkHandler): void }
export function useTranscriptLinks(machine: string, thread: string): { text: string; href: string; open(beside: boolean): void }[]
```

`links` then lists links from data instead of anchors (gap 16), and `thread:` moves into `threads`.

### U6. Actions with `when`, and state for actions (S–M)

```ts
type WindowAction = ActionDef<any, unknown, WindowContext> & {
  /** Offered (palette, keys) only while true. */
  when?: (ctx: WindowContext) => boolean
}
type WindowContext = /* today's */ & {
  /** The focused region and pane, for keys that mean something only there. */
  focus: { region: 'sidebar' | 'thread' | 'pane'; pane?: Pane }
  registry: Registry
  log(): ActionLogEntry[]
}
interface UiApi {
  /** Window-wide state of this extension, readable from actions and components alike (replaces module globals). */
  store<T extends Json>(key: string, initial: T, options?: { persist?: boolean }): { get(): T; set(v: T): void; use(): T }
}
```

`store` replaces the hand-rolled stores in `files` (`files/src/ui.tsx:18-33`), `links` (`links/src/ui.tsx:10-13`) and
`threads` (`threads/src/ui.tsx:25`, `:64-66`).

### U7. A Picker component (S)

```tsx
<Picker label="Open a file" placeholder="…" items={items} render={(item) => …} onPick={(item, { beside }) => …} keys="ctrl-digits" />
```

It takes over the palette markup that `files`, `links` and `Palette` each repeat, and its `ctrl-digits` mode replaces
the ⌃1–9 code that links and ask-user each write.

### U8. Settings pages and New thread fields (M)

```ts
interface UiApi {
  /** A page in Settings' sidebar (rarely needed: sections suffice). */
  settingsPage(id: string, page: { title: string; component: ComponentType; desktopOnly?: boolean }): void
  /** A field in the New thread dialog; its value goes to thread.start's `options[<name>]`. */
  newThreadField(C: ComponentType<{ machine: MachineEntry; cwd: string; value: Json | undefined; onChange(v: Json): void }>): void
}
```

### U9. Window lifecycle hooks (S), for notifications and unread

```ts
interface UiApi {
  on(event: 'thread.status', listener: (e: { machine: string; thread: ThreadInfo; before: Status['state'] }) => void): () => void
  on(event: 'select', listener: (selection: Selection | undefined) => void): () => void
}
```

Notifications would move to the renderer (the `Notification` API works in Electron and in browsers, so phones too). The
main process would keep only "is any window focused?" through an app method.

### U10. Profile UI, scoped properly (S)

- Key everything a profile installs by `machine + dir` (`profile-ui.ts:72`, `extension.tsx:161`, `:234`).
- Scope `tool`, `entry` and `settings` by profile, and clear them in `installProfile` (`extension.tsx:161-171`, `:183-189`).
- Allow `action` and `appSettings` from profiles under `<profile>.<name>` ids (`extension.tsx:196`, `:201`), so a
  profile can bind keys.

## 3b. Declared UI, placed by configuration

So far the UI half says where it goes: `superego.slot('sidebar', Threads)`, and the shell decides which places exist.
This section turns that round. **An extension declares what UI it has and what kind of place each piece fits. The
shell has places, and knows no extension. Configuration decides what goes where.** It's the same split Superego
already uses for shortcuts. An action declares default `keys`, the app setting `app.keys` holds only the user's
changes, and Settings → Keyboard edits them (`shortcuts.ts:1-3`, `bound` at `:57-61`). Placement would work the same
way: the extension declares a default, `app.layout` holds the changes, and Settings → Layout edits them.

### Where placement is decided today

- **In each extension's code, at setup.** `threads` puts itself in `sidebar`, `rail`, `thread.aside` and
  `thread.header` (`extensions/threads/src/ui.tsx:41-44`). Nothing can move it without changing the extension.
- **In the shell, for the features it knows by name.** The rail hard-codes Ego's button and Settings, and falls back to
  Unread when no extension fills `rail` (`Shell.tsx:116-123`). With no sidebar it shows its own thread picker
  (`Shell.tsx:88-95`, `:106`).
- **By hand-rolled settings, one per extension.** Whether thread details show is the `threads.details` app setting,
  checked inside the component (`threads/src/ui.tsx:38`, `:310-314`). The file tree is a `localStorage` flag
  (`files/src/ui.tsx:29`). Each is a placement decision with its own menu item, key and storage.
- **By a boolean, for the pane menu.** `menu: true` on a pane kind (`extension.tsx:50`, `:279-285`). The user can't
  remove an item or change the order.
- **"Spaces" exist only in a comment.** `rail` is documented as "a space's button" (`extension.tsx:13`), but there's one
  sidebar. Two extensions in `sidebar` would be drawn stacked, with no way to switch between them (`Shell.tsx:130`).
  Profiles can't fill `sidebar` or `rail` at all (`extension.tsx:178`).

### The model

Three parts:

1. **Views**, which extensions declare. A view has an id (`<extension>.<view>`, like actions), a title, an icon, the
   context it needs (nothing, a thread, or a file), and the kinds of place it can be shown in. It also says where it
   goes by default, or that it's only offered.
2. **Places**, which the shell has. Each one gives a view its context and a size.
3. **A layout**, which is configuration: built-in defaults, then the user's changes (`app.layout`), then a profile's
   suggestions for its own threads, and a narrow variant for phones.

| Place | What it is | Context it gives | Size | Today |
|---|---|---|---|---|
| `space` | a button in the rail, and the sidebar while it's chosen | window (the selection through hooks) | column, ~250px; optional compact form for the rail | `rail` + `sidebar`, one occupant in practice |
| `aside` | a column beside the thread | thread | column | `thread.aside` |
| `pane` | a pane kind, opened from the pane menu, ⌘K, or by the agent | thread (+ params) | flexible | `pane(kind, { menu })` |
| `header` | a button or badge in the title bar | thread | button | `thread.header` |
| `crumb` | a chip after the title | thread | chip | (new, U4) |
| `drawer` (narrow only) | a tab in the phone's drawer | window | full width | nothing |

Some places stay plain slots. `composer.above`, `overlay`, `editor.side` and `editor.bar`, and the transcript renderers
(`tool`, `entry`, `work`), are behaviour, not places. A question card has to sit on the composer it claims
(`ask-user/src/ui.tsx:48-58`), so letting the user move it would only break it. They keep `superego.slot` as it is.

Which space is open is window state, like `sidebar.open` (`state.tsx:85`), not part of the layout.

A view that fits several places is written once. Thread details are a `thread` view, so they can sit in the aside, open
as a pane, or (given the selected thread) be a space. The shell adapts: in a pane the thread is the pane's, in a space
it's the selection.

### Sketch: declaring views

```ts
type Place = 'space' | 'aside' | 'pane' | 'header' | 'crumb' | 'drawer'
type ViewContext = 'window' | 'thread' | 'file'

type View<C extends ViewContext = ViewContext> = {
  title: string
  icon?: ComponentType<{ size?: number }>
  context: C
  /** The places it can be shown in, best first. */
  fits: Place[]
  /** Where it goes unless the layout says otherwise; `false`: offered, not placed (the user or a profile places it). */
  default?: Place | false
  component: ComponentType<ViewProps<C>>
  /** For `space`: what the rail button shows when the space isn't open (a count, a dot in a status colour). */
  badge?: ComponentType
  /** For `space`: a compact form drawn in the rail itself (the sidebar's "rail" mode, status dots). */
  compact?: ComponentType
  /** Agent-facing description, when it can be a pane (D6). */
  about?: string
}
type ViewProps<C> = C extends 'thread' ? { machine: MachineEntry; thread: ThreadInfo; place: Place; params?: Json }
  : C extends 'file' ? EditorSlotProps & { place: Place }
  : { place: Place }

interface UiApi {
  view<C extends ViewContext>(id: string, view: View<C>): void   // `<extension>.<id>`, checked like actions
}
```

`defineUiExtension` would also take the same declarations as data (`contributes: { views: { … } }`), without the
components, so the window knows what an extension offers before it runs any of its code. That matters for profiles and
machines (below).

The bundled extensions, rewritten:

```ts
// threads
superego.view('threads.list',    { title: 'Threads', icon: ChatsIcon, context: 'window', fits: ['space', 'drawer'], default: 'space',
                                   component: Threads, compact: ThreadDots, badge: UnreadDot })
superego.view('threads.details', { title: 'Thread details', context: 'thread', fits: ['aside', 'pane'], default: false, component: Details })
superego.view('threads.model',   { title: 'Model', context: 'thread', fits: ['header'], default: 'header', component: ModelButton })
// files
superego.view('files.tree',      { title: 'Files', icon: FolderSimpleIcon, context: 'thread', fits: ['space', 'aside', 'pane'], default: false, component: FolderPane })
// git
superego.view('git.changes',     { title: 'Changes', icon: ArrowsLeftRightIcon, context: 'thread', fits: ['pane', 'aside'], default: 'pane',
                                   component: DiffPane, about: 'the changes in the working folder; no params' })
// ego (Phase 2)
superego.view('ego.chat',        { title: 'Ego', icon: LifebuoyIcon, context: 'window', fits: ['space'], default: 'space', component: EgoThread })
```

Placing a `thread` view in `pane` registers a pane kind of the same id, which takes no params and is listed in the pane
menu. That's what "adding themselves to the pane button" means here. The menu lists everything the layout puts in
`pane`, in the layout's order. `superego.pane(kind, …)` stays for kinds that do need params (`editor`, `preview`,
`folder`).

### Sketch: the layout

```ts
/** App setting `app.layout`: only what differs from the defaults, by view id. Unknown ids are ignored (like app.keys). */
type Layout = {
  /** Rail order of spaces; ids not listed fall in after, in registration order. */
  spaces?: string[]
  /** Where each view goes; `null` hides it. */
  place?: Record<string, Place | null>
  /** Order within a place, where order shows (header, crumb, pane menu, aside). */
  order?: Partial<Record<Place, string[]>>
  /** Overrides under 760px: spaces become drawer tabs, asides become panes, by default. */
  narrow?: Omit<Layout, 'narrow'>
}
```

- **Resolution:** the view's `default`, then the profile's `layout` for that profile's threads (only for `thread` views,
  and only within its threads), then `app.layout` (the user wins), then `narrow` when narrow. A place a view doesn't
  `fit` is ignored, with a warning in Settings.
- **Editing:** Settings → Layout lists each place with its views (drag to order, a menu to move, a switch to hide), and
  views that are offered but not placed. Moves can also be made where the view is: the rail button's context menu ("Move
  to aside", "Hide"), a pane tab's ("Keep beside every thread" moves it to `aside`), and generated ⌘K actions
  (`layout.place` with `{ view, place }`).
- **Toggles become placement.** ⌘I ("Toggle thread details") is placing `threads.details` in `aside` or `null`;
  ⌘⇧T is the same for `files.tree`. The hand-rolled `threads.details` setting and the `superego.files.tree` flag go
  away, and so does `threads`' `current` global (gap 13), which existed partly to make that toggle work.
- **The shell knows no extension.** Its rail is: the spaces in layout order, then Settings. It draws Ego's button only
  because `ego.chat` is a space placed there. The Unread fallback and the thread picker become built-in views
  (`core.unread`, `core.picker`), shown when nothing else is placed in a space. `hasSidebar` (`Shell.tsx:55`) becomes
  "is a space open". Core registers its built-ins through `superego.view` like anyone else, as it already does panes
  (`renderer/index.tsx:21-33`).

### Data-only views, declared by the daemon

The request also asks for views declared "in their schema". A daemon extension, or a profile with no UI code, could
declare a view rendered by the core from data:

```ts
// daemon half
superego.view('orders.recent', {
  title: 'Recent orders', context: 'window', fits: ['space', 'aside'], default: false,
  render: { kind: 'list', value: 'orders.recent',          // a live value (or a D3 method)
            item: { title: '{number} · {customer}', detail: '{status}', action: 'orders.open' } },
})
```

There would be a small, fixed set of kinds: `list`, `table`, `markdown` (a value holding Markdown), `facts`
(label/value pairs, like thread details), and `actions` (buttons that dispatch). The daemon announces them in `hello`
(or a `view.list` method), and the window draws them with kit components. That gives three things:

- **UI without UI code.** Many profile UIs are a list fed by an action (the `support` example in
  `packages/cli/skill/ui.md`). This covers them with no TSX, compiler or blob URLs.
- **A safe tier for project profiles.** Data views run no code in the window, which answers most of the security
  concern in §5 for profiles that need only lists and buttons. Code views from project profiles could then require a
  second, explicit allow.
- **Phones and the web for free**, because the kit components already have narrow layouts.

### Profiles and machines

- A profile's views are offered; they're never placed in shared places without consent. A profile may *suggest*
  placement for its own threads (`profile.ts`: `layout: { place: { 'support.order': 'aside' } }`), and that applies
  only while one of its threads is shown. A profile `space` (today refused, `extension.tsx:178`) shows as "offered" in
  Settings → Layout until the user places it. This answers open question 2: profiles can add a sidebar, by being placed.
- Views are keyed by machine and profile as well as id, so the same profile on two machines doesn't collide (gap 2).
  `contributes` arriving with `profile.ui` (`daemon.ts:924-928`) lets the window list a profile's views, and ask about
  them, before loading its code.
- Layout is the window's (an app setting, per user; in a browser, in that browser's storage, `web-bridge.ts`), not the
  machine's. It's like keys: how you like your window, wherever the threads are.

### What it costs

| Piece | Size |
|---|---|
| `superego.view`, the `View` type, resolution (defaults → profile → user → narrow) | M (2–3 days) |
| Shell places: the rail from spaces, the sidebar as the open space, the aside from the layout, the pane menu from the layout | M (2–3 days) |
| Built-ins as views (picker, unread, Ego button), and `threads` and `files` converted (removes `threads.details`, the file-tree flag, the `current` global) | M (2 days) |
| Settings → Layout, context-menu moves, `layout.place` action | M (2–3 days) |
| Data-only views from the daemon (`list`, `table`, `markdown`, `facts`, `actions`) and their announcement | M–L (3–5 days) |
| Narrow layout: drawer tabs, asides as panes | S–M (1–2 days) |

That's about **2–3 weeks** in all, of which the first three rows (about a week) give the user-facing win: extensions
declare, config places.

### Risks

- **Too much freedom.** Not every view works everywhere. `fits` is the guard: the shell offers only the places a view
  declared, and a view must render well at the smallest size of each.
- **Context is lost when a view moves.** A `thread` view in a space shows the selection, and may show nothing without
  one. Views should handle "no thread" when they fit `space`.
- **More watches.** Placing a view in several places at once (aside and pane) mounts it twice. This depends on Phase 0's
  shared subscriptions.
- **Keyboard focus regions** (⌘⌥←/→, `focus.ts`) assume today's fixed regions. Each placed space, aside and pane
  becomes a region in layout order. That's a contained change, but it needs the smoke test's focus checks
  (`app/test/smoke.mjs`).

---

## 4. Migration plan

Ordered by value over effort and risk. Sizes are rough working days for one person who knows the code.

### Phase 0: make the API safe to lean on (2–3 days, low risk)

| Step | Size | Fixes |
|---|---|---|
| Scope profile `tool`, `entry` and `settings`; key profile UI by machine and folder (U10) | S | gaps 1, 2 |
| Scoped `settings.register` with undo (D7) | S | gap 3 |
| Check for duplicate extension names on both halves; warn on overwritten tool and settings renderers | S | silent collisions |
| Share watches: one subscription per `(machine, method, key)`, refcounted, in `useWatch`; one app-settings snapshot | S–M | gap 7 |
| Export `PaneHeader`, `useTabNote`; pane `icon` and `file` (U1) | S | gaps 10, and panes outside core |
| Load the profiles of threads with interrupted runs before `harness.resume()` (verify first, gap 5) | S | correctness |
| Move `SORT` into `threads` (or make it a core setting the extension only reads) | S | gap 15 |
| Tidy the comments at `extension.tsx:42-46` | S | |

These are quick wins: none changes behaviour that users see, and each removes a footgun before more code lands on the API.

### Phase 1: dogfooding (1–2 weeks, low–medium risk)

Each of these proves one extension point by moving a real feature through it.

1. **`git` extension: Changes** (2 days). Adds D3 (read methods), D6 (pane descriptions) and U1. Moves `DiffPane` and
   `parseDiff` (`panes.tsx:253-331`), `thread.diff` (`daemon.ts:914-922`) and `panes.changes` ⌘⇧D
   (`actions.tsx:146-149`). Done when core `panes.tsx` registers only `editor` and `thread`, and `pane_open`'s
   description lists `diff` because `git` said so. Natural follow-ons: commit and branch actions.
2. **`web-panes`: Preview and Artifact panes** (½ day). Today's API is enough for the panes; the artifact origin stays in
   core until D8.
3. **`skills` extension** (3–4 days). Adds D2 (submit transforms), U3 (completion providers and `sentWith`). Moves
   `skills.ts`, the two sections (`daemon.ts:268-269`), `withSkills` (`:557-568`), `skill.list` (`:912`), the composer
   completion (`ThreadView.tsx:774-815`, `:914-924`) and the skill chip (`:375-387`). `without: ['skills', 'agents-md']`
   keeps working because both are still agent extensions owned by `skills`. This is the hardest test of the composer
   API, so it's the best proof.
4. **Tool-row descriptors (U2), with core as the first user** (2 days). Rewrite the coding-tools rows in core through
   `toolRow` and check that the showcase screenshots don't change (`pnpm --filter superego showcase`).
5. **Window `store` and `when` (U6)** (1–2 days). Convert `files`, `links` and `threads` off module globals. Delete
   either `thread.next` or `threads.next`.

### Phase 2: the structural moves (2–3 weeks, medium risk)

6. **`threads` gets a daemon half: thread tools** (3 days). Needs D1's `threads.create`, `submit` and `lastAnswer`, U2
   (rows for `thread_*`) and U5 (`thread:` links). Moves `thread-tools.ts`, `daemon.ts:271-287`,
   `ThreadView.tsx:585-588`, `:626-668`, `:699-702` and `Markdown.tsx:131`. The Settings switch named `threads` then
   means one thing (gap 15).
7. **`worktrees` extension** (4–5 days). Needs D1 (`creating`, `archiving`, `unarchiving`), D4 (state and facts), U4
   (crumb) and U8 (a New thread field). Moves `daemon.ts:644-660` and `:727-758`, the branch chip and the dialog's
   checkbox. Migration: the old `ThreadMeta.worktree` stays readable and is copied into the extension's state on mount.
   This is the riskiest move here, because archiving removes a folder. Keep the daemon e2e tests for archive and
   unarchive as they are and run them against the extension.
8. **`ego` extension** (2–3 days). Needs D5 (agent selection) and D4. Moves `meta.ts`, `thread.meta` and `app.meta`,
   and the rail button (into `rail` with an order before `threads`).
9. **Notifications and Unread** (2 days). U9, then `notifications` and `unread` extensions. Notifications start working
   in the browser and PWA as a bonus.

### Phase 2b: declared views and the layout (§3b, 2–3 weeks, medium risk)

This can start once Phase 0's shared subscriptions are in, and runs alongside Phase 2.

9a. **`superego.view` and the places** (1 week): spaces in the rail, the open space in the sidebar, the aside and pane
    menu from the layout. Convert `threads` (list as a space, details as a view, model as a header item) and `files`
    (tree as a view). Core's picker, Unread and Ego's button become views. The shell then names no extension. Done
    when `Shell.tsx` has no `UnreadButton`, `LifebuoyIcon` or `hasSidebar`, and ⌘I is a placement.
9b. **Settings → Layout** and the moves from context menus (2–3 days). For now the layout is text instead
    (`layout.json`, Edit layout…, `superego layout`), with the moves from context menus; the editor waits for the model
    to settle.
9c. **Data-only views from the daemon** (3–5 days), then the narrow layout (1–2 days).

### Phase 3: optional (as needed)

10. **`web-access`** (D8): worth doing if a second transport arrives (Tailscale serve, a relay), not before.
11. **Link handlers for files (U5)**, so a profile can claim `[[wikilinks]]` its own way (the obsidian profile).
12. **Settings pages and the action log** as a `devtools` extension. Low value.
13. **Attachments** as a submit transform plus a composer button. Only if someone wants to replace them.

### What should stay in core, deliberately

- **The protocol, router and actions** (`packages/protocol`). They're the contract extensions talk through.
- **The thread catalog, `ThreadDoc`, status derivation, mounting and watches** (`daemon.ts:313-400`). Extensions
  contribute to status; they don't own it.
- **Profiles, trust and the SDK loader** (`profiles.ts`, `profile-ui.ts`). That's the extension loader itself.
- **Machines, links, transports and identity** (`packages/client`, `main/link.ts`), **providers, auth and models**
  (`agent-settings.ts`).
- **The shell**: the pane row and strip, focus regions, the composer box, the transcript's run and task framework, the
  palette, the navigator, the generic settings renderer, the restart notice, the menu bar and Dock.
- **`FileEditor`, `Markdown`, `Diff`** as library components in `superego/ui`. Panes are extensions; the components
  they're built from are kit.
- **Coding tools' agent side.** It's pi-durable's, and `without: ['coding-tools']` already makes it optional.

PLAN §1's gate ("if it only makes sense with a particular layout, it's not core") supports every move above. None of
them puts layout into an extension; they take layout-specific features out of the core.

---

## 5. Risks and open questions

**Performance**

- Watches multiply with extensions (gap 7). With the six extensions today, a window with one thread shown holds, among
  others, a `settings.watch` on `app` per `useAppSetting` call, plus one `value.watch` each for `ask-user.pending` and
  `suggestions.next` per mounted composer. Thread panes add composers. Share subscriptions before adding extensions.
- Every renderer event goes through every listener (`client.ts:64-67`, through `window.superego.onEvent`). That's fine
  at today's scale; with dozens of watches, route by `sub` in one table.
- `superego.threads.list()` mounts and lists every thread (`daemon.ts:377-385`). `files.list` calls it on every request
  (`files/src/daemon.ts:51`). Add `get(id)` (D1).
- Profile UI compiles on every `profile.module` request (`profiles.ts:238-256`), and the renderer caches by hash
  (`profile-ui.ts:64-73`). Fine. Daemon-side `hashProfile` walks the profile folder on every `profileOf` call
  (`daemon.ts:483`), meaning every turn: watch it for profiles with many files.
- The `work` dividers run on every render of every run (`ThreadView.tsx:334`, `:339`). Tasks' divider is linear, but
  more dividers would compound. Memoise by run key.

**Load order**

- UI: core first, then the `main.tsx` order (`extension.tsx:208-212`). Slots sort by `order` (`:181`); `work` dividers,
  keys on a clash, and today `tool` (last wins) depend on list order. Make this explicit: an `order` on `work`, a
  warning on duplicate tool renderers, and Settings → Keyboard already shows key clashes.
- Daemon: bundled extensions are set up before `resume` (good). Profile extensions aren't (gap 5). Ego's tools are
  installed but not built-ins (`daemon.ts:410-411`), which D5 would make explicit.
- Extension dependencies: `worktrees` would hook `creating` before `threads.create` runs, and `skills` and `attachments`
  would both transform submit content. Transforms should be ordered and declared (`after: ['attachments']`), or kept to
  one owner per concern.

**Versioning**

- The two halves of an extension can run different code: the UI is built into the app, while a remote daemon runs
  whatever was installed there (`scripts/install-machine.sh`). `ext:<name>` without a version (gap D9) leaves every UI
  half guessing, as `ask-user` already does (`ask-user/src/ui.tsx:39-40`).
- `DaemonApi.harness` exposes pi-durable whole. Any extension that uses it is pinned to pi-durable 1.5. Prefer D3 and D4
  and document `harness` as unstable.
- Moving `worktree`, `parent` and `meta` out of `ThreadInfo` changes the protocol. Keep the fields, add `ext`, and
  remove them only behind a feature flag (PLAN §2: "after a release, peers negotiate by `features`").

**Security of project profiles**

- A project's daemon extension runs in the daemon process with full Node, once allowed (`profiles.ts:189-195`). That's
  documented and gated by a hash (`profiles.ts:105-134`). Fine.
- **A project's UI runs in the window with the whole `window.superego` bridge**: every machine, and the `app` endpoint's
  `machines.add`, `app.settings.set` and so on (`profile-ui.ts`; `start.ts:338-373`). The trust decision is the remote
  daemon's (`Trust` lives in its data dir), but the code runs on the local computer, where it can call any other
  machine. A profile allowed on a shared box therefore reaches your laptop's other machines. Before pushing profiles as
  the extension story, give profile UI a capability-limited bridge: its own machine, its own extension's actions,
  `pane.*` and `thread.send` for its threads. PLAN §3 mentions "a sandboxed tier comes later". This is the reason to
  bring it forward.
- `settings` and `harness` in a profile's `DaemonApi` let it change machine-wide settings (provider keys among them,
  `agent-settings.ts`). D7's scoping should restrict profiles to their own keys.

**Phone and web client**

- Bundled UI halves are compiled into the window build, so they work in the browser. Profile UI loads over the
  WebSocket the same way (`web-bridge.ts`). Good.
- Features tied to the main process don't work there: artifacts are served differently (`web-bridge.ts:136` vs
  `start.ts:486`), folder picking and machines are desktop-only (`SettingsView.tsx:34`), and notifications are main-only
  (`start.ts:217`). Moving notifications to the renderer (U9) fixes one of these.
- Narrow layout: `thread.aside` and `rail` don't render under 600px (`Shell.tsx:115`, `:146`), and nothing can add to
  the mobile bar. Slots should say how they degrade (`narrow?: 'hide' | 'drawer' | 'pane'`), or the `threads` details
  should become a pane kind, which works everywhere.

**Testing**

- Daemon halves have a good pattern: a real daemon, a replayed model, assertions over the socket
  (`ask-user/test/daemon.test.ts`, `packages/cli/skill/bundled.md`). Moving git, skills, worktrees and Ego keeps their
  e2e tests meaningful, as long as the tests open the daemon with the new extension in `extensions: [...]`.
- UI halves have no harness (gap 20). Before Phase 1, add `renderExtension(ext, { threads, values })`: a registry plus a
  fake bridge in jsdom. Otherwise the composer and tool-row moves are checked only by the smoke test and the showcase
  screenshots.
- `superego/ui` and `'superego'` aren't typed for profile authors (PLAN §3b, §9). Every exported symbol is now API.
  Generate declarations from `renderer/index.tsx` and `profiles.ts:158-161` and check them in, so that removing an
  export shows up in review.

**Open questions**

1. Should `threads` stay one extension (sidebar, details, thread tools, `thread:` links, the thread pane), or split into
   `sidebar` and `subthreads`? One is simpler for `without`; two is clearer in Settings.
2. Should profiles be able to *replace* bundled UI (the sidebar, `rail`), or only add to it (`extension.tsx:178`)? A
   "support desk" profile would want its own sidebar. §3b proposes an answer: a profile offers a space, and the user
   places it, so it's added by consent rather than replaced. Still open: should a profile's suggested layout apply
   automatically within its own threads, or need a confirmation the first time?
3. Is per-thread extension state (D4) stored in `ThreadDoc` (forks and archives with the thread), or in a doc per
   extension (separate migrations)? I'd suggest a namespaced field in `ThreadDoc` for simplicity.
4. Runtime-installed extensions (PLAN §9: "then runtime-installed extensions"): would they load like profiles (served
   and compiled by the daemon) or like bundled ones (built into the window)? The profile path already works, but it
   carries the security issue above.
5. Should the MCP server (PLAN §3a) expose extension actions by default? With D3, reads stop being actions, which makes
   "expose every `cli` action" a safer default.
6. Is layout one per window or one per user? `app.layout` as proposed is per user (every window the same). A second
   window for a different job (one wide window with Changes as an aside) argues for per-window overrides, kept the way
   `selection` is (`state.tsx:82`).
7. How far should data-only views go before they become a UI framework? Five kinds (`list`, `table`, `markdown`,
   `facts`, `actions`) cover the profiles seen so far. Anything richer should be a code view.
