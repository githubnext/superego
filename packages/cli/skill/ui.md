# UI extensions

A profile's UI runs in the window, for that profile's threads only: panes, things beside a thread, and how its tool
calls look in the transcript. List modules in the profile's `ui`; each default-exports `defineUiExtension`:

```tsx
// .superego/profiles/support/ui/order.tsx
import { useEffect, useState } from 'react'
import { defineUiExtension, useDispatch, Button, type PaneProps, type ToolCallProps } from 'superego/ui'

function OrderPane({ machine, thread, pane }: PaneProps) {
  const dispatch = useDispatch()
  const { id } = (pane.params ?? {}) as { id?: string }
  const [order, setOrder] = useState<any>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!id) return
    dispatch('orders.find', { number: id }, { machine: machine.id }).then(setOrder, (e: Error) => setError(e.message))
  }, [id, thread.activeAt])           // again as the thread moves on
  if (error) return <div className="pane-empty">{error}</div>
  if (!order) return <div className="pane-empty">Loading…</div>
  return <div className="order-pane"><h2>Order {id}</h2>…</div>
}

function FoundOrder({ call, result, live }: ToolCallProps) {
  const details = (result?.details ?? live?.details) as { status?: string } | undefined
  return <div>Order {String(call.arguments.number)}: {details?.status ?? 'looking…'}</div>
}

export default defineUiExtension({
  name: 'support-ui',
  setup(superego) {
    superego.pane('order', { title: (pane) => `Order ${(pane.params as any)?.id ?? ''}`, component: OrderPane })
    superego.tool('find_order', FoundOrder)
  },
})
```

Then, in `profile.ts`: `ui: ['./ui/order.tsx'], panes: { order: 'an order, with its lines. Params: { id }' }`. The
agent opens it with `open_pane({ kind: 'order', params: { id: '1234' } })`; so can you, with
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
| `superego.pane(kind, { title, component, menu?, opens?, folders?, width? })` | a kind of pane. `title`: a string, or `(pane) => string`. `component` gets `{ machine, thread, pane }`; `pane.params` is what it was opened with. `menu: true` offers it in the thread's pane menu (it needs no params). `opens: (path) => boolean` makes files named in the thread open in it (`/\.csv$/.test(path)`); `folders: true`, folders (`params.path`, `''` for the thread's own). `width`: share of the row, 0.5 by default |
| `superego.tool(name, component, { fold? })` | draw calls to a tool in the transcript. Gets `{ machine, thread, call: { id, name, arguments }, result?: { text, isError, details }, live?: { status, output, details } }`. `fold: false` shows them under their run of work, open, instead of folded into it: for what the agent shows you (as `images` does) |
| `superego.slot(slot, component, { order? })` | put a component in a place in the shell (below) |
| `superego.entry(kind, component)` | draw transcript entries of a kind an extension writes |
| `superego.dispatch(id, params, { machine })` | run an action outside React |

Slots a profile can fill, each given `{ machine, thread }` (and for the editor ones, `path` and `open(path)`):

| Slot | |
|---|---|
| `thread.header` | right of the thread's title: badges, small buttons |
| `composer.above` | above the message box: something waiting on the user |
| `thread.aside` | a column beside the thread |
| `editor.side`, `editor.bar` | beside a file in the editor, and in its bar |
| `overlay` | over everything: a dialog of your own, drawn while you want it |

The sidebar, work dividers, window actions and app settings are for bundled extensions (`superego --skill bundled`).

## From 'superego/ui'

Talking to the daemon:

- `useDispatch()` → `dispatch(id, params, { machine: machine.id })`: run an action (a daemon extension's, or a
  built-in like `pane.open`, `thread.submit`). Returns a promise of its result.
- `useValue<T>(machine.id, machine.state === 'connected', 'orders.recent')`: a daemon extension's live value, kept
  current. Undefined until it arrives.
- `call(machine.id, method, params)`: a raw protocol call.
- `useThreads(machine.id, connected)`, `useAllThreads()`, `useMachines()`, `useSelection()`: what the window knows.

Opening things:

```ts
dispatch('pane.open', { id: thread.id, kind: 'editor', params: { path: 'notes/a.md', line: 12 } }, { machine: machine.id })
dispatch('pane.open', { id: thread.id, kind: 'preview', params: { url: 'http://localhost:3000' } }, { machine: machine.id })
dispatch('thread.submit', { id: thread.id, text: 'Ship it' }, { machine: machine.id })
```

Components: `Button`, `IconButton`, `TextField`, `TextArea`, `Select`, `Switch`, `List`, `ListItem`, `Panel`,
`Dialog`, `Menu`, `Popover`, `Tooltip`, `StatusGlyph`, `Markdown` (render Markdown text), `FileEditor` (the file editor,
Markdown in live preview: `<FileEditor machine={machine} thread={thread} path={path} onLink={…} actions={…} />`), and
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
