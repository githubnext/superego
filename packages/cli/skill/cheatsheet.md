# Cheat sheet

What each half of an extension registers, in a line each. The [guide](guide.md) has one built end to end; [daemon.md](daemon.md)
and [ui.md](ui.md) have the full tables.

| Daemon half (`superego.` in `setup`) | For |
|---|---|
| `agent(defineExtension({ tools, sections, hooks }))` → `replace(next)`, `remove()` | the agent's tools, prompt sections and hooks. Its handle puts another part of the same name in its place (threads that have it get it from their next request to the model, mid-run too) or takes it away; called, it's `remove()`, so `setup: (s) => s.agent(part)` returns its cleanup. |
| `action(defineAction({ id: 'x.y', params, run }))` | an intent: logged, in ⌘K; `expose: ['ui', 'cli']` for `superego do`; `keys` binds it in the window while one of the machine's threads is shown (`thread: true`: its `thread` filled in) |
| `method('x.y', run, { params })` | a read for the UI; params checked first |
| `value('x.y', initial)` → `get`, `set`, `update` | live state the UI watches; in memory |
| `scopedValue('x.y', initial)` → `get(scope)`, `set(scope, next)`, `update(scope, edit)`, `delete(scope)`, `scopes()` | live state kept per scope (a thread's id): a window watching one scope hears only its changes, never another thread's; in memory, so `delete` a thread's when it's done |
| `signal` | aborted at teardown: for its own timers, watchers and fetches ([Lifecycle and ownership](lifecycle.md#lifecycle-and-ownership)) |
| `view('x.y', { title, icon, context, fits, default, value \| method })` | a view drawn from data ([Data-only views](window.md#data-only-views)): no UI code, so a remote machine's or a project profile's runs no code in the window; its buttons still have that machine's authority |
| `status((thread) => ({ kind: 'question' }))`, `invalidate()` | show a thread as needing you |
| `beforeSend(({ thread, text, attachments, content, by, exposure }) => [...content, block])` | add to what a message gives the agent before its turn (a named skill's instructions); return nothing to leave it. `by`: the extension that sent it (`threads.send`, `threads.start`'s prompt), absent for the user's; `exposure`: `outside` when an outside agent sent it, `cli` the command line |
| `settings.register({ id: 'x', settings })`, `settings.get`, `settings.snapshot`, `settings.onChange` | machine settings of its own (`x.…`); read any |
| `dispatch(id, params)`, `actions(exposure)` | run any action on the machine as this extension (`settings.set`); list them |
| `call(id, params)` | read another extension's method on this machine (`skills.list`) |
| `thread({ starting, abandoned, started, turnStart, turnEnd, stopped, blocked, archiving, archived, unarchiving, unarchiveAbandoned, unarchived })` | take part in a thread's life ([A thread's life](lifecycle.md#a-threads-life)): make it work elsewhere, refuse to archive it, clean up after it, hear it end a run, be stopped with others' messages queued, or come to need the user |
| `state()` → `get(id)`, `set(id, next)`, `update(id, edit)` | state of its own kept with each thread, across restarts; `starting` gives a new one its first |
| `facts(({ id, state }) => …)` | what clients are told of a thread, as `thread.facts.<name>`: worked out from its state |
| `quiet(({ id, state }) => boolean)` | say how a thread's runs end isn't the user's to look at (someone else hears it): `thread.quiet`, so its finishing or failing isn't unread nor notified; needing you still is |
| `recap(({ thread, answer, calls }) => …)` | say in a line what a run did, once it ends: the thread's `done` status carries it (`msg`), and its notification says it. The first to answer wins; with none, the answer's first sentence. |
| `toolCalls(({ thread, call, result }) => …)` | hear each tool call a thread's agent makes, once it ends; read-only ([Watching tool calls](daemon.md#watching-tool-calls)). |
| `agentFor(({ id, state, profile }) => ({ instructions, model, extensions, without }))` | choose a thread's agent; the first to answer wins. `agent(part, { always: false })` gives a part only through this, or `agentParts` |
| `agentParts(({ id, hidden, owner, profile }) => [part])` | add to whatever agent a thread has: asked at every send, with its profile as loaded now (`profile.spec`); answers with parts given with `agent(part, { always: false })`. They add up: every extension's, after the chooser's and before the profile's. May be async, up to 5s; later, or a throw, adds nothing to that turn. |
| `auth.flow(context, async (flow) => …)` → `{ flow }` | a sign-in flow of its own, for the client an action runs for (its context), carried as a provider's is: `flow.emit({ type: 'auth_url', url, callback })`, `await flow.prompt({ type: 'manual_code', message })`, `flow.signal`. It ends `done` when the function resolves, `failed` when it throws. The window draws it with `SignInFlow` (`superego/ui`). |
| `threads.list({ archived, hidden })`, `get(id)`, `of(conversationId)`, `conversation(id)`, `attachments(id)` | reach threads, and the folder a thread keeps files in |
| `threads.start({ …, parent, hidden, options })`, `send(id, text)`, `lastAnswer(id)`, `idle(id)`, `entries(id, limit)`, `archive(id, { whenIdle })`, `unarchive(id)`, `clear(id)` | start and run threads as the thread tools do; `hidden`: in no list, an agent of its own with no profile, that takes no messages while the extension is off (find it by its `owner` in `list({ hidden: true })`, not by its facts, which are gone while the extension is off); `entries`: the newest since it was last cleared, as pi-durable's entry records (not a stable shape); `clear`: start it over |
| `machines.list()`, `machines.call(machine, method, params)` | the other machines this daemon reaches (its `machines.json`) and a call to one, as a client calls it (`thread.list`, `thread.start`); none when it reaches no others. |
| `agentsDir`, `dataDir` | the folder agents share (`~/.agents`): skills, `AGENTS.md`; this machine's data folder (`~/.superego`) |

| UI half (`superego.` in `setup`) | For |
|---|---|
| `view('x.y', { title, icon, context, fits, default, narrow, withoutSpaces, order, component, railButton, width })` | UI the layout puts in places ([Views and the layout](window.md#views-and-the-layout)): a space, a rail button, beside the thread, the pane menu, the title bar; `default` where it goes unless the user moves it |
| `slot(name, Component, { order })` | a component in a slot whose place behaviour decides ([Views and the layout](window.md#views-and-the-layout)): `header.chips` for a chip where the title bar says where a thread works, `thread.badge` for a small mark after its title in the sidebar (a `<ThreadBadge label>` around a 12px icon), `composer.above`, `details.section` (in thread details, ⌘I: an `<h5>` and what you know of the thread), `editor.side`, `editor.bar`, `overlay`, `onboarding` (on the first-launch page) |
| `newThreadField({ component, from })` | a field in the New thread dialog: its value goes to `thread.start` as `options.<name>`, for the daemon half's `starting`; `from(thread)` its value for one started like `thread`; bundled only |
| `signal` | aborted at teardown (its profile's UI reloaded or revoked): for its own timers, listeners and fetches ([Lifecycle and ownership](lifecycle.md#lifecycle-and-ownership)) |
| `on(event, listener)` → off; `window` | hear the window: `thread.status` (`{ machine, thread, before }`; `before` undefined the first time it's seen), `select` (`{ selection, before }`), `focus` (`{ focused }`), `visibility` (`{ visible }`); `window` is `{ focused, visible, selection, thread, machines, threads }` now (`threads`: each machine's in use, by id). In Electron and browsers alike |
| `style(css)` → remove | CSS while it's set up: a profile's only reaches what that profile draws ([Styling](ui.md#styling)); an app extension's styles the window |
| `appSetting(key)` | one of the app's settings as it is now, outside React |
| `pane(kind, { title, component, icon, file, menu, opens, fallback, folders, urls, width })` | a kind of pane beside the thread; `opens`, `folders`, `urls`: files, folders or web pages a thread names open in it; `fallback`: any file nothing else opens |
| `tool(name, { icon, verbs, subject, stat, meta, body, phrase, file, weight }, { fold })` | how calls to a tool look, described: `verbs: ['Read', 'Reading', 'Read failed']`, `subject(call)` after the verb, `body(call)` what it opens to, `phrase(count)` in a run's line ("read 2 files"); the rest default. The core's coding tools and `threads`' thread tools are rows too |
| `tool(name, Component, { fold })` | how calls to a tool look, drawn whole; `fold: false` shows them outside the run's fold (images) |
| `tool('mcp__*', …)` | a name ending in `*` is a prefix: every tool whose name starts so, where it has no row of its own; the longest prefix wins. |
| `SignInFlow` (`superego/ui`) | a sign-in flow drawn as Settings → Providers draws one: `<SignInFlow machine title start={() => dispatch('x.signIn', …)} onClose />`, for an action that answers with `auth.flow`'s `{ flow }`. On the desktop, a flow on another computer whose `auth_url` has a loopback `callback` is caught here and answered for you. |
| `entry(kind, Component)` | transcript entries of a kind it writes |
| `link({ match, open, render, target, scheme })` | claim links: `match` a scheme (`'ticket:'`), a pattern, or `(href, kind, where) => boolean` that sees inline code too (`kind: 'code'`); `open(href, { machine, thread, beside, openFile, openUrl })` follows one (a click, ⌘-click `beside`, ⌃O); `render` draws it; `scheme` names the scheme a pattern or test claims (`'thread'`), so HTML files keep its links. Claiming files, `[[wikilinks]]` or web pages overrides the core's: [Links](window.md#links) |
| `composer.complete({ title, word(text, caret), items(word, { machine, cwd, thread? }) })` | complete the word being typed: `word` finds it (`{ start, query }`), `items` offers `{ label, detail, icon, insert }` (`icon` tells kinds apart in one menu); no `thread` in the New thread dialog, before there's one |
| `composer.sentWith({ read(blocks), component, words })` | draw what its `beforeSend` put in sent messages under them (a chip): `read` returns `{ items, blocks }`, and those blocks leave the text; `words(text, items)` rewrites the message's own Markdown (a mention as a link) |
| `work(divide)` | split a run of work into titled parts (tasks); bundled only |
| `action(defineAction({ id, keys, when, run }))` | a window action with keys, in ⌘K while `when(context)` holds; a profile's only while one of its threads is shown |
| `store('open', initial, { persist })` → `get`, `set`, `use()` | a store its actions and components share, kept as `<name>.open` (`'<name>.open'` is the same one) |
| `appSettings({ id, settings })` | per-user settings; `useAppSetting(key)`, `context.appSetting(key)`; bundled only |
| `settings(ui, Component)` | draw under a settings section that names `ui` |
| `dispatch(id, params, { machine })` | run any action outside React |

Names: everything is `<extension>.<something>`, except tool and pane kind names. In components: `useThreads`,
`useAllThreads`, `useProjects`, `useSelection`, `useMachines` (what each gives, and a thread's `status`: "Reading threads" in
[ui.md](ui.md)), `useValue(machine, key, { scope })`, `useMethod(machine.id, method, params, { enabled, refresh })` (a method's answer, with `error`, `loading` and `refetch`; called again as `params` or `refresh` change, answers to stale calls dropped), `useDispatch`, `call`, `has(machine, 'ext:x')` (whether a machine has an
extension set up and switched on now, kept current; UI-only extensions never appear; `'ext:x@^1.2'` at a version in
a range, see [Versions and compatibility](lifecycle.md#versions-and-compatibility)), `version(machine, 'x')`; in panes `<PaneHeader>` and
`<PaneNote>`, `<PaneButton>`, `<PaneMessage>`, `useTabNote` and `useTabGlyph`; for slots `<HeaderChip>`, `<ThreadBadge>`, `<Chip>`, `<RailButton>` (bundled extensions' rail) and `factsOf(thread, name)`; in rows `<ThreadRef machine id>`; `transcriptLinks(machine, thread)`, the links a transcript shows; for a list to pick from (quick open, say), `<Picker label placeholder items filter row onPick onClose digits>`; to build from, `FileEditor`, `Markdown` and `Diff`. Full tables: [daemon.md](daemon.md), [ui.md](ui.md).

Machines update at different times, so a window can meet an older or newer daemon. The window draws none of a UI half
for threads on a machine that runs its extension at another major; one that calls its daemon half where there may be
none (a window-level view, say) checks `has(machine, 'ext:x')` first, and says so, or offers nothing, when it's
missing. See [Versions and compatibility](lifecycle.md#versions-and-compatibility).
