# Cheat sheet

What each half of an extension registers, a line each. The [guide](guide.md) builds one; [daemon.md](daemon.md) and
[ui.md](ui.md) have the details.

| Daemon half (`superego.` in `setup`) | For |
|---|---|
| `agent(defineExtension({ tools, sections, hooks }))` → `replace(next)`, `remove()` | the agent's tools, prompt sections and hooks. `replace` takes effect from the next request, mid-run too; calling the handle removes it, so `setup: (s) => s.agent(part)` returns its cleanup |
| `action(defineAction({ id: 'x.y', params, run }))` | an intent: logged, in ⌘K. `expose: ['ui', 'cli']` for `superego do`; `keys` binds it while one of the machine's threads is shown (`thread: true` fills in `thread`) |
| `method('x.y', run, { params })` | a read for the UI; params checked first |
| `value('x.y', initial)` → `get`, `set`, `update` | live state the UI watches; in memory |
| `scopedValue('x.y', initial)` → `get(scope)`, `set(scope, next)`, `update(scope, edit)`, `delete(scope)`, `scopes()` | live state per scope (a thread's id); a window watching one scope hears only it. In memory: `delete` a thread's when done |
| `signal` | aborted at teardown: for its own timers, watchers and fetches ([lifecycle](lifecycle.md#lifecycle-and-ownership)) |
| `view('x.y', { title, icon, context, fits, default, value \| method })` | a view drawn from blocks, no UI code ([Data-only views](window.md#data-only-views)); its buttons have that machine's authority |
| `status((thread) => ({ kind: 'question' }))`, `invalidate()` | show a thread as needing you |
| `beforeSend(({ thread, text, attachments, content, by, exposure }) => [...content, block])` | add to what a message gives the agent; return nothing to leave it. `by`: the sending extension (absent for the user); `exposure`: `outside`, `cli` |
| `mention('note', ({ ref, id, thread }) => 'a line, or undefined')` | (API ^5.16) what `@note:<id>` names in a message sent, told to the agent; 2s each ([Mentions](daemon.md#mentions)) |
| `settings.register({ id: 'x', settings })`, `settings.get`, `settings.snapshot`, `settings.onChange` | machine settings of its own (`x.…`); read any |
| `secrets.get('x.token')`, `secrets.onChange('x.token', fn)` | a `type: 'secret'` setting the user sets; clients see only set or not ([Secrets](daemon.md#secrets)) |
| `dir` | its folder, `<dataDir>/extensions/x` (0700): JSON, `node:sqlite`, a cache; kept through teardown |
| `jsonFile(name, { empty, check?, trouble })` | (API ^5.21) a JSON state file in `dir`: `read()` once, `save(data)` whole; atomic, one save at a time, a bad one kept aside, never written over ([State files](daemon.md#a-state-file)) |
| `dispatch(id, params)`, `actions(exposure)` | run any action on the machine as this extension; list them |
| `call(id, params)` | another extension's method on this machine (`skills.list`) |
| `thread({ starting, abandoned, started, turnStart, turnEnd, stopped, blocked, archiving, archived, unarchiving, unarchiveAbandoned, unarchived })` | a thread's life ([A thread's life](lifecycle.md#a-threads-life)): move it, refuse to archive it, clean up after it, hear its runs |
| `state()` → `get(id)`, `set(id, next)`, `update(id, edit)` | its own state with each thread, across restarts; `starting` gives a new one its first |
| `facts(({ id, state }) => …)` | what clients see as `thread.facts.<name>` |
| `quiet(({ id, state }) => boolean)` | its runs' ends aren't unread or notified (someone else hears them); needing you still is |
| `recap(({ thread, answer, calls }) => …)` | a run's line, for its `done` status and notification; first answer wins, else the answer's first sentence |
| `toolCalls(({ thread, call, result }) => …)` | hear each tool call once it ends; read-only ([Watching tool calls](daemon.md#watching-tool-calls)) |
| `agentFor(({ id, state, profile }) => ({ instructions, model, extensions, without }))` | choose a thread's agent; first answer wins |
| `agentParts(({ id, hidden, owner, profile }) => [part])` | add parts to any thread's agent at each send (given with `agent(part, { always: false })`); all add up; up to 5s |
| `auth.flow(context, async (flow) => …)` → `{ flow }` | a sign-in flow for the client running an action: `flow.emit({ type: 'auth_url', url, callback })`, `await flow.prompt({ type: 'manual_code', message })`, `flow.signal`. Drawn with `SignInFlow` |
| `threads.list({ archived, hidden })`, `get(id)`, `of(conversationId)`, `conversation(id)`, `attachments(id)` | reach threads, and the folder a thread keeps files in |
| `threads.start({ …, parent, hidden, options })`, `send(id, text, { context?, wake? })`, `lastAnswer(id)`, `idle(id)`, `entries(id, limit)`, `archive(id, { whenIdle })`, `unarchive(id)`, `clear(id)` | run threads as the thread tools do. `hidden`: an agent of its own, in no list (find it by `owner`); `entries`: not a stable shape; `clear`: start over. A message `send` sends shows your title over it |
| `threads.notice(id, { text, kind?, data?, actions?, agent?, wake? })` | (API ^5.17) tell the user in a thread, no run (`wake`, API ^5.18: start one): unread and notified, the agent told as context; buttons send a message or dispatch an action ([Notices](daemon.md#notices)). Waking: [Waking the agent](daemon.md#waking-the-agent) |
| `machines.list()`, `machines.call(machine, method, params)` | the other machines this daemon reaches, and a call to one (no consent actions) |
| `agentsDir`, `dataDir` | `~/.agents` (skills, `AGENTS.md`); `~/.superego` |

| UI half (`superego.` in `setup`) | For |
|---|---|
| `view('x.y', { title, icon, context, fits, default, narrow, withoutSidebar, order, component, railButton, width })` | UI the layout places ([Views and the layout](window.md#views-and-the-layout)) |
| `slot(name, Component, { order })` | `header.chips`, `thread.badge`, `thread.menu`, `sidebar.heading`, `composer.above`, `details.section`, `editor.side`, `editor.bar`, `overlay`, `onboarding`, `welcome` ([slots](ui.md#slots)) |
| `sidebarFilter(useFilter)` | narrow the sidebar's list: a hook returning `{ shows, title?, footer? }` or undefined ([narrowing](ui.md#narrowing-the-sidebar)) |
| `newThreadField({ component, from })` | a New thread field, sent as `options.<name>` for `starting`; `from(thread)` its value for one started like `thread`. Bundled only |
| `signal` | aborted at teardown (UI reloaded or revoked) |
| `on(event, listener)` → off; `window` | `thread.status`, `select`, `focus`, `visibility`; `window` is `{ focused, visible, selection, thread, machines, threads }` now |
| `style(css)` → remove | CSS scoped to what this profile draws ([Styling](ui.md#styling)); an app extension's styles the window |
| `theme({ id, name, appearance, syntax, terminal, ui, accent })` | a theme in Settings → Appearance ([Themes](ui.md#themes)) |
| `appSetting(key)` | an app setting now, outside React |
| `pane(kind, { title, component, icon, file, menu, opens, fallback, folders, urls, width })` | a pane kind; `opens`, `folders`, `urls`: what a thread names opens in it; `fallback`: any file |
| `space(kind, { title, component, icon, match, params, about, profile, agent })` | fills the main area, a thread docked beside ([Spaces](window.md#spaces)); app extensions and global profiles |
| `tool(name, { icon, verbs, subject, stat, meta, body, phrase, file, weight }, { fold })` | how a tool's calls look, described ([Tool rows](ui.md#tool-rows)) |
| `tool(name, Component, { fold })` | drawn whole; `fold: false` shows them outside the run's fold |
| `tool('mcp__*', …)` | a prefix: tools without their own row; longest wins |
| `entry(kind, Component)` | transcript entries of a kind it writes; also draws the daemon half's notices of that `kind` (API ^5.17) |
| `codeBlock(languages, Component)` | fenced code blocks of a language, drawn yourself: `{ language, code, compact, streaming }` |
| `link({ match, open, render, target, scheme })` | claim links ([Links](window.md#links)) |
| `composer.complete({ title, word(text, caret), items(word, { machine, cwd, thread? }) })` | complete the word being typed: `{ label, detail, icon, insert }` |
| `composer.mention({ kind, title, icon, list \| search, href })` | (API ^5.16) things `@` offers, written `@<kind>:<id>`; sent, drawn as links (`<kind>:<id>`) ([Mentions](ui.md#mentions)) |
| `composer.command({ name, detail, takes?, run(rest, { machine, thread }) })` | (API ^5.19) `/<name>` opening a message runs it instead of sending; `{ send }` back sends that after all ([Commands](ui.md#commands)) |
| `composer.sentWith({ read(blocks), component, words })` | draw what `beforeSend` added, under sent messages |
| `work(divide)` | split a run of work into titled parts; bundled only |
| `action(defineAction({ id, keys, when, run }))` | a window action with keys, in ⌘K while `when(context)` holds; a profile's only while one of its threads is shown |
| `store('open', initial, { persist })` → `get`, `set`, `use()` | state its actions and components share, kept as `<name>.open` |
| `appSettings({ id, settings, tab? })` | per-user settings in Settings → General (or `tab`); `useAppSetting(key)`, `context.appSetting(key)`; bundled only |
| `settings(ui, Component)` | draw under a settings section naming `ui` |
| `dispatch(id, params, { machine })` | run an action outside React |

Names: everything is `<extension>.<something>`, except tools and pane kinds.

In components ([From 'superego/ui'](ui.md#from-superegoui)): `useThreads`, `useAllThreads`, `useProjects`,
`useSelection`, `useMachines` ([Reading threads](ui.md#reading-threads)), `useValue(machine, key, { scope })`,
`useMethod(machine.id, method, params, { enabled, refresh })`, `useDispatch`, `call`, `has(machine, 'ext:x@^1.2')`
(set up and on there, at a version; UI-only extensions never appear), `version(machine, 'x')`; `<PaneHeader>`,
`<PaneNote>`, `<PaneButton>`, `<PaneMessage>`, `useTabNote`, `useTabGlyph`; `<HeaderChip menu?>` (API ^5.17 `menu`: `<ThreadMenuItem>`s), `<ThreadBadge>`, `<Chip>`,
`<RailButton>`, `factsOf(thread, name)`; `<ThreadRef machine id>`; `transcriptLinks(machine, thread)`; `<Picker>`;
`FileEditor`, `TextEditor`, `Markdown`, `Diff`, `SignInFlow`; `<ConfirmDialog>` and `<PromptDialog>` to ask (API ^5.15;
[Dialogs](ui.md#dialogs)), `<Dialog footer flush>`, `<Button variant="danger">`.

Machines update at different times. The window draws none of a UI half for a machine running its extension at another
major. A UI half calling its daemon half where there may be none (a window view) checks `has(machine, 'ext:x')` first
and says so, or offers nothing. See [Versions and compatibility](lifecycle.md#versions-and-compatibility).
