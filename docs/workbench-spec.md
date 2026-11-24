# Workbench: spaces and global profiles (prototype spec)

Direction A (a space in the main area, a thread docked beside it), with B's floating agent as an option a space
picks. Built on the `staff-space` branch. This is the contract the core implements and the `notes` and `canvas`
profiles build on.

## Global profiles

`defineProfile({ global: true, … })`, in one of **your own** profiles (`~/.superego/profiles/<name>` or a profile
source). A project's profile with `global` is refused (a problem, and it's treated as not global).

- The daemon loads every global profile as it starts, so its daemon halves run for the daemon's life (not only once a
  thread of it is in use).
- `profile.list` says `global: true` for one.
- The window loads a global profile's UI as the machine connects (and again when the window comes to the front, if its
  files changed), and installs it **as the app's**: its views may go in any place (`sidebar`, `rail`, …), its slots
  and tool rows apply to every thread, its styles are the window's, its actions are always offered. It can register
  spaces.
- A remote machine's global profile UI still needs allowing on this computer, as any remote profile UI does.

## Spaces

A space fills the window's main area, where a thread otherwise shows: a notes page, a canvas. Registered by an app
extension or a global profile's UI half:

```ts
superego.space('notes.page', {
  title: (params) => String(params.name),          // or a string: the title bar, history, ⌘K
  icon: NotePencilIcon,                            // optional, from 'superego/ui'
  component: NotePage,                             // gets SpaceProps
  match: 'note:',                                  // optional: links of this scheme open it…
  params: (href) => ({ name: href.slice(5) }),     // …with these params (default: { href })
  about: (params) => `The user has the note "${params.name}" open in Notes.`, // what a docked thread starts with
  profile: 'notes',                                // the profile a thread started from it runs (default: none, the machine's default)
  agent: 'docked',                                 // 'docked' (a column beside it, default) or 'floating' (a card over it)
})
```

`kind` is `<extension>.<name>`. `params` is JSON (an object), the same as a pane's.

```ts
type SpaceProps = {
  machine: MachineEntry          // the machine it was opened on
  kind: string
  params: Record<string, Json>
  /** The thread docked to it, if one is. */
  thread: ThreadInfo | undefined
  /** Show another of this kind in its place (a link from one note to another): history keeps both. */
  open(params: Record<string, Json>): void
}
```

**Opening one:** the window action `space.open` with `{ kind, params, machine? }` (machine defaults to `local`):
`superego.dispatch('space.open', { kind: 'notes.page', params: { name: 'workbench' } })`, or `useDispatch()` in a
component. A link `note:workbench` in any Markdown (an agent's answer too) opens it, through the space's `match`.

**What the window does with it:**
- The main area shows the space; the title bar its title (and back/forward goes through spaces as through threads).
- Selecting a thread (sidebar, ⌘K) leaves the space; Back returns to it.
- **The docked thread**: one per space (by kind and params), remembered in the window. With none, the column offers
  "Ask about this…": sending starts a thread on the space's machine with `profile`, its first message `about(params)`
  and then what was typed; that thread is docked from then on, and listed in the sidebar like any other. The column
  shows the thread's transcript and composer; ✕ undocks (the thread stays), "Open as thread" selects it. A button in
  the title bar shows or hides the column. With `agent: 'floating'`, the same, as a card over the space's right side.
- On a phone: the space full screen; the docked thread opens as the thread (no column).

## What a profile's UI may import

`'react'`, `'react/jsx-runtime'`, **`'react-dom'`, `'react-dom/client'`** (new: the window's own), `'superego/ui'`,
`'superego/unstable'`, and its own files by relative path, **including plain `.js`/`.mjs` files** (a vendored library,
bundled with its dependencies but with React left as bare imports). CSS goes in through `superego.style(css)`.

## The agent's side

Nothing new in the core: a space's profile gives its threads tools (`superego.agent` in its daemon half) that act on
what the space shows, and keeps the window in step through live values. A thread knows what it's docked to from its
first message (`about`); a profile can say more on each message with `beforeSend`.
