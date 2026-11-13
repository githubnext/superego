# Writing extensions

An extension has up to two halves: a **daemon half** next to the agents on a machine, and a **UI half** in the window.
Either can be left out. Everything either half registers is its own, and goes when it does.

## The big picture

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/big-picture-dark.svg"><img src="writing-extensions/big-picture.svg" alt="The daemon half gives the agent tools; the UI half dispatches actions to it, calls its methods and watches its live values"></picture>

| The UI half wants to… | The daemon half offers | The UI uses |
|---|---|---|
| change something | `action(defineAction({ id, run }))`: logged, in ⌘K, on the command line | `useDispatch()(id, params, { machine })` |
| read something | `method(name, run, { params })`: a plain request | `call(machine, name, params)` |
| follow something | `value(key, initial)` | `useValue(machine, connected, key)` |

Where they come from:

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/loading-dark.svg"><img src="writing-extensions/loading.svg" alt="Bundled extensions are built into the app; profiles in ~/.superego/profiles or a project's .superego/profiles name their extensions and UI modules"></picture>

A profile's halves import `'superego'` and `'superego/ui'`. A bundled extension's halves import the packages directly (`@superego/daemon`, `@superego/app/ui`, …), see [bundled.md](../packages/cli/skill/bundled.md).

## A first extension, end to end

A profile, `~/.superego/profiles/default/`, whose agent keeps notes and whose window shows them in a pane:

```ts
// profile.ts
import { defineProfile } from 'superego'
export default defineProfile({ extensions: ['./notes.ts'], ui: ['./ui.tsx'] })
```

```ts
// notes.ts: the daemon half. A tool for the agent, a read for the pane, and the pane described to the agent.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineDaemonExtension, defineExtension, defineTool, obj, str } from 'superego'

export default defineDaemonExtension({
  name: 'notes',
  setup(superego) {
    const fileOf = async (id: string) => join((await superego.threads.get(id)).cwd, 'NOTES.md')
    const read = async (id: string) => readFile(await fileOf(id), 'utf8').catch(() => '')
    superego.agent(defineExtension({
      name: 'notes',
      tools: [defineTool({
        name: 'add_note', description: 'Add a line to NOTES.md.', parameters: obj({ text: str() }),
        async execute({ text }, api) {
          const id = superego.threads.of(api.conversationId)!
          await writeFile(await fileOf(id), `${await read(id)}- ${text}\n`)
          return { output: [{ type: 'text', text: 'Noted.' }] }
        },
      })],
    }))
    superego.method('notes.read', async ({ id }) => ({ text: await read(id) }), { params: obj({ id: str() }) })
    superego.pane('notes', "the thread's NOTES.md; no params")
  },
})
```

```tsx
// ui.tsx: the UI half. A pane, offered in the thread's pane menu.
import { useEffect, useState } from 'react'
import { call, defineUiExtension, type PaneProps } from 'superego/ui'

function Notes({ machine, thread }: PaneProps) {
  const [text, setText] = useState('')
  // Read again as the thread moves on. Until its profile has loaded, `notes.read` isn't there yet: the call fails, and
  // the next one (the thread's next turn) finds it.
  useEffect(() => {
    let live = true
    call<{ text: string }>(machine.id, 'notes.read', { id: thread.id }).then((r) => { if (live) setText(r.text) }, () => {})
    return () => { live = false }
  }, [machine.id, thread.id, thread.activeAt])
  return <pre className="pane-scroll">{text || 'No notes yet.'}</pre>
}

export default defineUiExtension({ name: 'notes', setup: (superego) => superego.pane('notes', { title: 'Notes', component: Notes, menu: true }) })
```

Send a thread a message: the daemon loads the profile and the agent has `add_note`; the window loads its UI when it
shows the thread. After an edit, the daemon half reloads on the thread's next turn, the UI once the thread moves on.

## Cheat sheet

| Daemon half (`superego.` in `setup`) | For |
|---|---|
| `agent(defineExtension({ tools, sections, hooks }))` | the agent's tools, prompt sections and hooks |
| `action(defineAction({ id: 'x.y', params, run }))` | an intent: logged, in ⌘K; `expose: ['ui', 'cli']` for `superego do` |
| `method('x.y', run, { params })` | a read for the UI; params checked first |
| `value('x.y', initial)` → `get`, `set`, `update` | live state the UI watches; in memory |
| `pane(kind, about)` | tell the agent about a pane kind, for `open_pane` |
| `status((thread) => ({ kind: 'question' }))`, `invalidate()` | show a thread as needing you |
| `submit(({ thread, text, attachments, content, by }) => [...content, block])` | add to what a message gives the agent before its turn (a named skill's instructions); return nothing to leave it. `by`: the extension that sent it (`threads.submit`, `threads.create`'s prompt), absent for the user's |
| `settings.register({ id: 'x', settings })`, `settings.get`, `settings.snapshot`, `settings.onChange` | machine settings of its own (`x.…`); read any |
| `dispatch(id, params)`, `actions(exposure)` | run any action on the machine as this extension (`settings.set`); list them |
| `thread({ creating, created, turnStart, turnEnd, blocked, archiving, archived, unarchiving, unarchived })` | take part in a thread's life (below): make it work elsewhere, refuse to archive it, clean up after it, hear it end a run or come to need the user |
| `state()` → `get(id)`, `set(id, next)`, `update(id, edit)` | state of its own kept with each thread, across restarts; `creating` gives a new one its first |
| `facts(({ id, state }) => …)` | what clients are told of a thread, as `thread.ext.<name>`: worked out from its state |
| `agentFor(({ id, state, profile }) => ({ instructions, model, extensions, without }))` | choose a thread's agent; the first to answer wins. `agent(part, { always: false })` gives a part only through this |
| `threads.list({ archived, hidden })`, `get(id)`, `of(conversationId)`, `conversation(id)`, `attachments(id)` | reach threads, and the folder a thread keeps files in |
| `threads.create({ …, parent, hidden, options })`, `submit(id, text)`, `lastAnswer(id)`, `entries(id, limit)`, `archive(id, { whenIdle })`, `unarchive(id)`, `clear(id)` | start and run threads as the thread tools do; `hidden`: in no list, an agent of its own with no profile, that takes no messages while the extension is off (find it by its `owner` in `list({ hidden: true })`, not by its facts, which are gone while the extension is off); `entries`: the newest since it was last cleared, as pi-durable's entry records (not a stable shape); `clear`: start it over |
| `agentsDir`, `dataDir` | the folder agents share (`~/.agents`): skills, `AGENTS.md`; this machine's data folder (`~/.superego`) |
| `harness` | pi-durable itself; unstable |

| UI half (`superego.` in `setup`) | For |
|---|---|
| `slot(name, Component, { order, fallback, fills })` | a component in a place in the window (below); `fallback`: only while nothing fills it; `fills: false`: always drawn, but doesn't count (Ego's rail button, beside which Unread's bell still shows); `thread.crumb` for a chip where the title bar says where a thread works |
| `newThreadField({ component, from })` | a field in the New thread dialog: its value goes to `thread.create` as `options.<name>`, for the daemon half's `creating`; `from(thread)` its value for one started like `thread`; bundled only |
| `on(event, listener)` → off; `window` | hear the window: `thread.status` (`{ machine, thread, before }`; `before` undefined the first time it's seen), `select` (`{ selection, before }`), `focus` (`{ focused }`), `visibility` (`{ visible }`); `window` is `{ focused, visible, selection, thread }` now. In Electron and browsers alike |
| `appSetting(key)` | one of the app's settings as it is now, outside React |
| `pane(kind, { title, component, icon, file, menu, opens, fallback, folders, urls, width })` | a kind of pane beside the thread; `opens`, `folders`, `urls`: files, folders or web pages a thread names open in it; `fallback`: any file nothing else opens |
| `tool(name, { icon, verbs, subject, stat, meta, body, phrase, file, weight }, { fold })` | how calls to a tool look, described: `verbs: ['Read', 'Reading', 'Read failed']`, `subject(call)` after the verb, `body(call)` what it opens to, `phrase(count)` in a run's line ("read 2 files"); the rest default. The core's coding tools and `threads`' thread tools are rows too |
| `tool(name, Component, { fold })` | how calls to a tool look, drawn whole; `fold: false` shows them outside the run's fold (images) |
| `entry(kind, Component)` | transcript entries of a kind it writes |
| `link({ match, open, render, target })` | claim links: `match` a scheme (`'ticket:'`), a pattern, or `(href, kind, where) => boolean` that sees inline code too (`kind: 'code'`); `open(href, { machine, thread, beside, openFile, openUrl })` follows one (a click, ⌃O); `render` draws it; `scheme` names the scheme a pattern or test claims (`'thread'`), so HTML files keep its links. A profile's are asked first, then the bundled ones' (`threads`' `thread:`), the core's (files, `[[wikilinks]]` as `wikilink:`, web pages) last |
| `composer.complete({ title, word(text, caret), items(word, { machine, thread }) })` | complete the word being typed: `word` finds it (`{ start, query }`), `items` offers `{ label, detail, insert }` |
| `composer.sentWith({ read(blocks), component })` | draw what its `submit` put in sent messages under them (a chip): `read` returns `{ items, blocks }`, and those blocks leave the text |
| `work(divide)` | split a run of work into titled parts (tasks); bundled only |
| `action(defineAction({ id, keys, when, run }))` | a window action with keys, in ⌘K while `when(context)` holds; bundled only |
| `store('x.y', initial, { persist })` → `get`, `set`, `use()` | window state its actions and components share |
| `appSettings({ id, settings })` | per-user settings; `useAppSetting(key)`, `context.appSetting(key)`; bundled only |
| `settings(ui, Component)` | draw under a settings section that names `ui` |
| `dispatch(id, params, { machine })` | run any action outside React |

Names: everything is `<extension>.<something>`, except tool and pane kind names. In components: `useSelection`,
`useMachines`, `useSessions`, `useValue`, `useDispatch`, `call`, `has(machine, 'ext:x')` (whether a machine has an
extension set up and switched on now, kept current; UI-only extensions never appear); in panes `<PaneHeader>` and
`useTabNote`; in rows `<ThreadRef machine id>`; `transcriptLinks(machine, thread)`, the links a transcript shows; for a list to pick from (quick open, say), `<Picker label placeholder items filter row onPick onClose digits>`; to build from, `FileEditor`, `Markdown` and `Diff`. Full tables: [daemon.md](../packages/cli/skill/daemon.md), [ui.md](../packages/cli/skill/ui.md).

Machines update at different times, so a window can meet an older or newer daemon. A UI half that calls its daemon
half checks `has(machine, 'ext:x')` first and says so, or offers nothing, when it's missing. A method or action that's
renamed or moved keeps its old name as an alias on the daemon for one release (`MOVED_METHODS` in daemon.ts; a watch
that became a value, `MOVED_WATCHES`; a feature, `MOVED_FEATURES`), so older windows keep working: Ego's `thread.meta`,
`thread.meta.clear` and `meta.watch` answer as `ego.ask`, `ego.clear` and the value `ego.thread`.

## Places in the window

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/places-dark.svg"><img src="writing-extensions/places.svg" alt="The window: rail, sidebar, the thread with its header, transcript and composer.above, thread.aside, panes with the editor's bar and side, and an overlay over everything"></picture>

Thread slots get `{ machine, thread }`; editor slots also `path` and `open(path)`. On a phone there's no rail: `footer`,
under the sidebar beside Settings, takes its place. A profile's UI draws only in its own threads, and not in `sidebar`,
`rail` or `footer`.

## Hearing the window

`on` tells a UI half what happens in the window, whatever it draws. Listening is owned like everything else, and stops
at teardown. A thread that goes without the extension isn't heard of; a profile hears only its own threads.

```ts
// notifications: a thread wants a look while the window is in the background.
superego.on('thread.status', ({ machine, thread, before }) => {
  if (before === undefined || (superego.window.focused && superego.window.visible)) return
  const notice = threadNotice(machine, thread)          // finished, failed or needs you; else nothing
  if (notice) void call('app', 'app.notify', notice)    // the desktop's notification, or the browser's
})
```

`window` is how things are as the event arrives: `focused`, `visible`, the `selection` and the `thread` it shows. The
core marks a finished thread seen the same way, on `select`, `focus` and `thread.status`.

`auth.rejected` is a machine's provider rejecting its credentials (`{ machine, rejection }`, a `ProviderRejection`):
once, however many threads it stops. Those threads are `blocked` with kind `auth` (`waitingForSignIn`), quiet on their
own, and go on by themselves once the machine is signed in again; `threadNotice` says nothing of them, `signInNotice`
says it once for all.

## Lifecycle and ownership

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/lifecycle-dark.svg"><img src="writing-extensions/lifecycle.svg" alt="Set up, registrations owned by the extension, torn down when its profile changes or the daemon stops, then set up again"></picture>

- `setup` may return a cleanup. Registrations need none: teardown removes them all.
- A name is claimed while set up: a second extension of the same name is refused. The core's namespaces (`thread`,
  `value`, `settings`, …) are never free.
- A profile's daemon half loads with its first turn, when a window shows one of its threads, or before an interrupted
  run of it resumes. A project's profile runs only once allowed (`superego profile allow`), as its files and those it
  lists from outside its folder are then. Profiles load one at a time: keep `setup` quick, and never await work that
  loads a profile (starting or reading a thread) in it.
- Profiles that name the same file (one `extends` another, or both list it) share one set-up of it, torn down after
  the last lets go. Each gets its agent parts.
- A change loads between runs, never under one: a thread mid-run keeps what it started with. A profile whose folder
  is gone, or that no longer loads or is allowed, is torn down, and its UI with it. A value torn down reads null.
- A profile's UI from another machine runs in the window only once allowed on this computer (the thread's notice, or
  `superego profile allow-ui <name> -m <machine>`), for a hash the window takes of the sources it received; any change
  to them asks again, and Revoke (Settings → Machines) tears it down at once. Once running it has the window's full
  reach, every machine's `call` and `dispatch` included: it runs in the window's own JavaScript, where narrowing its API
  wouldn't stop it calling `window.superego` directly. Real isolation is the sandboxed tier PLAN.md plans.

## A thread's life

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/thread-life-dark.svg"><img src="writing-extensions/thread-life.svg" alt="creating makes a thread (a hook may move where it works and give it state, or refuse); created; turnStart and turnEnd around each run; archiving then archived on the way to archived, unarchiving then unarchived on the way back"></picture>

```ts
const state = superego.state<{ path: string; branch: string }>()
superego.facts(({ state }) => state)                   // thread.ext.worktrees
superego.thread({
  async creating(draft) {                              // draft.options: what thread.create asked for, by extension
    if (draft.options.worktrees !== true || !draft.checkout) return
    const { path, branch } = await makeWorktree(draft.checkout.top)  // yours: git worktree add
    return { cwd: path, state: { path, branch } }
  },
  async abandoned(draft, made) {                       // a later hook refused it: undo
    if (made) await removeWorktree(made.path)               // yours too
  },
  async archived(thread) {
    const tree = await state.get(thread.id)
    if (tree && await removeIfClean(tree.path)) return { note: 'its worktree is removed' }  // yours too
  },
})
```

- Hooks run in the order extensions were set up (the core's, the bundled ones, then profiles'), one at a time. Not
  for a thread that goes without the extension; a profile's only for that profile's threads (its profile is loaded
  first, so they run after a restart too). Facts and `agentFor` go by the same rule.
- Archiving an archived thread, or unarchiving one in use, does nothing: the hooks see only real changes.
- `creating`, `archiving` and `unarchiving` may refuse by throwing (an `RpcError` says it cleanly): nothing more
  happens, and the hooks after don't run. `creating` may also move where the thread works and give it state, each
  hook seeing the draft as the one before left it. When a later hook refuses (or making the thread fails), those
  whose `creating` already ran are told `abandoned(draft, state)`, in reverse, to undo it: a worktree goes again.
  `draft.options` is what the thread was asked for by extension: its profile's `options`, then `thread.create`'s.
- The others are told, and awaited in turn. A throw there is logged, and the thread carries on. `archived` runs
  before clients see the thread archived, so it's where cleanup goes. `archiving` and `archived` may return
  `{ note }`, what they did in a line ("Removed the worktree …; branch … kept"): `threads.archive` and `thread.archive`
  answer `{ notes }`, each extension's by its name, and `thread_archive` tells the agent them. `turnStart` and `turnEnd` never hold up a run.
- `turnStart` and `turnEnd` are per run, not per message: a message steered or queued into a run that's going is part
  of it. A run resumed after a restart had started already, so it ends with a `turnEnd` alone; one that ended while
  the daemon was down gets neither.
- `blocked` is told when a thread comes to need the user mid-run (an extension's `status`: `ask-user`'s question), once
  each time: when the extension whose status it is calls `invalidate()`.
- A thread archiving itself mid-turn is `threads.archive(id, { whenIdle: true })`: archived once its run ends, even
  across a restart. What its hooks said they did (or why it couldn't be) is then said in the thread, as Superego's
  own note (`superego.note`).
- State is kept in the thread's document under the extension's name, so it persists, and goes with the thread.
  `ThreadMeta.worktree` and `meta`, from before, read as the `worktrees` and `ego` extensions' state until those write
  it (`LEGACY` in daemon.ts), which moves it: a daemon downgraded after that no longer sees it. Ego's thread from before (kept apart, or listed and marked `meta`) is a hidden one now.
  Facts are recomputed whenever the thread's info is; `invalidate()` when something else they read changed. A
  profile's show once its profile has loaded: at startup for the threads in use, else when one of its threads is.
- `agentFor` is called often: quick, and without side effects. The thread's own model wins over its answer, its answer
  over the profile's, and the profile's over the machine's settings. Its instructions last only while it gives them:
  when it no longer answers, the thread's agent has its profile's prompt again, or none. The parts it picks are its own
  extension's, given with `agent(part, { always: false })`. Its `without` is what the thread goes without, its
  agent's parts, panes and UI alike.

Bundled extensions also declare whether they're required, once, in `about` (spread into both halves):

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/required-dark.svg"><img src="writing-extensions/required.svg" alt="A required extension is always on; an optional one can be switched off per machine or left out by a profile, and that thread then has none of its agent parts or UI"></picture>

Only the sidebar (`threads`), `worktrees` (archiving removes a folder and unarchiving puts it back: never switched off
between the two) and the core's `markdown` are required. Everything else is optional, `ego` too, and the core's own
`coding-tools`, `panes` and `agents-md`. A package may be two extensions, one per half,
where the halves differ: `extensions/threads` is the required sidebar in the window, and `thread-tools`, the agent's
thread tools, on the machine, so switching the tools off leaves the sidebar (and the rows and links naming threads).
The core's `panes` is the agent's `open_pane`: switched off, the agent can't open panes, but the window's own pane
kinds stay, being the required core's. An extension with a UI half only needs no daemon half: the window declares it
to each machine, which lists it and lets profiles do without it.

## Real ones to read

| Extension | Shows |
|---|---|
| [`tasks`](../extensions/tasks/src) | the smallest: two tools and a prompt section; a `work` divider |
| [`suggestions`](../extensions/suggestions/src) | a hook, a side call, a live value, a `composer.above` slot |
| [`ask-user`](../extensions/ask-user/src) | a tool that waits on you: `status`, an action to answer, a `tool` view |
| [`images`](../extensions/images/src) | a tool with `{ fold: false }`, files kept with `threads.attachments` |
| [`git`](../extensions/git/src) | Changes: a `method` (a read), a `pane` the agent is told of, built on the kit's `Diff`, an `action` with keys |
| [`web-panes`](../extensions/web-panes/src) | two pane kinds and nothing else; `urls: true` makes web links open in one |
| [`skills`](../extensions/skills/src) | a prompt section, a `submit` transform, a `method`; `composer.complete` and `composer.sentWith` |
| [`files`](../extensions/files/src) | a `method`, a `pane` the agent is told of, an `overlay`, `store`s, `when` |
| [`links`](../extensions/links/src) | UI only: the window declares it to the machine; a `Picker` over `transcriptLinks`, the links handlers drew |
| [`unread`](../extensions/unread/src) | UI only: a `rail` slot as a `fallback`, the phone's `footer`, an action with keys reading sessions, an app setting |
| [`notifications`](../extensions/notifications/src) | UI only: `on('thread.status')`, `on('auth.rejected')` and `window`, `app.notify` (desktop and browser alike), a `composer.above` offer |
| [`threads`](../extensions/threads/src) | the required one: `sidebar`, `rail`, `thread.aside`, app settings, tool rows and a `link`; its daemon half is two other, optional extensions: `thread-tools`, on `superego.threads`, and `thread-reports`, report-back through `turnEnd` and `blocked` hooks, for the runs the parent asked for (told by a submit transform's `by`) |
| [`worktrees`](../extensions/worktrees/src) | `thread` hooks (`creating` moves a thread, `archived` cleans up, `unarchiving` puts back), `state` and `facts`; a `thread.crumb` chip and a `newThreadField` |
| [`ego`](../extensions/ego/src) | an agent of its own: a `hidden` thread, `agentFor` with `agent(part, { always: false })`, an `archiving` refusal, a `value` older windows follow (the rail button reads the selection); a `rail` slot |

Diagram sources are the `.mmd` files in [writing-extensions/](writing-extensions/); re-render with the `diagram` skill
(`bun <skill>/scripts/render.ts x.mmd x.svg`, and `--dark` for `x-dark.svg`).
