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
| `signal` | aborted at teardown: for its own timers, watchers and fetches (below) |
| `pane(kind, about)` | tell the agent about a pane kind, for `open_pane` |
| `view('x.y', { title, icon, context, fits, default, value \| method })` | a view drawn from data (below): no UI code, so a remote machine's or a project profile's runs no code in the window; its buttons still have that machine's authority |
| `status((thread) => ({ kind: 'question' }))`, `invalidate()` | show a thread as needing you |
| `submit(({ thread, text, attachments, content, by }) => [...content, block])` | add to what a message gives the agent before its turn (a named skill's instructions); return nothing to leave it. `by`: the extension that sent it (`threads.submit`, `threads.create`'s prompt), absent for the user's |
| `settings.register({ id: 'x', settings })`, `settings.get`, `settings.snapshot`, `settings.onChange` | machine settings of its own (`x.…`); read any |
| `dispatch(id, params)`, `actions(exposure)` | run any action on the machine as this extension (`settings.set`); list them |
| `thread({ creating, abandoned, created, turnStart, turnEnd, blocked, archiving, archived, unarchiving, unarchiveAbandoned, unarchived })` | take part in a thread's life (below): make it work elsewhere, refuse to archive it, clean up after it, hear it end a run or come to need the user |
| `state()` → `get(id)`, `set(id, next)`, `update(id, edit)` | state of its own kept with each thread, across restarts; `creating` gives a new one its first |
| `facts(({ id, state }) => …)` | what clients are told of a thread, as `thread.ext.<name>`: worked out from its state |
| `agentFor(({ id, state, profile }) => ({ instructions, model, extensions, without }))` | choose a thread's agent; the first to answer wins. `agent(part, { always: false })` gives a part only through this |
| `threads.list({ archived, hidden })`, `get(id)`, `of(conversationId)`, `conversation(id)`, `attachments(id)` | reach threads, and the folder a thread keeps files in |
| `threads.create({ …, parent, hidden, options })`, `submit(id, text)`, `lastAnswer(id)`, `entries(id, limit)`, `archive(id, { whenIdle })`, `unarchive(id)`, `clear(id)` | start and run threads as the thread tools do; `hidden`: in no list, an agent of its own with no profile, that takes no messages while the extension is off (find it by its `owner` in `list({ hidden: true })`, not by its facts, which are gone while the extension is off); `entries`: the newest since it was last cleared, as pi-durable's entry records (not a stable shape); `clear`: start it over |
| `agentsDir`, `dataDir` | the folder agents share (`~/.agents`): skills, `AGENTS.md`; this machine's data folder (`~/.superego`) |
| `harness` | pi-durable itself; unstable |

| UI half (`superego.` in `setup`) | For |
|---|---|
| `view('x.y', { title, icon, context, fits, default, narrow, withoutSpaces, order, component, rail, width })` | UI the layout puts in places (below): a space, a rail button, beside the thread, the pane menu, the title bar; `default` where it goes unless the user moves it |
| `slot(name, Component, { order })` | a component in a slot whose place behaviour decides (below): `thread.crumb` for a chip where the title bar says where a thread works, `composer.above`, `editor.side`, `editor.bar`, `overlay`. The old places (`sidebar`, `rail`, `footer`, `thread.aside`, `thread.header`) still work: each declares a view of that place, `<extension>.<slot>` |
| `newThreadField({ component, from })` | a field in the New thread dialog: its value goes to `thread.create` as `options.<name>`, for the daemon half's `creating`; `from(thread)` its value for one started like `thread`; bundled only |
| `signal` | aborted at teardown (its profile's UI reloaded or revoked): for its own timers, listeners and fetches (below) |
| `on(event, listener)` → off; `window` | hear the window: `thread.status` (`{ machine, thread, before }`; `before` undefined the first time it's seen), `select` (`{ selection, before }`), `focus` (`{ focused }`), `visibility` (`{ visible }`); `window` is `{ focused, visible, selection, thread }` now. In Electron and browsers alike |
| `appSetting(key)` | one of the app's settings as it is now, outside React |
| `pane(kind, { title, component, icon, file, menu, opens, fallback, folders, urls, width })` | a kind of pane beside the thread; `opens`, `folders`, `urls`: files, folders or web pages a thread names open in it; `fallback`: any file nothing else opens |
| `tool(name, { icon, verbs, subject, stat, meta, body, phrase, file, weight }, { fold })` | how calls to a tool look, described: `verbs: ['Read', 'Reading', 'Read failed']`, `subject(call)` after the verb, `body(call)` what it opens to, `phrase(count)` in a run's line ("read 2 files"); the rest default. The core's coding tools and `threads`' thread tools are rows too |
| `tool(name, Component, { fold })` | how calls to a tool look, drawn whole; `fold: false` shows them outside the run's fold (images) |
| `entry(kind, Component)` | transcript entries of a kind it writes |
| `link({ match, open, render, target, scheme })` | claim links: `match` a scheme (`'ticket:'`), a pattern, or `(href, kind, where) => boolean` that sees inline code too (`kind: 'code'`); `open(href, { machine, thread, beside, openFile, openUrl })` follows one (a click, ⌘-click `beside`, ⌃O); `render` draws it; `scheme` names the scheme a pattern or test claims (`'thread'`), so HTML files keep its links. Claiming files, `[[wikilinks]]` or web pages overrides the core's: [Links](#links) |
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
extension set up and switched on now, kept current; UI-only extensions never appear; `'ext:x@^1.2'` at a version in
a range, see [Versions and compatibility](#versions-and-compatibility)), `version(machine, 'x')`; in panes `<PaneHeader>` and
`useTabNote`; in rows `<ThreadRef machine id>`; `transcriptLinks(machine, thread)`, the links a transcript shows; for a list to pick from (quick open, say), `<Picker label placeholder items filter row onPick onClose digits>`; to build from, `FileEditor`, `Markdown` and `Diff`. Full tables: [daemon.md](../packages/cli/skill/daemon.md), [ui.md](../packages/cli/skill/ui.md).

Machines update at different times, so a window can meet an older or newer daemon: a UI half that calls its daemon
half checks `has(machine, 'ext:x@<range>')` first, and says so, or offers nothing, when it's missing. See
[Versions and compatibility](#versions-and-compatibility).

## Versions and compatibility

Three versions, each for its own question:

| Version | What it versions | Where it's said | Who checks it |
|---|---|---|---|
| **The release** | the code a machine runs: its git commit (the packages are `0.0.0`) | `hello.machine.commit`, Settings → Machines ("an older Superego") | the user, who updates |
| **The extension API** | what the host gives extensions: `superego.` in either half, `'superego'`, `'superego/ui'`; semver, `EXTENSION_API` (`1.1.0`; 1.1 added `signal`, a UI `setup`'s cleanup and `unarchiveAbandoned`) | `hello.api` | the host, setting an extension up |
| **The protocol** | the wire: a generation, `PROTOCOL_VERSION` (`1`), and in it the features each side announces | `hello.version`, `hello.features` | both ends, at `hello` |

And each extension's own **version**, semver, which its other half, profiles and scripts rely on.

### Declaring them

An extension says its version and the extension API it needs in `about` (bundled), or in its definition (a profile's):

```ts
export const about = { name: 'orders', version: '1.2.0', api: '^1', title: 'Orders' } satisfies ExtensionAbout
```

- `version`: a **major** when something relying on its methods, actions, values or data views could no longer follow
  (a method's result changes shape, an action goes); a **minor** when something's added; a patch otherwise. Bundled
  extensions started at `1.0.0`. Unset: it counts as `0.0.0`.
- `api`: the range of extension APIs it works with: `^1` for any 1.x, `^1.3` once it uses something 1.3 added. A host
  outside the range refuses it before `setup` runs, with why: *Extension orders needs extension API ^2, and this
  Superego has 1.1.0: update Superego*. A bundled one fails the build's tests; a profile's fails its profile's load
  (the thread says so); a profile UI's is left out, the rest of the profile set up. Unset: any.
- `capabilities`: optional, finer than a version: things it can do that a client may ask about (`['stat']`).

The host's `EXTENSION_API` goes up a minor when the API grows, and a major when something an extension could rely on
changes or goes, which also moves every bundled extension's `api`.

### Checking them

Each daemon announces, for every extension set up and on there, `ext:<name>` in `features` (as before) and its
manifest (`{ name, version, api, capabilities }`) in `hello.extensions`, both kept current by `features.changed`. In
the window:

```ts
has(machine, 'ext:git')          // set up and on there, at any version
has(machine, 'ext:git@^1.2')     // at 1.2 or later in 1.x
has(machine, 'ext:git@<2')       // any version this UI half speaks, a daemon from before versions too
has(machine, 'ext:git#stat')     // one that declares the capability
version(machine, 'git')          // '1.3.0'; '0.0.0' when it says none; undefined when it isn't there or is off
```

Ranges are the usual ones: `^1.2`, `~1.2`, `>=1.2 <3`, `1.2` (1.2.x), `*`, joined with `||`. A UI half checks the
daemon half by the majors it speaks (`git` and `skills` ask for `@<2`); a shape that changed in a minor, by `@^1.<minor>`.
`ask-user` takes options as objects only from `@^1`, and from a daemon from before versions maps plain labels too.

Windows declare their extensions to each machine (`extensions.declare`), so one with no daemon half is listed there.
When two windows declare one differently, the newest version's word is taken, whatever order they connect in (at the
same version, the two are settled by what they say, the same way each time); an older window's never takes it back.

### The skew policy

What a window and a daemon of different releases do with each other:

- **Another protocol generation:** refused at `hello` (`version_mismatch`: *Update superego on the older side*).
  A generation changes only for a break nothing can bridge, and starts with no aliases.
- **The same generation:** they work together. The core's methods, actions, notifications and features only grow in
  a generation: `RELEASED` (`packages/protocol/src/released.ts`) lists what generation 1 released, and a test holds
  the daemon to answering all of it. Add to it as things are released; nothing leaves it but with a new generation.
  Anything newer is announced in `FEATURES` and checked with `has` before it's used.
- **A newer window, an older daemon:** the window checks what it uses (`has(machine, 'threads')`,
  `has(machine, 'ext:git@<2')`), and offers nothing, or says so, where the daemon lacks it. A daemon from before
  versions announces no manifests: its extensions are there, at `0.0.0`.
- **An older window, a newer daemon:** the daemon keeps what it moved or renamed answering by the old name, for a
  while: the aliases in `ALIASES` (`packages/protocol/src/compat.ts`: `thread.diff` as `git.diff`, the `ego` feature,
  `ThreadInfo.worktree`…). An extension a major ahead of what the window's UI half speaks is left alone by it.
- **How long aliases live:** each has a milestone (`until`), three months or so after the move, and goes then, or
  with the next generation if that's sooner. A test fails once one is past it: take the entry out, and the code that
  keeps it (the daemon's `MOVED_*` are read from the table). So the skew supported is a window and a daemon of the
  same generation released within an alias's lifetime of each other; further apart, the newer side's checks still
  hold, but what moved is gone.
- **Stored data is not the wire:** what an older release stored (a thread's state in the core's old fields, Ego's
  thread from before hidden threads, a setting or a shortcut under an old name, a profile's `without: ['threads']`)
  is read through by the migrations in `MIGRATIONS`, kept for as long as data from before may still be opened. A
  protocol generation doesn't remove one.

## Links

A link in a message, in ⌃O's list, or in a Markdown file (rendered, or clicked in live preview) is followed by the
first handler that claims it, asked in this order:

1. **the thread's profile's** (its `ui` files' `superego.link`), only in that profile's threads;
2. **the extensions'**, in the order they're set up, but not those of an optional one the thread goes without
   (`threads` claims `thread:`);
3. **the core's**, the defaults: files a thread names (relative links, inline code that reads as a path, and
   `wikilink:`), which open in the pane kind that takes the file, and web pages (`http:`, `https:`, `mailto:`), which
   open in the browser, or beside in a pane that shows web pages (`urls: true`, `web-panes`' Preview).

A link no handler claims opens in the browser; an HTML link of a scheme none claims there is dropped. So to open
links your own way, claim them: nothing else to switch off. `[[Note#Heading|alias]]` reaches handlers as
`wikilink:Note#Heading` (each part URI-encoded), saying "alias"; `parseWikilink(href)` gives
`{ target: 'Note', heading: 'Heading' }` (or `block` for `#^id`). A profile that keeps notes its own way, say:

```tsx
// In a profile's ui/note.tsx: [[wikilinks]] open the vault's own note pane, found by the vault's rules.
superego.link({
  match: 'wikilink:',
  open(href, { machine, thread }) {
    const { target, heading } = parseWikilink(href)!
    return superego.dispatch('pane.open', { id: thread!.id, kind: 'note', params: { path: target, heading } }, { machine })
      .then(() => undefined, (error: Error) => error.message)
  },
  target: (href) => parseWikilink(href)!.target,
})
```

Return (or resolve to) a string to say why it couldn't: the link is struck through with it. Claiming files is the
same with a test: `match: (href, kind) => /\.md$/.test(href)` takes Markdown links and paths in code alike, ahead of
the core's. The core's file and web handlers stay the core's rather than `files`' or `web-panes'`: both extensions
are optional, and a link to a file or a page has to work in a thread that goes without them.

## Views and the layout

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/places-dark.svg"><img src="writing-extensions/places.svg" alt="The window: the rail and the open space beside it, the thread with its header, transcript and composer.above, the aside, panes from the pane menu with the editor's bar and side; the title bar's stand-in, a phone's drawer and an overlay over everything"></picture>

An extension declares **views**: what it offers, and the kinds of place each fits. The shell has **places**, and knows
no extension. The **layout** decides what goes where: each view's `default`, then the user's changes, kept in the app
setting `app.layout` as `app.keys` keeps shortcuts.

```ts
superego.view('threads.list', { title: 'Threads', icon: ChatsIcon, context: 'window', fits: ['space'], default: 'space', component: Threads, rail: ThreadsRail })
superego.view('threads.details', { title: 'Thread details', context: 'thread', fits: ['aside', 'pane'], component: DetailsPane })
superego.view('ego.button', { title: 'Ask Ego', icon: LifebuoyIcon, context: 'window', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10, component: EgoButton })
```

| Place | What it is | A view there gets |
|---|---|---|
| `space` | a button in the rail (its `icon`, or its own `rail` component), and the sidebar while it's the open one; on a phone, the drawer | `{ place }`; a `thread` view, the thread shown |
| `rail` | a button in the rail that isn't a space (Ego's) | `{ place }` |
| `drawer` | on a phone, at the drawer's foot beside Settings, where there's no rail | `{ place }` |
| `titlebar` | at the title bar's start: what stands in for a space while there's none (the core's thread picker) | `{ place }` |
| `aside` | a column beside the thread | `{ place, machine, thread }` |
| `pane` | the thread's pane menu: a `thread` view that fits `pane` is a pane kind of its id | `{ place, machine, thread }` |
| `header` | right of the thread's title: a button, a badge | `{ place, machine, thread }` |

- `default` is a place, several, or none (offered, not placed: the user puts it somewhere). `narrow` is where it goes
  on a phone instead. `withoutSpaces` is where it goes while no view is in `space` (Unread's bell in the rail, the core's
  picker in the title bar).
- `app.layout` holds only what the user changed: `{ place: { 'threads.details': 'aside', 'ego.button': null }, order:
  { pane: ['git.changes'] }, narrow: { place: { … } } }`. A view it names that isn't there (an extension removed) is
  ignored, and a place a view doesn't fit is too. A view can be in two places at once.
- What the user says beats what a view says, and on a phone the phone's layer beats the wide one. On a phone a view
  goes where `narrow` in the layout puts it; else where `place` does (hidden is hidden everywhere; a place a phone
  doesn't draw, the rail, gives way to the view's own `narrow`); else its `narrow`; else its `default`.
- The layout names views by id, whatever scope declares them: a profile's view on two machines is one entry. A
  thread's places are resolved from the views that thread sees, its profile's (on its machine) over the app's, so each
  id is there once, as that scope declares it.
- To put a view in a place or take it out, dispatch `layout.place` with `{ view, place, on? }` (toggled without
  `on`); `from` takes it out of that place in the same change (moved), `narrow` changes the phone's layer. In a
  component, `usePlacement(view, place)` gives `[placed, toggle]`. ⌘I is `threads.details` in the `aside`, or not.
- The user edits the layout as text: *Edit layout…* (⌘K) opens `~/.superego/layout.json`, `app.layout` as a file,
  applied as it's saved; a mistake (bad JSON, a place there isn't, a place a view doesn't fit) is noted and the last
  good layout stays, and the file is left as typed until it reads. A view it names that no window has now is applied
  all the same and only noted, for when it's back. Its head of `//` comments lists the views the windows declared and
  the places each fits, and `superego layout` prints it; comments of your own below it are kept. For example:

  ```jsonc
  {
    "place": { "threads.details": "aside", "files.folder": ["space", "pane"], "ego.button": null },
    "order": { "pane": ["files.folder", "git.changes"] },
    "narrow": { "place": { "threads.details": "pane" } }
  }
  ```

  A right-click on a view in the window (its ··· beside the thread or in a pane) has *Move to*, *Remove from here* and
  *Edit layout…*. ⌘K offers each view in each place it fits and isn't in (*Show Files beside the thread*), and *Reset
  layout*. Settings → General → Layout has *Edit layout…* and *Reset*, and no layout can take Settings away: the
  rail always has it, and a phone's drawer, or its top bar while there's no space. A browser keeps its layout itself:
  there *Edit layout…* opens it in a dialog. So `default` is only where a view starts. Draw it to work in every place it `fits`
  (read `place` when it must differ: a menu's side, a button's size), never assume another view sits beside it, and
  don't keep a setting of your own for where it shows: `usePlacement` and `layout.place` are that setting. Declare
  only the places it can really be drawn in.
- `pane(kind, { menu: true })` is a view of the pane menu, of the kind's name, placed there by default.
- A profile's views fit only the places that show a thread (`aside`, `pane`, `header`), in its own threads.

Slots are places that behaviour decides, so the layout doesn't move them: a question card sits on the composer it asks
for. They get `{ machine, thread }`; the editor's also `path` and `open(path)`. `superego.slot` in one of the old places
(`sidebar`, `rail`, `footer`, `thread.aside`, `thread.header`) declares a view of that place, `<extension>.<slot>`,
placed there by default: its `sidebar` is a space, its `footer` the `drawer`.

### Data-only views

A daemon half can declare a view as data, and the window draws it with its own components: no UI code ships, so a
remote machine's, or a project profile's, needs no consent to run code in the window, as its UI code would. That's
not no authority: its buttons run that machine's actions. The content is a few fixed parts,
any of them, top to bottom: a `note`, `facts` (label and value), `items` (a list: `title`, `subtitle`, `detail`,
`status`, a `thread` to link, `actions`), a `table` (`columns`, `rows`), `markdown`, and `actions` (buttons), with
`empty` for when there's none. A button runs one of the extension's own actions (`<extension>.<name>`) on that
machine, as the window may (one exposed to `ui`); a button naming any other is left out.

```ts
// orders.ts, a daemon half: the open orders, as a space, with a button on each
const open = superego.value<ViewContent>('orders.open', { items: [], empty: 'No open orders.' })
const show = (orders: Order[]) => open.set({
  note: `${orders.length} open`,
  items: orders.map((o) => ({ id: o.id, title: `No. ${o.id}`, subtitle: o.customer, status: o.late ? 'blocked' : 'idle',
    actions: [{ title: 'Ship', action: 'orders.ship', params: { id: o.id } }] })),
})
superego.action(defineAction({ id: 'orders.ship', title: 'Ship an order', params: obj({ id: str() }), run: async ({ id }) => show(await ship(id)) }))
superego.view('orders.open', { title: 'Orders', icon: 'list', context: 'window', fits: ['space', 'aside'], default: 'space', value: 'orders.open' })
```

- The source is a live value of the extension's (`value`), or a method of its (`method`), read again as the thread
  moves on and after a button ran. A `thread` view's value holds each thread's content by its id, and its method is
  called with `{ id }`.
- Data views fit `space`, `aside` and `pane` (a `window` view: `space` and `aside`), and the layout places them as any
  other. A `thread` view in `pane` is a pane kind of its id; with `about`, the agent is told it can open it.
- The window hears of them as every daemon's live value `view.list`. A view a machine's extension declares shows a
  thread only from that machine, and a `window` view gathers every machine's, each under its name. A profile's fit only
  `aside` and `pane`, in its own threads. An extension's UI half that declares a view of the same id draws it instead.
- The window checks what it's sent as it lands, not on the machine's word: a declaration must be of one of that
  machine's extensions that's on, named for it (its id and its source `<extension>.<name>`), in places there are (a
  profile's never a space), and within bounds (how many views, items, rows and columns, how long a string, how deep
  and big a button's params). Content is held to the same. What isn't is left out, with a warning on the console and,
  for content, a quiet word in the view; a view that throws as it draws says so in its place, with Try again.
- The `skills` extension's *Skills* is one (`extensions/skills/src/daemon.ts`).

### On a phone

Below 600px wide there's no rail and no title bar. `space` views are the drawer, with the others to switch to at its
foot beside `drawer` views (Ego, Unread) and Settings. The thread's title opens its **sheet**, which holds the title
bar's (`header` views, where it runs, archiving), the pane menu, and the `aside` views. With no space there's no
drawer: `titlebar` views (the thread picker) and Settings are in the bar at the top instead.
`narrow` moves a view elsewhere on a phone.

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

Each set-up of an extension, in either half, has one lifetime: everything it registers is owned by it, and teardown
(its profile reloaded or gone, its UI revoked, the daemon stopping) ends all of it at once.

- Teardown aborts `superego.signal`, then runs `setup`'s cleanup (if it returned one), then undoes every registration,
  last first. Each step is tried whatever the others do: a cleanup that throws is logged, and the rest still goes, its
  name too, so the next version sets up. Torn down twice, nothing more happens.
- Registrations need no cleanup. What isn't a registration does: a timer, a watcher, a fetch, a listener on something
  of its own. Give it the signal (`setInterval` cleared on `abort`, `watch(path, { signal })`, `fetch(url, { signal })`,
  `addEventListener(…, { signal })`), or return a cleanup that stops it. A listener on the signal that throws is logged as
  the extension's, and the others are still told.
- What it registers after teardown is refused: the call throws, and nothing is left behind. A live value's `set` and
  `update` from work that outlived it (a reply that came late) do nothing, with a warning once, so they never change
  what the next version publishes; its `get` reads what it last set.
- A daemon half's `setup` that takes longer than 15s is given up on: torn down (its signal aborted), and the profile
  it's in fails to load with a message saying so, so profiles behind it load. A profile whose modules hang as they load
  is given up on the same way.
- What a UI half draws is drawn apart: each view, slot, space, pane, tool row, entry, settings component, New
  thread field and link a handler `render`s in a boundary of its own. One that throws shows "<extension> failed to draw", its error and Retry, in
  its place; the rest of the window carries on.
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
- What a reload runs: a profile's daemon modules load by versions of their own, each the hash of the module and every
  local file it imports, so an edit to a helper alone loads the new code, and that of whatever imports it. A module none
  of whose files changed is the one loaded before, its module-level state with it (keep state in `setup`, which runs
  again); a helper two extensions import is one module, as ever. Packages (bare imports, `node_modules`) load once:
  restart the daemon for a new version of one. An import whose path is worked out as it runs isn't seen: it's loaded
  again only with the module importing it. The window loads a profile's UI modules afresh, all of them, whenever any of
  the profile's files changed.
- What allowing a project's profile vouches for is what it runs: its folder's files, and the local files its code
  imports from outside it; a file it lists from outside, with what that imports.
- A profile's UI from another machine runs in the window only once allowed on this computer (the thread's notice, or
  `superego profile allow-ui <name> -m <machine>`), for a hash the window takes of the sources it received; any change
  to them asks again, and Revoke (Settings → Machines) takes out what it registered at once. Once running it has the window's full
  reach, every machine's `call` and `dispatch` included: it runs in the window's own JavaScript, where narrowing its API
  wouldn't stop it calling `window.superego` directly. Real isolation is the sandboxed tier PLAN.md plans.

### What each trust level means

- **A data-only view** (`superego.view` in a daemon half): no code of the extension's runs in the window, so it asks
  no consent to, and what it sends is checked where it lands. Its buttons still have that machine's authority: they
  run its extension's actions there, as the window may.
- **A remote profile's UI**, once allowed: runs in the window's own JavaScript, with the window's full authority over
  every machine it reaches. Allowing it is trusting that code as much as the window itself.
- **Revoke** takes out what that UI registered (views, panes, actions, slots), aborts its `signal` and runs its
  `setup`'s cleanup, so what it stopped with those stops. It can't undo what its code already did, or stop what it left
  going otherwise (a timer it didn't tie to either, a global, a request). The window offers a reload, which does; what
  was done stays done.
- A **daemon half** (a profile's or the app's) runs with Node's full access on its machine, as this computer's profiles
  trust their daemon (a project's once `superego profile allow`ed).

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
  Likewise, when a later `unarchiving` refuses (or bringing the thread back fails), those whose `unarchiving` already
  ran are told `unarchiveAbandoned(thread)`, in reverse, to undo what they put back; the thread stays archived.
  `draft.options` is what the thread was asked for by extension: its profile's `options`, then `thread.create`'s.
- The others are told, and awaited in turn. A throw there is logged, and the thread carries on. `archived` runs
  before clients see the thread archived, so it's where cleanup goes. Hooks aren't a transaction: archiving goes on
  past a cleanup that failed, and may be tried again (a restart between), so make cleanup idempotent, and safe to find
  half done. `archiving` and `archived` may return
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
| [`unread`](../extensions/unread/src) | UI only: a view in the rail `withoutSpaces` and in a phone's `drawer`, an action with keys reading sessions, an app setting |
| [`notifications`](../extensions/notifications/src) | UI only: `on('thread.status')`, `on('auth.rejected')` and `window`, `app.notify` (desktop and browser alike), a `composer.above` offer |
| [`threads`](../extensions/threads/src) | the required one: views (the list a `space` with a `rail` of its own, details in the `aside` with ⌘I, the model in the `header`), app settings, tool rows and a `link`; its daemon half is two other, optional extensions: `thread-tools`, on `superego.threads`, and `thread-reports`, report-back through `turnEnd` and `blocked` hooks, for the runs the parent asked for (told by a submit transform's `by`) |
| [`worktrees`](../extensions/worktrees/src) | `thread` hooks (`creating` moves a thread, `archived` cleans up, `unarchiving` puts back), `state` and `facts`; a `thread.crumb` chip and a `newThreadField` |
| [`ego`](../extensions/ego/src) | an agent of its own: a `hidden` thread, `agentFor` with `agent(part, { always: false })`, an `archiving` refusal, a `value` older windows follow (the rail button reads the selection); a view in the `rail`, and in a phone's `drawer` |

Diagram sources are the `.mmd` files in [writing-extensions/](writing-extensions/); re-render with the `diagram` skill
(`bun <skill>/scripts/render.ts x.mmd x.svg`, and `--dark` for `x-dark.svg`).
