# The UI half

New here? Start with [the guide](guide.md) and the [cheat sheet](cheatsheet.md).

A profile's UI runs in the window, in that profile's threads on the machine it came from: panes, views beside a
thread, slots, and how its tool calls look. List modules in the profile's `ui`; each default-exports
`defineUiExtension`. What a module registers goes when the profile's files change and the window reloads them.

## When the UI loads

The window loads a profile's UI as soon as it lists one of its threads (sidebar or navigator), not when one is opened,
so its marks, slots, tool rows and pane kinds are there from the start.

- Archived and hidden threads don't count.
- A project's own allowed profiles load as soon as the project is listed, whatever its threads run, so its
  [spaces](window.md#spaces) are there; and again when one of them is allowed (`profile.allow`).
- It loads once per profile per machine, and loads the profile's daemon half too.
- Another machine's profile loads this way only if its UI was allowed here before; otherwise when a thread of it is
  opened, which asks.
- It stays loaded until the window reloads, and shows only on its own threads.
- After an edit, it reloads when a shown thread of it moves on: send that thread a message.

## A first module

```tsx
// .superego/profiles/support/ui/order.tsx
import { defineUiExtension, PaneHeader, PaneMessage, PaneNote, FileTextIcon, useMethod, type PaneProps } from 'superego/ui'

function OrderPane({ machine, thread, pane }: PaneProps) {
  const { id } = (pane.params ?? {}) as { id?: string }
  // A read: the daemon half's method (superego.method), not an action; again as the thread moves on.
  const { data: order, error } = useMethod<any>(machine.id, 'orders.find', { number: id }, { enabled: Boolean(id), refresh: thread.activeAt })
  if (error) return <PaneMessage>{error.message}</PaneMessage>
  if (!order) return <PaneMessage>Loading…</PaneMessage>
  return <div className="order-pane"><PaneHeader><PaneNote>{order.status}</PaneNote></PaneHeader><h2>Order {id}</h2>…</div>
}

export default defineUiExtension({
  name: 'support-ui',
  setup(superego) {
    superego.pane('order', { title: (pane) => `Order ${(pane.params as any)?.id ?? ''}`, icon: FileTextIcon, component: OrderPane })
    // A row: "Found order 1234 · shipped", folded open to what the tool said.
    superego.tool('find_order', {
      icon: FileTextIcon, verbs: ['Found', 'Finding', 'Couldn’t find'],
      subject: ({ call }) => `order ${call.arguments.number}`,
      meta: ({ result }) => (result?.details as { status?: string } | undefined)?.status,
      phrase: (count) => count === 1 ? 'found an order' : `found ${count} orders`,
    })
  },
})
```

Then in `profile.ts`: `ui: ['./ui/order.tsx'], panes: { order: 'an order, with its lines. Params: { id }' }` (or
`panes` in a daemon half's `defineDaemonExtension`). The agent opens it with
`pane_open({ kind: 'order', params: { id: '1234' } })`; you with
`superego do pane.open --params '{"thread":"<thread>","kind":"order","params":{"id":"1234"}}'`.

## What a module can import

- `'react'`, `'react/jsx-runtime'`, `'react-dom'`, `'react-dom/client'`: the window's own (React 19).
- `'superego/ui'`: the stable surface. `'superego/unstable'`: the window's workings (`useRegistry`, `useShell`, …),
  which change with it.
- Its own files by relative path (`'./chart.ts'`), `.js` too: vendor a library as one ESM bundle with React external
  (`esbuild --bundle --format=esm --external:react --external:react-dom …`).

Nothing else: no npm packages, no CSS imports. The daemon compiles TSX and TS without type-checking;
`superego extension test` checks.

## The setup API

| | |
|---|---|
| `pane(kind, { title, component, icon?, file?, menu?, opens?, fallback?, folders?, urls? })` | a kind of pane. `title`: a string or `(pane) => string`. `component` gets `{ machine, thread, pane }` (`pane.params`: what it was opened with). `icon`: a Phosphor icon for its tab. `file: true`: its title is a file name. `menu: true`: in the pane menu (needs no params). `opens: (path) => boolean`: files named in a thread open in it, ahead of the editor (`/\.csv$/.test(path)`); `fallback: true`: any file no kind `opens`; `folders: true`: folders (`params.path`, `''` for the thread's own); `urls: true`: web pages opened beside (`params.url`). |
| `space(kind, { title, component, icon?, match?, params?, about?, profile?, agent? })` | a view filling the main area, with a thread docked beside it: an app extension's, a global profile's, or a project's profile's (its project's); not your other profiles' ([window.md](window.md#spaces)) |
| `view(id, { title, icon?, context, fits, default?, component, order? })` | a view `<name>.<view>` the layout places. A profile's fits `beside`, `pane` (the pane menu; also a pane kind of its id) or `header`. `context: 'thread'`: `component` gets `{ place, machine, thread }`. `default`: a place, several, or none (offered only). The user can move or hide it, so don't assume where it is ([window.md](window.md#views-and-the-layout)) |
| `slot(slot, component, { order? })` | a component in a [slot](#slots) |
| `tool(name, row, { fold? })` | how a tool's calls look: [Tool rows](#tool-rows) |
| `tool(name, component, { fold? })` | draw a tool's calls yourself: [Tool rows](#tool-rows) |
| `link({ match, open, render?, target?, scheme? })` | claim links: [Links](window.md#links) |
| `on(event, listener)` | hear the window, returns an unsubscribe (teardown unsubscribes too): `'thread.status'` `{ machine, thread, before }` (`before` undefined the first time; your profile's threads only), `'select'` `{ selection, before }`, `'focus'` `{ focused }`, `'visibility'` `{ visible }`. `superego.window` is now: `{ focused, visible, selection, thread, machines, threads }` (`threads`: each machine's in use) |
| `style(css)` | CSS scoped to what this profile draws ([Styling](#styling)); returns a remover |
| `theme({ id, name, appearance, syntax?, terminal?, ui?, accent? })` | (API ^5.5) a theme ([Themes](#themes)) |
| `store(key, initial, { persist?, shared? })` | window state: `get()`, `set(next)`, `subscribe`, `use()`. Kept as `<name>.<key>` (`'<name>.<key>'` is the same store). `persist`: across reloads, this window only; `shared`: every window |
| `composer.complete({ title, word, items })` | complete a word as it's typed. `word(text, caret)` finds it (`{ start, query, … }`) or nothing; the first to find one completes it, with any other that finds one starting at the same place (one menu: `/` opening the message lists the core's `/clear` and `/compact` beside skills). `items(word, { machine, cwd, thread })` returns (or resolves to) `{ label, detail?, icon?, insert, submit? }[]`, best first (no `thread` in New thread). `insert` replaces the word (end with a space to keep typing); `submit: true`, a command: ⏎ takes it and sends the message. ↑↓ pick, ⇥ or ⏎ take, esc leaves |
| `composer.sentWith({ read, component?, words? })` | draw what `beforeSend` added to sent messages. `read(blocks)` returns `{ items, blocks }`, the indexes of the blocks found, which leave the text. `component` gets `{ machine, thread, items }`, drawn under the message (a `<Chip icon title>` each). `words(text, items)` rewrites the message's Markdown (`mentions` turns `@thread:42` into a link). Drawn even for threads now without the extension |
| `entry(kind, component)` | transcript entries of a kind it writes |
| `codeBlock(languages, component)` | (API ^5.14) draw fenced code blocks of a language yourself: [Code blocks](#code-blocks) |
| `settings(ui, component)` | drawn below the daemon half's settings section that names `ui` |
| `appSetting(key)` | an app setting now, outside React (`useAppSetting` in components) |
| `dispatch(id, params, { machine })` | run an action outside React |
| `signal` | aborted at teardown (files changed, revoked). `setup` may also return a cleanup. Registering after throws |

Each component draws apart: one that throws shows "<name> failed to draw" with Retry, in its place. Window places (sidebars,
the rail) are for bundled extensions and global profiles; work dividers, app settings and New thread fields for bundled
extensions only ([bundled](bundled.md)). A window action (`defineAction` with `keys`) is in the
[cheat sheet](cheatsheet.md).

### Tool rows

`tool(name, { icon?, verbs?, verb?, subject?, stat?, meta?, body?, phrase?, file?, weight? }, { fold? })` describes a
row; what's left out (or returns `undefined`) is the default: its name, its `command`/`path`/`pattern`, its output.

| | |
|---|---|
| `verbs` | done, working, failed: `['Read', 'Reading', 'Read failed']`; `verb(call)` for a call's own |
| `subject` | what it acted on, after the verb: text (in mono) or a node (`<ThreadRef machine id />`); `null`: nothing |
| `stat` | `{ added, removed }` lines |
| `meta` | a little more at the row's end |
| `body` | what it opens to; `null`: nothing |
| `phrase(count)` | what `count` calls did, in a run's line (`read 2 files`) |
| `file(args)` | the one file a lone call was about |
| `weight` | which kind leads a run's line |
| `fold: false` | show calls open under their run, not folded in (as `images` does) |

The functions get the call and its `state` (`idle`, `working`, `done`, `error`).

`tool(name, Component, { fold? })` draws calls whole. It gets `{ machine, thread, call: { id, name, arguments },
result?: { text, isError, details, images? }, live?: { status, output, details } }`. `text` is the output then a failed
call's error, as the user should read it (not the model's `<harness>` wrapper). `images` are `ImageItem`s (`entry`,
`mimeType`, `width`, `height`; no pixels): read one with `call(machine.id, 'image.read', { thread: thread.id, image:
{ entry: entry.id, message: entry.message, block: entry.block }, thumbnail: true })` → `{ data, mimeType }`, base64
(leave out `thumbnail` for the whole).

`tool('mcp__*', …)`: a name ending in `*` is a prefix, for tools without a row of their own; the longest wins, and its
tools count as one kind in a run's line.

If two modules draw the same tool, the first stays (with a console warning); a profile's own wins over a bundled
extension's in its threads.

### Slots

Each gets `{ machine, thread }`; the editor's also `path` and `open(path)`.

| Slot | |
|---|---|
| `header.chips` | among the chips saying where a thread works (a branch): a `<HeaderChip title>` |
| `thread.badge` | after a thread's title in the sidebar: a `<ThreadBadge label>` around a 12px icon, or nothing ([below](#a-mark-in-the-sidebar)) |
| `thread.menu` | (API ^5.13) a thread's row menu in the sidebar (right-click), and on a phone its sheet: `<ThreadMenuItem icon keys onClick>` items, which take either shape (`keys`: an action's id, for its shortcut) |
| `sidebar.heading` | (API ^5.13; the app's, no thread: `{}`) in the Threads sidebar's heading, before ··· and +: a small `<IconButton>`. The phone's drawer has it too |
| `composer.above` | above the message box: something waiting on the user |
| `details.section` | in thread details (⌘I), after the core's: an `<h5>` and what you know of the thread |
| `editor.side`, `editor.bar` | beside a file in the editor, and in its bar |
| `overlay` | over everything: a dialog of your own. Mark its surface `data-superego-overlay` (the kit's popovers and dialogs already are) so a web page in a pane steps aside |
| `onboarding` | (API ^5.9) in first-run setup, among what was found: `{ machine, use }`. Draw a `SetupRow`; call `use({ label, detail, model })` when ready (`model`: `<kind>/<model>`, made the machine's default). Claude Agent's finds Claude Code |
| `welcome` | (API ^5.10) in first-run setup, after the model: `{ machine }`, the machine it sets up. A line on what yours offers and a way to it. Ego's says what to ask it for |

### Narrowing the sidebar

(API ^5.13) `superego.sidebarFilter(useFilter)`: `useFilter` is a hook, drawn for as long as the extension is set up,
that returns the narrowing in force now, or `undefined` for none: `{ shows(thread, machine), title?, footer? }`. The
list shows only the threads each narrowing lets through (of those that have your extension), under their projects;
the thread shown always stays. ⌘⇧[ and ⌘⇧], ⌃T and the rail's dots follow it. Meanwhile the heading says `title`, the
Pinned section and Archived are left out, and the list ends with your `footer` (`{ hidden, shown }`, counts of
threads), or a quiet "N hidden". The bundled `focus` extension is one.

```tsx
import { defineUiExtension, useAppSetting, type SidebarFilter } from 'superego/ui'

// The same narrowing while nothing changes: a new one each draw would narrow the list again each time.
const BUSY: SidebarFilter = { title: 'Busy', shows: (thread) => thread.status.state === 'working' }
const useBusy = () => useAppSetting<boolean>('busy.on')[0] ? BUSY : undefined

export default defineUiExtension({ name: 'busy', setup: (superego) => superego.sidebarFilter(useBusy) })
```

### Code blocks

(API ^5.14) `superego.codeBlock(languages, component)` draws fenced code blocks tagged with one of `languages` (a tag
or a list, any case) wherever Markdown is: messages, rendered files, `<Markdown>`. `component` gets `{ language, code,
compact, streaming }`: the tag lowercased, the source without its last newline, whether the Markdown is set compact (a
preview, a fold), and whether the message is still streaming in (its source half-written: wait quietly rather than
show an error). A thread's profile's go first, then the app's; a block no one claims, or in a thread that goes without
your extension, is drawn as code. The bundled `mermaid` extension draws ```` ```mermaid ```` blocks as diagrams.

```tsx
import { defineUiExtension, type CodeBlockProps } from 'superego/ui'

function Csv({ code, streaming }: CodeBlockProps) {
  const rows = code.split('\n').map((line) => line.split(','))
  if (streaming) return <pre>{code}</pre>
  return <table><tbody>{rows.map((cells, i) => <tr key={i}>{cells.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
}

export default defineUiExtension({ name: 'csv', api: '^5.14', setup: (superego) => superego.codeBlock('csv', Csv) })
```

### A mark in the sidebar

The daemon half keeps what it found in the thread's `state`, publishes it with `facts`; each `ThreadInfo` carries it
as `thread.facts.<name>` (`factsOf<T>(thread, name)`), and a `thread.badge` slot draws it. The daemon half is in
[Watching tool calls](daemon.md#watching-tool-calls):

```tsx
// ui/db.tsx; in profile.ts: extensions: ['./db.ts'], ui: ['./ui/db.tsx']
import { defineUiExtension, factsOf, TableIcon, ThreadBadge, type SlotProps } from 'superego/ui'

function DbMark({ thread }: SlotProps['thread.badge']) {
  const db = factsOf<{ why: string }>(thread, 'db')
  if (!db) return null
  return <ThreadBadge label="touched the database" title={db.why}><TableIcon size={12} aria-hidden /></ThreadBadge>
}

export default defineUiExtension({ name: 'db', setup: (superego) => superego.slot('thread.badge', DbMark) })
```

It shows before the thread is opened, since [the UI loads](#when-the-ui-loads) when the window lists it.

### Inside a pane

| | |
|---|---|
| `<PaneHeader>` | small things beside the pane's title: a `<PaneNote>` (a count, a path; `code`, `href`), `<PaneButton>`s |
| `<PaneMessage>` | stands in while there's nothing to show (Loading…, an error) |
| `useTabNote(note, key)` | a note on its tab (Changes: `<DiffStat added removed />`) |
| `useTabGlyph(glyph, key)` | a glyph in place of its kind's (`<Glyph shape="working" quiet />`); null for its kind's |

**A web page:** `<WebView src partition="browser" title sandbox onEvent ref>` shows one as Browser does: a browser tab
on the desktop (own cookies), a frame in a browser (`sandbox` is the frame's); `hasWebViews()` says which.

- `ref`: `go(-1)`, `reload()`, `stop()`, `load(url)`, `focus()`; `run(fn, ...args)` runs a self-contained function in
  the page (`(window, ...args) => …`, only its source goes; on the desktop in the app's own world, framed only on the
  window's origin) and returns its result; `capture(rect)` a PNG of part of the page (not framed).
- `onEvent`: where it is, `state.loading`, `state.progress`, a file it saved, what it was refused.
- Focused, the pane keeps the keyboard until Return (or a click) passes it in; `onWaiting(waiting)` says when, for a
  hint.

## From 'superego/ui'

**Talking to the daemon:**

| | |
|---|---|
| `call(machine.id, 'orders.find', params)` | a read: a daemon half's method (or any protocol method); a promise |
| `useMethod(machine.id, method, params, { enabled, refresh })` | a method's answer in a component, with `error`, `loading`, `refetch`; called again as `params` or `refresh` change, stale answers dropped |
| `useDispatch()` → `dispatch(id, params, { machine: machine.id })` | run an action (a daemon half's, or `pane.open`, `thread.send`); a promise |
| `useValue<T>(machine, key, { scope? })` | a live value, kept current: undefined until it arrives, null while nothing publishes it. One subscription however many components watch |
| `has(machine, 'ext:x@^1.2')`, `version(machine, 'x')` | whether a machine has an extension on (at a version): [Versions](lifecycle.md#versions-and-compatibility) |

<!-- check: ui; declare const dispatch: import('superego/ui').Dispatch, thread: ThreadInfo -->
```ts
dispatch('pane.open', { thread: thread.id, kind: 'editor', params: { path: 'notes/a.md', line: 12 } }, { machine: machine.id })
dispatch('pane.open', { thread: thread.id, kind: 'browser', params: { url: 'http://localhost:3000' } }, { machine: machine.id })
dispatch('thread.send', { thread: thread.id, text: 'Ship it' }, { machine: machine.id })
```

**Components:**

| | |
|---|---|
| `Button`, `IconButton`, `TextField`, `TextArea`, `Select`, `Switch`, `List`, `ListItem`, `Panel`, `Dialog`, `Menu`, `Popover`, `Tooltip` | the window's controls |
| `StatusGlyph`, `StatusWord`, `Glyph` | a status's mark and word ([Reading threads](#reading-threads)) |
| `Markdown` | an agent's text as the transcript sets it, links followed by the same handlers: `<Markdown text={answer} />`; `compact` (UI size, tighter) and `lines={4}` (cut with an ellipsis) for a preview |
| `FileEditor` | the file editor, Markdown in live preview: `<FileEditor machine={machine} thread={thread} path={path} actions={…} />` |
| `TextEditor` | the same editor for text kept anywhere: `<TextEditor value={text} onChange={save} mode="live" />`. `mode`: one of `TEXT_MODES` (`rendered`, `live`, `source`). A new `value` from outside goes in as the least change, cursor kept, without `onChange`; `revision` takes the same `value` again; `place` keeps cursor and scroll; `links`, where its links are from; `readOnly` |
| `Diff` | a unified diff, file by file: `<Diff diff={text} />`; `parseDiff(text)` for its files and counts |
| `Picker` | a narrowing list, like ⌘K: `<Picker label placeholder items={list} filter={(items, query) => …} row={(item) => ({ key, title, glyph?, detail?, keys? })} onPick={(item, { beside }) => …} onClose digits? empty? footer? />`. ↑↓, ⏎ picks, ⌘⏎ beside, `digits`: ⌃1–⌃9 |
| `ThreadRef` | a thread named as itself, kept current: `<ThreadRef machine={id} id={thread} />` |
| `SignInFlow` | a sign-in flow as Settings → Providers draws one, for an action answering `auth.flow`'s `{ flow }`: `<SignInFlow machine={id} title="Signing in to Linear" start={() => dispatch('x.signIn', { … }, { machine: id })} onClose={…} />`. Starts on mount, opens the browser, asks what the flow asks, has Cancel. On the desktop, a remote flow's loopback `callback` is caught here |
| `HeaderChip`, `ThreadBadge`, `Chip`, `RailButton` | for slots (`RailButton`: bundled extensions' rail) |
| Phosphor icons | `ArchiveIcon`, … |

**Others:** `useComposer()` (the message box); `useComposerClaim({ placeholder, submit })` (take it over while
something waits on the user); `addToComposer({ machine, thread }, { label, detail?, files })` (a chip whose files go
with the next message; takes the keyboard); `useLocalState(key, initial, { shared? })` (window state across reloads;
`shared`: every window); `useShortcut(actionId)` (its key's label); `score` (fuzzy matching);
`transcriptLinks(machine, thread)` (a transcript's links in order: `{ text, href, target, open(beside) }`);
`factsOf(thread, name)`; `parseWikilink(href)`; `h` (`React.createElement`, without JSX).

## Reading threads

The window follows every connected machine's threads live, one subscription per machine. A profile's UI sees them
all, not only its profile's.

| Hook | Gives |
|---|---|
| `useThreads(machine.id)` | that machine's `ThreadInfo[]`, newest first; `undefined` until it answers |
| `useAllThreads()` | `Record<machineId, ThreadInfo[] \| undefined>` |
| `useProjects()` | `{ projects, lastThread, hold }`: `projects` in sidebar order, each `{ key, machine, root, name, threads, depth, activeAt, status }` (`depth`: nesting under the thread that started it; `status`: the most pressing); `lastThread[key]`: the thread last shown there |
| `useSelection()` | `{ selection, select, machine, thread }`: the thread shown (`selection`: `{ machine, thread }` ids; `thread`: its info); `select({ machine, thread })` or `select(undefined)` |
| `useMachines()` | every `MachineEntry`: `id`, `label`, `state` (`'connected'`, …) |

None list archived or hidden threads.

`ThreadInfo`: `id`, `title`, `cwd`, `createdAt`, `activeAt` (last activity; use as `useMethod`'s `refresh`),
`project` (`{ root, name }`), `parent`, `profile` (`{ name, scope: 'user' | 'project', dir }`; absent: none), `model`,
`cost` (dollars), `panes` and `pane`, `without` (optional extensions it lacks), `facts` (by extension name), `status`.

`status` is `{ state, kind?, msg? }` (`Status`), most pressing first:

| `state` | Means | `msg` |
|---|---|---|
| `blocked` | needs the user: `kind` is `question` (`ask_user`), `permission`, or `auth` (provider refused the credentials; resumes once signed in) | what it waits on |
| `error` | its last run failed, unseen | why |
| `done` | finished with an answer, unseen | the run's recap, if any |
| `working` | a run is going | |
| `idle` | nothing to see (never run, or seen) | |

`done` and `error` mean *unseen*: opening the thread turns them `idle`.

- `<StatusGlyph status={t.status} quiet={t.quiet} />` draws a status's mark as every list does (`quiet`: a thread that
  reports to another, grey, its finished runs not new). `StatusWord` draws its word in its colour.
- `statusWord(status)`, `statusLabel(status)`: the words the app, CLI and notifications use ("Question", "Permission",
  "Sign in", "Failed", "Done", "Working"; the label adds the recap or reason).
- `<Glyph shape="landed" />` draws marks by name, including `queued`, `stalled`, `landed`, `offline`, `connecting`.
- Outside React: `superego.on('thread.status', …)`.

A board of one machine's threads, a column per state:

```tsx
// ui/board.tsx; in profile.ts: ui: ['./ui/board.tsx'], panes: { board: "every thread on this machine, by status; no params" }
import { defineUiExtension, PaneMessage, StatusGlyph, useSelection, useThreads, type PaneProps, type Status } from 'superego/ui'

const LANES: { state: Status['state']; title: string }[] = [
  { state: 'blocked', title: 'Needs you' }, { state: 'error', title: 'Failed' }, { state: 'working', title: 'Working' },
  { state: 'done', title: 'Done' }, { state: 'idle', title: 'Idle' },
]

function Board({ machine }: PaneProps) {
  const threads = useThreads(machine.id)
  const { select } = useSelection()
  if (!threads) return <PaneMessage>Loading…</PaneMessage>
  return <div className="board">{LANES.map(({ state, title }) => (
    <section key={state}>
      <h3>{title}</h3>
      {threads.filter((t) => t.status.state === state).map((t) => (
        <button key={t.id} type="button" onClick={() => select({ machine: machine.id, thread: t.id })}>
          <StatusGlyph status={t.status} /> {t.title} <small>{t.project.name}</small>
        </button>
      ))}
    </section>
  ))}</div>
}

export default defineUiExtension({ name: 'board', setup: (superego) => superego.pane('board', { title: 'Board', component: Board, menu: true }) })
```

Every machine's instead: `Object.entries(useAllThreads())`, with `useMachines()` for labels.

## Styling

`superego.style(css)` in `setup` (a profile's UI can't import CSS). Use the theme's variables so it follows light, dark,
the accent and the chosen theme:

<!-- check: ui -->
```ts
superego.style(`.order-pane { padding: var(--superego-space-3); color: var(--superego-muted); border-radius: var(--superego-radius); }`)
```

Styles go with the UI when it reloads or is revoked, and apply only to what your profile draws on its machine: its
panes, views, slots, tool rows, entries, links, settings, and the menus, popovers, dialogs and `PaneHeader` contents
they open. Not to the window's UI, other profiles', or this profile from another machine at another version, so class
names can't clash.

- `:root`, `html` and `body` don't match; `:scope` is the box-less element your component is drawn in.
- `@media`, `@supports`, `@container` and nesting work. `@import` doesn't.
- `@keyframes`, `@font-face` and `@property` names are global: prefix them with your extension's name.
- An element you portal yourself (`createPortal` to `document.body`) isn't styled: portal through `Menu`, `Popover`,
  `Dialog`, `Tooltip`, `PaneHeader`.
- A `<style>` you append to `document.head` styles the whole window, every profile included.

Variables: `--superego-bg`, `--superego-raised`, `--superego-border`, `--superego-muted`, `--superego-faint`,
`--superego-accent`, `--superego-hover`, `--superego-selected`, `--superego-font`, `--superego-mono`,
`--superego-radius`, `--superego-radius-lg`, `--superego-space-1` … `--superego-space-7`. Name classes after your
extension (`board-lane`); get the window's look from its components, not its class names.

A pane can be narrow (a whole screen on a phone): fill the parent with flex, and let it scroll.

## Themes

`superego.theme(theme)` adds a theme to Settings → Appearance's picker for its `appearance`, under your extension's
name. Chosen, it colours code (editor, messages, rendered files), diffs and the terminal everywhere, not only in your
threads; `accent` colours the window's accent unless the user chose their own. With Match window to theme, the
window's backgrounds, text and lines follow `ui.bg`/`ui.fg` (else the terminal's), links `ui.link`, and
`ui['accent-text']` is text on the accent.

<!-- check: ui -->
```ts
superego.theme({
  id: 'moonlit.night', name: 'Moonlit Night', appearance: 'dark',
  syntax: { keyword: '#ff79c6', string: '#f1fa8c', comment: '#6272a4', function: '#50fa7b' },
  terminal: { bg: '#21222c', fg: '#f8f8f2', red: '#ff5555', green: '#50fa7b' },
  accent: '#6d5bd0',
})
```

- `id` (starting with your extension's name), `name` and `appearance` (`'light'` or `'dark'`) are required; a role
  left out keeps Superego's. A theme that doesn't read throws, saying why.
- Colours: hex (`#rrggbb`, with alpha too) or CSS colour functions (`rgb()`, `oklch()`, `color(display-p3 …)`).
- `syntax`: `keyword`, `string`, `number`, `comment`, `function`, `type`, `tag`, `attribute`, `definition`, `meta`,
  `inserted`, `deleted` (a diff's lines), `invalid`.
- `terminal`: `fg`, `bg`, `cursor`, `selection`, and `black` … `white`, `bright-black` … `bright-white`.

The `Theme` type is in `superego/ui`; Import theme… reads the same format.

## A complete example

[`examples/build-queue-ui`](examples/build-queue-ui): a daemon half with a tool, a scoped value and an action, and a UI
half drawing the thread's queue beside it, with tests.
