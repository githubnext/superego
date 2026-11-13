# UI extensions

New to this? Start with [docs/writing-extensions.md](https://github.com/mikker/superego/blob/main/docs/writing-extensions.md): the big picture, a first extension end to end, and a cheat sheet.

A profile's UI runs in the window, for that profile's threads only (on the machine it came from): panes, things beside
a thread, and how its tool calls look in the transcript. List modules in the profile's `ui`; each default-exports
`defineUiExtension`. Everything a module registers belongs to it, and goes when the profile's files change and the
window loads them again.

```tsx
// .superego/profiles/support/ui/order.tsx
import { useEffect, useState } from 'react'
import { call, defineUiExtension, PaneHeader, FileTextIcon, type PaneProps, type ToolCallProps } from 'superego/ui'

function OrderPane({ machine, thread, pane }: PaneProps) {
  const { id } = (pane.params ?? {}) as { id?: string }
  const [order, setOrder] = useState<any>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!id) return
    // A read: the daemon half's method (superego.method), not an action.
    call(machine.id, 'orders.find', { number: id }).then(setOrder, (e: Error) => setError(e.message))
  }, [id, thread.activeAt])           // again as the thread moves on
  if (error) return <div className="pane-empty">{error}</div>
  if (!order) return <div className="pane-empty">Loading…</div>
  return <div className="order-pane"><PaneHeader><span>{order.status}</span></PaneHeader><h2>Order {id}</h2>…</div>
}

function FoundOrder({ call, result, live }: ToolCallProps) {
  const details = (result?.details ?? live?.details) as { status?: string } | undefined
  return <div>Order {String(call.arguments.number)}: {details?.status ?? 'looking…'}</div>
}

export default defineUiExtension({
  name: 'support-ui',
  setup(superego) {
    superego.pane('order', { title: (pane) => `Order ${(pane.params as any)?.id ?? ''}`, icon: FileTextIcon, component: OrderPane })
    superego.tool('find_order', FoundOrder)
  },
})
```

Then, in `profile.ts`: `ui: ['./ui/order.tsx'], panes: { order: 'an order, with its lines. Params: { id }' }` (or, from
a daemon extension, `superego.pane('order', '…')`). The agent opens it with `open_pane({ kind: 'order', params: { id: '1234' } })`; so can you, with
`superego do pane.open --params '{"id":"<thread>","kind":"order","params":{"id":"1234"}}'`.

## What a module can import

- `'react'` and `'react/jsx-runtime'`: the window's own React (19).
- `'superego/ui'`: the hooks and components below.
- Its own files, by relative path (`'./chart.ts'`).

Nothing else: no npm packages, no CSS imports. TSX and TS are compiled by the daemon (types stripped, JSX for React);
there is no type checking.

## The setup API

| | |
|---|---|
| `superego.pane(kind, { title, component, icon?, file?, menu?, opens?, fallback?, folders?, urls?, width? })` | a kind of pane. `title`: a string, or `(pane) => string`. `component` gets `{ machine, thread, pane }`; `pane.params` is what it was opened with. `icon`: its glyph on the pane's tab (a Phosphor icon from `superego/ui`). `file: true`: its title is a file name, and the tab shows it as one. `menu: true` offers it in the thread's pane menu (it needs no params). `opens: (path) => boolean` makes files named in the thread open in it (`/\.csv$/.test(path)`), ahead of the editor (`fallback: true`: any file no kind `opens`); `folders: true`, folders (`params.path`, `''` for the thread's own); `urls: true`, web pages a thread links to, when opened beside (`params.url`). `width`: share of the row, 0.5 by default |
| `superego.tool(name, component, { fold? })` | draw calls to a tool in the transcript. Gets `{ machine, thread, call: { id, name, arguments }, result?: { text, isError, details }, live?: { status, output, details } }`. `fold: false` shows them under their run of work, open, instead of folded into it: for what the agent shows you (as `images` does) |
| `superego.slot(slot, component, { order? })` | put a component in a place in the shell (below) |
| `superego.entry(kind, component)` | draw transcript entries of a kind an extension writes |
| `superego.settings(ui, component)` | draw below the settings section (of its daemon half) that names `ui` |
| `superego.composer.complete({ title, word, items })` | complete a word as it's typed. `word(text, caret)` returns the word at the caret it completes, `{ start, query }` (and anything of its own), or nothing; the first provider to find one wins. `items(word, { machine, thread })` returns (or resolves to) `{ label, detail?, insert }[]`, best first; taken, `insert` replaces the word (end it with a space to go on typing). The composer draws the menu: ↑↓ pick, ⇥ or ⏎ take, esc leaves the word |
| `superego.composer.sentWith({ read, component })` | draw what the daemon half's `submit` put in sent messages. `read(blocks)` returns `{ items, blocks }`: what to draw and the indexes of the blocks it found them in, which the message's text then leaves out; `component` gets `{ machine, thread, items }` and draws under the message (chips: `className="attachment"`). Drawn for threads that go without the extension now too |
| `superego.store(key, initial, { persist? })` | state of the extension kept in the window (`<name>.<key>`): `get()`, `set(next)`, `subscribe`, and `use()` in a component |
| `superego.dispatch(id, params, { machine })` | run an action outside React |

A profile's module may draw its tool calls the way it likes; if two draw the same tool, the first stays (with a warning
in the console). A profile's own wins over a bundled extension's in its threads.

Slots a profile can fill, each given `{ machine, thread }` (and for the editor ones, `path` and `open(path)`):

| Slot | |
|---|---|
| `thread.header` | right of the thread's title: badges, small buttons |
| `composer.above` | above the message box: something waiting on the user |
| `thread.aside` | a column beside the thread |
| `editor.side`, `editor.bar` | beside a file in the editor, and in its bar |
| `overlay` | over everything: a dialog of your own, drawn while you want it |

The sidebar, work dividers, window actions and app settings are for bundled extensions (`superego --skill bundled`).

Inside a pane: `<PaneHeader>` puts small things (a count, Refresh) in the pane's header beside its title, and
`useTabNote(note, key)` shows a note on its tab in the strip (Changes shows +3 −1).

## From 'superego/ui'

Talking to the daemon:

- `call(machine.id, 'orders.find', params)`: a read, a daemon extension's method (or any protocol method). A promise of
  its result.
- `useDispatch()` → `dispatch(id, params, { machine: machine.id })`: run an action (a daemon extension's, or a
  built-in like `pane.open`, `thread.submit`): something that changes things. Returns a promise of its result.
- `useValue<T>(machine.id, machine.state === 'connected', 'orders.recent')`: a daemon extension's live value, kept
  current. Undefined until it arrives, null while nothing publishes it yet (the profile hasn't loaded). However many
  components watch the same value, the window holds one subscription.
- `useThreads(machine.id, connected)`, `useAllThreads()`, `useMachines()`, `useSelection()`: what the window knows.

Opening things:

```ts
dispatch('pane.open', { id: thread.id, kind: 'editor', params: { path: 'notes/a.md', line: 12 } }, { machine: machine.id })
dispatch('pane.open', { id: thread.id, kind: 'preview', params: { url: 'http://localhost:3000' } }, { machine: machine.id })
dispatch('thread.submit', { id: thread.id, text: 'Ship it' }, { machine: machine.id })
```

Components: `Button`, `IconButton`, `TextField`, `TextArea`, `Select`, `Switch`, `List`, `ListItem`, `Panel`,
`Dialog`, `Menu`, `Popover`, `Tooltip`, `StatusGlyph`, `Markdown` (render Markdown text), `FileEditor` (the file editor,
Markdown in live preview: `<FileEditor machine={machine} thread={thread} path={path} onLink={…} actions={…} />`), `Diff`
(a unified diff, file by file: `<Diff diff={text} />`; `parseDiff(text)` for its files and counts), and
the Phosphor icons the app uses (`ArchiveIcon`, …).

Others: `useComposer()` (the message box), `useComposerClaim({ placeholder, submit })` (take the message box over while
something waits on the user), `useLocalState(key, initial)` (state kept in the window across reloads), `useShortcut(actionId)` (its key's
label), `score` (fuzzy matching), `h` (`React.createElement`, for modules without JSX).

## Styling

Bring styles with a `<style>` element added in `setup` (a profile's UI can't import CSS), and use the theme's
variables so it follows light and dark mode and the user's accent:

```ts
const style = document.createElement('style')
style.textContent = `.order-pane { padding: var(--superego-space-3); color: var(--superego-muted); border-radius: var(--superego-radius); }`
document.head.append(style)
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
