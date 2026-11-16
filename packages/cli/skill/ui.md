# The UI half

New to this? Start with [the guide](guide.md) (`superego --skill guide`): the big picture, a first extension end to end, and a cheat sheet.

A profile's UI runs in the window, for that profile's threads only (on the machine it came from): panes, things beside
a thread, and how its tool calls look in the transcript. List modules in the profile's `ui`; each default-exports
`defineUiExtension`. Everything a module registers belongs to it, and goes when the profile's files change and the
window loads them again.

## When the UI loads

The window loads a profile's UI as soon as it lists one of that profile's threads, in the sidebar or the navigator. It
doesn't wait for one to be opened, so its badges, slots, tool rows and pane kinds are there from the start.

- Archived and hidden threads don't count.
- It loads once per profile per machine, however many threads share it. That loads the profile's daemon half too.
- Another machine's profile loads this way only if its UI was allowed here before. One never allowed waits until a
  thread of it is opened, which asks.
- It stays loaded until the window reloads, even once its last listed thread goes; it shows only on its own threads.
- After you change its files, it loads again when a shown thread of it moves on: send that thread a message.

## A first module

```tsx
// .superego/profiles/support/ui/order.tsx
import { defineUiExtension, PaneHeader, FileTextIcon, useMethod, type PaneProps } from 'superego/ui'

function OrderPane({ machine, thread, pane }: PaneProps) {
  const { id } = (pane.params ?? {}) as { id?: string }
  // A read: the daemon half's method (superego.method), not an action; again as the thread moves on.
  const { data: order, error } = useMethod<any>(machine.id, 'orders.find', { number: id }, { enabled: Boolean(id), refresh: thread.activeAt })
  if (error) return <div className="pane-empty">{error.message}</div>
  if (!order) return <div className="pane-empty">Loading…</div>
  return <div className="order-pane"><PaneHeader><span>{order.status}</span></PaneHeader><h2>Order {id}</h2>…</div>
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

Then, in `profile.ts`: `ui: ['./ui/order.tsx'], panes: { order: 'an order, with its lines. Params: { id }' }` (or, from
a daemon half, `superego.pane('order', '…')`). The agent opens it with `pane_open({ kind: 'order', params: { id: '1234' } })`; so can you, with
`superego do pane.open --params '{"id":"<thread>","kind":"order","params":{"id":"1234"}}'`.

## What a module can import

- `'react'` and `'react/jsx-runtime'`: the window's own React (19).
- `'superego/ui'`: the hooks and components below: the stable surface. `'superego/unstable'`: the window's own
  workings (`useRegistry`, `useShell`, …), which change with it.
- Its own files, by relative path (`'./chart.ts'`).

Nothing else: no npm packages, no CSS imports. TSX and TS are compiled by the daemon (types stripped, JSX for React);
there is no type checking.

## The setup API

| | |
|---|---|
| `superego.pane(kind, { title, component, icon?, file?, menu?, opens?, fallback?, folders?, urls?, width? })` | a kind of pane. `title`: a string, or `(pane) => string`. `component` gets `{ machine, thread, pane }`; `pane.params` is what it was opened with. `icon`: its glyph on the pane's tab (a Phosphor icon from `superego/ui`). `file: true`: its title is a file name, and the tab shows it as one. `menu: true` offers it in the thread's pane menu (it needs no params). `opens: (path) => boolean` makes files named in the thread open in it (`/\.csv$/.test(path)`), ahead of the editor (`fallback: true`: any file no kind `opens`); `folders: true`, folders (`params.path`, `''` for the thread's own); `urls: true`, web pages a thread links to, when opened beside (`params.url`). `width`: share of the row, 0.5 by default |
| `superego.tool(name, row, { fold? })` | how calls to a tool look in the transcript, described: `{ icon?, verbs?, verb?, subject?, stat?, meta?, body?, phrase?, file?, weight? }`. `verbs`: done, working, failed (`['Read', 'Reading', 'Read failed']`); `verb(call)`, a call's own instead, where one needs another. The functions get the call (below) and its `state` (`idle`, `working`, `done`, `error`): `subject` is what it acted on, after the verb (text in mono, or a node such as `<ThreadRef machine id />`); `stat` its lines `{ added, removed }`; `meta` a little more at the row's end; `body` what it opens to. `phrase(count)` says what `count` calls did in a run's line (`read 2 files`); `file(args)` names the one file a lone call was about there; `weight` decides which kind leads that line. Anything left out (or returning `undefined`) is the default: its name, its `command`/`path`/`pattern`, its output; `null` from `subject` or `body` is nothing. `fold: false` shows them under their run of work, open, instead of folded into it: for what the agent shows you (as `images` does) |
| `superego.tool(name, component, { fold? })` | draw calls to a tool whole, yourself. Gets `{ machine, thread, call: { id, name, arguments }, result?: { text, isError, details, images? }, live?: { status, output, details } }`; `images` are those the model was shown, `{ data, mimeType }` in base64 |
| `superego.tool('prefix*', row \| component)` | a name ending in `*` matches every tool whose name starts so (`mcp__*`), where the tool has no row of its own; the longest prefix wins. Tools of one prefix's row with a `phrase` count as one kind in a run's line. |
| `superego.link({ match, open, render?, target? })` | claim links in Markdown: a scheme (`match: 'ticket:'`), a pattern (`/^https:\/\/linear\.app\//`), or a test `(href, kind, where) => boolean` that also sees inline code (`kind: 'code'`, its text as `href`). `open(href, { machine, thread, beside, kind, openFile, openUrl })` follows one, on a click (⌘: `beside`) or from ⌃O's list; return a string to say why it couldn't. `render` gets `{ href, children, code, title, where, open(beside) }` (default: a link that follows it). `target(href)`: where it goes, in ⌃O's list. `scheme`: the scheme a pattern or test claims (`'ticket'`), so HTML files keep its links, as they do a `'ticket:'` match's. `[[Note#Heading|alias]]` comes as `wikilink:Note#Heading` (each part URI-encoded; `parseWikilink(href)` gives `{ target, heading?, block? }`), its alias as its text, so a profile can open it its own way. Asked in turn: the thread's profile's, then the app's extensions' (the threads extension's `thread:`), then the core's defaults (files, `wikilink:`, web pages). The same handlers follow links in messages, in ⌃O's list, and in a file's rendered text and live preview |
| `superego.view(id, { title, icon?, context, fits, default?, component, order? })` | a view, `<name>.<view>`, that the layout puts in a place: for a profile, `beside` (a column beside the thread), `pane` (the thread's pane menu; it's a pane kind of its id too) or `header` (right of the title). `context: 'thread'`: `component` gets `{ place, machine, thread }`. `default`: where it goes (a place, several, or none: offered only); the user moves, reorders or hides it (`~/.superego/layout.json`, which is `app.layout`; or a right-click on it), so don't assume one place |
| `superego.slot(slot, component, { order? })` | put a component in a slot whose place behaviour decides (below) |
| `superego.signal` | an `AbortSignal`, aborted when this UI is torn down (its profile's files changed, it was revoked): for timers, listeners and fetches of its own. `setup` may also return a cleanup, run then. Registering after that throws. Each component it draws is drawn apart: one that throws shows "<name> failed to draw" with Retry, in its place |
| `superego.on(event, listener)` | hear what happens in the window, in the desktop app and a browser alike; returns a function that stops it (teardown does too). `'thread.status'`: `{ machine, thread, before }`, a thread's status changed (`before` undefined the first time the window sees it; only your profile's threads). `'select'`: `{ selection, before }`, the thread shown changed. `'focus'`: `{ focused }`. `'visibility'`: `{ visible }`. `superego.window` is how things are now: `{ focused, visible, selection, thread }` |
| `superego.appSetting(key)` | one of the app's settings as it is now, outside React (`useAppSetting` in components) |
| `superego.entry(kind, component)` | draw transcript entries of a kind an extension writes |
| `superego.settings(ui, component)` | draw below the settings section (of its daemon half) that names `ui` |
| `superego.composer.complete({ title, word, items })` | complete a word as it's typed. `word(text, caret)` returns the word at the caret it completes, `{ start, query }` (and anything of its own), or nothing; the first provider to find one wins. `items(word, { machine, thread })` returns (or resolves to) `{ label, detail?, insert }[]`, best first; taken, `insert` replaces the word (end it with a space to go on typing). The composer draws the menu: ↑↓ pick, ⇥ or ⏎ take, esc leaves the word |
| `superego.composer.sentWith({ read, component })` | draw what the daemon half's `beforeSend` put in sent messages. `read(blocks)` returns `{ items, blocks }`: what to draw and the indexes of the blocks it found them in, which the message's text then leaves out; `component` gets `{ machine, thread, items }` and draws under the message (chips: `className="attachment"`). Drawn for threads that go without the extension now too |
| `superego.store(key, initial, { persist?, shared? })` | state of the extension kept in the window: `get()`, `set(next)`, `subscribe`, and `use()` in a component. Give the bare key (`superego.store('columns', [])`): it's kept as `<name>.columns`, and `'<name>.columns'` is the same store. `persist` keeps it across reloads, for this window alone (each desktop window has its own), or for all of them with `shared` |
| `superego.dispatch(id, params, { machine })` | run an action outside React |

A profile's module may draw its tool calls the way it likes; if two draw the same tool, the first stays (with a warning
in the console). A profile's own wins over a bundled extension's in its threads.

Slots a profile can fill, each given `{ machine, thread }` (and for the editor ones, `path` and `open(path)`):

| Slot | |
|---|---|
| `header.chips` | among the chips that say where a thread works (a branch): draw a `<span className="header__chip">` |
| `thread.badge` | after a thread's title in the sidebar: a small mark of something about it. Draw a `<span className="thread-badge" title="…">` around a 12px icon, or nothing ([below](#a-mark-in-the-sidebar)) |
| `composer.above` | above the message box: something waiting on the user |
| `details.section` | in thread details (⌘I), after what the core says: an `<h5>` and what you know of the thread. |
| `editor.side`, `editor.bar` | beside a file in the editor, and in its bar |
| `overlay` | over everything: a dialog of your own, drawn while you want it |
| `onboarding` | on the first-launch page, under its title: a word on what yours offers, and a way to it |

### A mark in the sidebar

A mark on some threads' rows goes from the daemon half to the window in four steps: the daemon half keeps what it found
in the thread's `state`, publishes it with `facts`, each `ThreadInfo` carries it as `thread.facts.<name>`, and a
`thread.badge` slot draws it. The daemon half for this one is in [Watching tool calls](daemon.md#watching-tool-calls):

```tsx
// ui/db.tsx; in profile.ts: extensions: ['./db.ts'], ui: ['./ui/db.tsx']
import { defineUiExtension, TableIcon, type SlotProps } from 'superego/ui'

function DbMark({ thread }: SlotProps['thread.badge']) {
  const db = thread.facts?.db as { why: string } | undefined
  if (!db) return null
  return <span className="thread-badge" title={db.why} role="img" aria-label="touched the database"><TableIcon size={12} aria-hidden /></span>
}

export default defineUiExtension({ name: 'db', setup: (superego) => superego.slot('thread.badge', DbMark) })
```

The mark shows before the thread is opened: [the UI loads](#when-the-ui-loads) as soon as the window lists it.

Spaces (the sidebar), the rail, work dividers, window actions, app settings and New thread fields are for bundled extensions
(`superego --skill bundled`).

Inside a pane: `<PaneHeader>` puts small things (a count, Refresh) in the pane's header beside its title, and
`useTabNote(note, key)` shows a note on its tab in the strip (Changes shows +3 −1).

## From 'superego/ui'

Talking to the daemon:

- `call(machine.id, 'orders.find', params)`: a read, a daemon half's method (or any protocol method). A promise of
  its result.
- `useDispatch()` → `dispatch(id, params, { machine: machine.id })`: run an action (a daemon half's, or a
  built-in like `pane.open`, `thread.send`): something that changes things. Returns a promise of its result.
- `useValue<T>(machine.id, machine.state === 'connected', 'orders.recent')`: a daemon half's live value, kept
  current. Undefined until it arrives, null while nothing publishes it yet (the profile hasn't loaded). However many
  components watch the same value, the window holds one subscription.
- `useThreads`, `useAllThreads`, `useProjects`, `useSelection`, `useMachines`: what the window knows ("Reading threads", below).

Opening things:

<!-- check: ui; declare const dispatch: import('superego/ui').Dispatch, thread: ThreadInfo -->
```ts
dispatch('pane.open', { thread: thread.id, kind: 'editor', params: { path: 'notes/a.md', line: 12 } }, { machine: machine.id })
dispatch('pane.open', { thread: thread.id, kind: 'preview', params: { url: 'http://localhost:3000' } }, { machine: machine.id })
dispatch('thread.send', { thread: thread.id, text: 'Ship it' }, { machine: machine.id })
```

Components: `Button`, `IconButton`, `TextField`, `TextArea`, `Select`, `Switch`, `List`, `ListItem`, `Panel`,
`Dialog`, `Menu`, `Popover`, `Tooltip`, `StatusGlyph`, `Markdown` (an agent's text set exactly as the transcript sets it, its links followed by the same handlers: `<Markdown text={answer} />`; for a preview, `<Markdown text={answer} compact lines={4} />`: `lines` cuts it to that many lines with an ellipsis, `compact` sets it at the UI's size with tighter spacing), `FileEditor` (the file editor,
Markdown in live preview: `<FileEditor machine={machine} thread={thread} path={path} actions={…} />`; its links follow the link handlers, as a message's do), `Diff`
(a unified diff, file by file: `<Diff diff={text} />`; `parseDiff(text)` for its files and counts), `Picker` (a dialog
with a list that narrows as you type, as the palette is: `<Picker label placeholder items={list} filter={(items, query) => …}
row={(item) => ({ key, title, glyph?, detail?, keys? })} onPick={(item, { beside }) => …} onClose digits? empty? footer? />`;
↑↓ move, ⏎ picks, ⌘⏎ beside, `digits`: ⌃1–⌃9 pick the first nine), `ThreadRef` (a thread named as itself, kept
current: `<ThreadRef machine={id} id={thread} />`), `SignInFlow` (a sign-in flow drawn as Settings → Providers draws one,
for an action of the daemon half that answers with `superego.auth.flow`'s `{ flow }`: `<SignInFlow machine={id}
title="Signing in to Linear" start={() => dispatch('x.signIn', { … }, { machine: id })} onClose={…} />`; it starts as it
mounts, opens the page in the browser, asks what the flow asks, and has Cancel), and the Phosphor icons the app
uses (`ArchiveIcon`, …).

Others: `useComposer()` (the message box), `useComposerClaim({ placeholder, submit })` (take the message box over while
something waits on the user), `useLocalState(key, initial, { shared? })` (state kept in the window across reloads; `shared` by every window), `useShortcut(actionId)` (its key's
label), `score` (fuzzy matching), `transcriptLinks(machine, thread)` (the links a thread's transcript shows, in order: `{ text, href, target, open(beside) }`), `h` (`React.createElement`, for modules without JSX).

## Reading threads

The window follows every connected machine's threads, live, with one subscription per machine however many components
read them. A profile's UI sees them all, not just its own profile's.

| Hook | Gives |
|---|---|
| `useThreads(machine.id)` | that machine's threads, `ThreadInfo[]`, newest first; `undefined` until the machine says (or while it's away and never answered) |
| `useAllThreads()` | every machine's: `Record<machineId, ThreadInfo[] \| undefined>` |
| `useProjects()` | `{ projects, lastThread, hold }`: `projects` in the sidebar's order, each a `Project`, `{ key, machine, root, name, threads, depth, activeAt, status }` (a project's threads, `depth` how far each is nested under the thread that started it, `status` the most pressing of theirs); `lastThread[key]` the thread last shown in it |
| `useSelection()` | `{ selection, select, machine, thread }`: the thread shown (`selection` is `{ machine, thread }` ids, `thread` its `ThreadInfo`), and `select({ machine, thread })` to show another, or `select(undefined)` |
| `useMachines()` | every machine, `MachineEntry`: `id`, `label`, `state` (`'connected'`, …) |

Archived threads aren't in the lists, nor hidden ones (an extension's own agent, like Ego's).

A `ThreadInfo` (type from `'superego/ui'`): `id`, `title`, `cwd` (where it works), `createdAt`, `activeAt` (when
anything last happened in it: a dependency for `useMethod`'s `refresh`), `project` (`{ root, name }`: its project),
`parent` (the thread that started it), `profile` (`{ name, scope: 'user' | 'project', dir }`; absent: none), `model`,
`cost` (dollars), `panes` and `pane` (what's open beside it), `without` (optional extensions it goes without), `facts`
(each extension's facts about it, by name: `facts.worktrees`), and `status`.

`status` is `{ state, kind?, msg? }` (type `Status`). The states, most pressing first:

| `state` | Means | `msg` |
|---|---|---|
| `blocked` | it needs the user: `kind` is `question` (an `ask_user`), `permission`, or `auth` (its provider refused the credentials; it goes on by itself once signed in again) | what it waits on |
| `error` | its last run failed, and nobody has looked since | why |
| `done` | it finished with an answer the user hasn't seen yet | what the run did, in a line (when there's a recap) |
| `working` | a run is going | |
| `idle` | nothing to see: never run, or its answer or failure seen (showing the thread marks it seen) | |

So `done` and `error` turn `idle` once the user opens the thread: they mean "unseen", not "finished" or "failed for
good". `StatusGlyph` draws a status as the sidebar does (`<StatusGlyph status={t.status} />`), and `statusLabel(status)`
says it in words, as tooltips and notifications do ("Finished: <recap>", "Needs you: a question"). To act on a change
outside React, `superego.on('thread.status', …)` (the setup API, above).

A board of one machine's threads, a column per state:

```tsx
// ui/board.tsx; in profile.ts: ui: ['./ui/board.tsx'], panes: { board: "every thread on this machine, by status; no params" }
import { defineUiExtension, StatusGlyph, useSelection, useThreads, type PaneProps, type Status } from 'superego/ui'

const LANES: { state: Status['state']; title: string }[] = [
  { state: 'blocked', title: 'Needs you' }, { state: 'error', title: 'Failed' }, { state: 'working', title: 'Working' },
  { state: 'done', title: 'Done' }, { state: 'idle', title: 'Idle' },
]

function Board({ machine }: PaneProps) {
  const threads = useThreads(machine.id)
  const { select } = useSelection()
  if (!threads) return <div className="pane-empty">Loading…</div>
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

Every machine's instead: `Object.entries(useAllThreads())`, with `useMachines()` for each one's `label`.

## Styling

Bring styles with a `<style>` element added in `setup` (a profile's UI can't import CSS), and use the theme's
variables so it follows light and dark mode and the user's accent:

<!-- check: skip -->
```ts
const style = document.createElement('style')
style.textContent = `.order-pane { padding: var(--superego-space-3); color: var(--superego-muted); border-radius: var(--superego-radius); }`
document.head.append(style)
return () => style.remove()   // setup's cleanup: gone with the UI, reloaded or revoked
```

Useful variables: `--superego-bg`, `--superego-raised`, `--superego-border`, `--superego-muted`, `--superego-faint`,
`--superego-accent`, `--superego-hover`, `--superego-selected`, `--superego-font`, `--superego-mono`,
`--superego-radius`, `--superego-radius-lg`, `--superego-space-1` … `--superego-space-7`. `pane-empty` is the class for a
pane's empty and loading states.

A pane is a column that can be narrow (and a whole screen on a phone): lay it out to fill its parent with flex, and
let it scroll.

## A complete example

`~/.superego/profiles/obsidian/ui/` (if present on this machine): a graph pane on a canvas and a note pane built on
`FileEditor`, both fed by the profile's daemon actions.
