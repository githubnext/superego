# The window: views, links and events

## Views and the layout

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/places-dark.svg"><img src="guide/places.svg" alt="The window: the rail and the open sidebar beside it, the thread with its header, transcript and composer.above, the column beside it, panes from the pane menu with the editor's bar and side; the title bar's stand-in, a phone's drawer and an overlay over everything"></picture>

An extension declares **views** and the places each fits. The window has **places** and knows no extension. The
**layout** decides what goes where: each view's `default`, then the user's changes, kept in the app setting
`app.layout`.

<!-- check: ui; import { ChatsIcon, CircleIcon, type SidebarRailProps } from 'superego/ui'; declare const Threads: (props: ViewProps<'window'>) => null, DetailsPane: (props: ViewProps<'thread'>) => null, EgoButton: (props: ViewProps<'window'>) => null, ThreadsRail: (props: SidebarRailProps) => null -->
```ts
superego.view('threads.list', { title: 'Threads', icon: ChatsIcon, context: 'window', fits: ['sidebar'], default: 'sidebar', component: Threads, railButton: ThreadsRail })
superego.view('threads.details', { title: 'Thread details', context: 'thread', fits: ['beside', 'pane'], component: DetailsPane })
superego.view('ego.button', { title: 'Ask Ego', icon: CircleIcon, context: 'window', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10, component: EgoButton })
```

| Place | What it is | A view there gets |
|---|---|---|
| `sidebar` | a **section**: a rail button (its `icon`, or its own `railButton` component), the sidebar while it's the one shown, and what the main area shows from it ([Sections](#sections)); on a phone, the drawer. Hidden with ⌘/, its button, dragging its edge narrow, or a tight window: `railButton` is told (`sidebarHidden`) and can draw more in the rail meanwhile (Threads' status dots). `window` views only | `{ place }` |
| `rail` | a rail button that isn't a sidebar (Ego's): it shows something alone, with no sidebar (Ego's thread, a space) | `{ place }` |
| `drawer` | on a phone, at the drawer's foot beside Settings | `{ place }` |
| `titlebar` | the title bar's start, standing in for a sidebar while there's none (the thread picker) | `{ place }` |
| `beside` | a column beside the thread | `{ place, machine, thread }` |
| `pane` | the thread's pane menu: a `thread` view that fits `pane` is a pane kind of its id | `{ place, machine, thread }` |
| `header` | right of the thread's title: a button, a badge | `{ place, machine, thread }` |

| Option | |
|---|---|
| `default` | a place, several, or none (offered only, for the user to place) |
| `narrow` | where it goes on a phone instead |
| `withoutSidebar` | where it goes while no view is in `sidebar` (Unread's bell in the rail, the picker in the title bar) |

**Where a view ends up:** the user's choice beats the view's, and on a phone the phone's layer beats the wide one. On
a phone: the layout's `narrow`, else its `place` (hidden is hidden everywhere; a place a phone lacks, like the rail,
gives way to the view's `narrow`), else the view's `narrow`, else its `default`. A view can be in two places.

**`app.layout`** holds only the user's changes: `{ place: { 'threads.details': 'beside', 'ego.button': null }, order:
{ pane: ['git.changes'] }, narrow: { place: { … } } }`. A view or place in it that doesn't exist or fit is ignored.
Views are named by id whatever declares them: a profile's view on two machines is one entry. A thread's places are
resolved from the views that thread sees, its profile's over the app's.

**Changing it from code:** dispatch `layout.place` with `{ view, place, on? }` (toggles without `on`; `from` moves it
out of that place in the same change; `narrow` changes the phone's layer). In a component,
`usePlacement(view, place)` gives `[placed, toggle]`. Both act on a thread's places for a thread (`layout.place`'s
`machine` and `thread`, else the selected one; `usePlacement`'s view's thread, else the selected one, or
`usePlacement(view, place, { machine, thread })`), and the change applies wherever the view is: a profile's view taken
out of one machine's header is out of the other's too (its menu says *For every thread with Notes*). ⌘I is
`threads.details` in `beside`.

**The user edits it as text:** Edit layout… (⌘K) opens `~/.superego/layout.json`, applied as it's saved. A mistake
(bad JSON, an unknown place, a place a view doesn't fit) is noted and the last good layout stays; a view no window has
now is kept, for when it's back. Its head of `//` comments lists the views and the places each fits
(`superego layout` prints it); your own comments below are kept.

```jsonc
{
  "place": { "threads.details": "beside", "files.folder": ["beside", "pane"], "ego.button": null },
  "order": { "pane": ["files.folder", "git.changes"] },
  "narrow": { "place": { "threads.details": "pane" } }
}
```

Also: right-click a view (its ··· beside the thread, its pane-menu entry) for *Move to*, *Remove from here* and *Edit
layout…*; a pane's ··· has *Move to*, *Maximize*, *Close*. ⌘K offers each view in each place it fits (*Show Files
beside the thread*) and *Reset layout*; so does Settings → Appearance → Layout. Settings can't be laid out away (the
rail, a phone's drawer, or its top bar). A browser keeps its own layout; *Edit layout…* opens it in a dialog.

So `default` is only where a view starts:

- Draw it to work in every place it `fits` (read `place` where it must differ), and don't assume what's beside it.
- Don't keep a setting of your own for where it shows: `usePlacement` and `layout.place` are that setting.
- Declare only places it can really be drawn in. A profile's views fit only `beside`, `pane` and `header`, in its own
  threads.
- `pane(kind, { menu: true })` is a view of the pane menu, of the kind's name, placed there by default.

**Slots** are places behaviour decides, so the layout doesn't move them (a question card sits on its composer). They
get `{ machine, thread }`; the editor's also `path` and `open(path)`.

### Data-only views

A daemon half can declare a view as data, drawn by the window's own components. No UI code ships, so a remote
machine's or a project profile's needs no consent to run in the window; its buttons still run that machine's actions.

A view shows blocks (`Block[]` from `'superego'`, the schema agents draw with): `markdown`,
`callout`, `code`, `table`, `image`, `kv`, `list` (`title`, `subtitle`, `detail`, `status`, a `thread` link,
`buttons`), `stack`, `row`, `card`, `divider`, inputs, `buttons`, and `html` (sandboxed, display only). A button runs
one of the extension's own actions (`action`: `<extension>.<name>`, exposed to `ui`) on that machine with its
`params`, the inputs' values added by input id. `[]` or null shows "Nothing here yet."

<!-- check: daemon; type Order = { id: string; customer: string; late: boolean }; declare function ship(id: string): Promise<Order[]> -->
```ts
// orders.ts, a daemon half: the open orders, as a sidebar, with a button on each
const open = superego.value<Block[]>('orders.open', [{ type: 'markdown', text: 'No open orders.' }])
const show = (orders: Order[]) => open.set([
  { type: 'markdown', text: `${orders.length} open` },
  { type: 'list', items: orders.map((o) => ({ title: `No. ${o.id}`, subtitle: o.customer, status: o.late ? 'blocked' : 'idle',
    buttons: [{ id: `ship-${o.id}`, label: 'Ship', action: 'orders.ship', params: { id: o.id } }] })) },
])
superego.action(defineAction({ id: 'orders.ship', title: 'Ship an order', params: obj({ id: str() }), run: async ({ id }) => show(await ship(id)) }))
superego.view('orders.open', { title: 'Orders', icon: 'list', context: 'window', fits: ['sidebar', 'beside'], default: 'sidebar', value: 'orders.open' })
```

- **Source:** a live value (`value`) or a method (`method`), read again as the thread moves on and after a button ran.
  A `thread` view's value is a `scopedValue` (each thread's blocks in its scope, or a plain value keyed by thread id,
  of which the window watches one entry); its method gets `{ thread }`. A thread view's buttons name their thread in
  `params`.
- To change it, set the value again. Inputs keep what the user typed, by id.
- **Places:** `thread` views fit `beside` and `pane` (a pane kind of its id; with `about`, the agent is told it can
  open it); `window` views, `sidebar` and `beside`. A profile's fit only its own threads' `beside` and `pane`, except a
  `window` view of one of the user's own profiles, which can be a sidebar while the profile is loaded (a thread of it
  in use or starting).
- A view a machine declares shows that machine's threads only; a `window` view gathers every machine's, each under
  its name. A UI half declaring a view of the same id draws it instead. The window hears of them as each daemon's
  `view.list` value.
- **Checked on arrival.** A declaration must belong to one of that machine's extensions that's on, be named for it (id
  and source `<extension>.<name>`), name places that exist (one carrying a profile's folders is never a sidebar), and
  stay in bounds; else it's left out, with a console warning. Blocks are checked whole
  (`blockErrors(blocks, { by: 'extension', extension, thread })`): a button running another's action or none, a params
  key that's also an input id, inputs with no button, a `window` view's `open` link or image by path, or anything over
  the limits refuses the view, which shows its first error.
- Example: the `skills` extension's *Skills* (`extensions/skills/src/daemon.ts`).

### Sections

The rail picks what the whole window is about. Each `sidebar` view is a **section**: its sidebar is where you pick,
the main area what you picked there, and exactly one rail button is lit. Picking one shows its section as it was left:

- a sidebar whose extension (or global profile) declares spaces holds those: Notes' list, the note last opened from it;
  until one is, the main area says nothing's open;
- any other sidebar holds threads: Threads, Staff's board of leads, each with the thread last picked in it and its panes.

What's shown from elsewhere takes its section with it: a `note:` link lights Notes, a thread from ⌘L or a notification
stays in the thread section shown (else goes to the last one), a project's space is the Threads section's (a row in its
list). A rail button that opens something no sidebar holds (Ego's thread, a space of its own) shows it alone, with no
sidebar and only that button lit: `<RailButton on>` while it's shown. A view about the thread shown isn't a section: it
goes beside the thread or in a pane.

### Spaces

A **space** fills the main area where a thread otherwise shows: a notes page, a canvas. An app extension's UI half,
a global profile's (`global: true`, [profiles.md](profiles.md#global-profiles)) or a project's profile's registers it
(where the profile lives says how far it reaches); your other profiles can't.

<!-- check: ui; import { NotebookIcon, type SpaceProps } from 'superego/ui'; declare const NotePage: (props: SpaceProps) => null -->
```tsx
superego.space('notes.page', {
  title: (params) => String(params.name),          // the title bar, history; or a string
  icon: NotebookIcon,
  component: NotePage,                             // { machine, kind, params, thread, open(params) }
  match: 'note:',                                  // links of this scheme open it, in any Markdown (an agent's answer too)…
  params: (href) => ({ name: href.slice(5) }),     // …with these params (default { href })
  about: (params) => `The user has the note "${params.name}" open.`,  // a thread started on it is told this first
  profile: 'notes',                                // the profile that thread runs (default: the machine's)
  agent: 'docked',                                 // its thread as a column beside it, or 'floating': a card over it
  entry: { name: 'Index' },                        // a project's: the params it opens with from its row (default {})
})
```

- **Open one** with the window action `space.open` (`{ kind, params, machine?, project? }`, default this computer):
  `superego.dispatch('space.open', { kind: 'notes.page', params: { name } })`. Another client can ask a window to
  (`client.perform`). In the component, `open(params)` replaces it with another of its kind.
- It opens in its section ([Sections](#sections)): the sidebar of its extension, if it has one; else alone. The title
  bar shows its title and a button to show or hide its thread. Back and forward go through spaces as through threads;
  selecting a thread leaves the space.
- **Its thread:** one per space (kind, machine, params), remembered by the window. With none, sending in the column
  starts one on the space's `profile`, its first message `about(params)` then yours, and docks it. It's listed in the
  sidebar; ↗ opens it as the thread, ✕ undocks it. The component gets it as `thread`. The profile's daemon half gives
  the agent tools to work on what the space shows, and live values the component watches.
- **Its title:** `useSpaceTitle(title)` (`superego/ui`) says what it's called now (a note's heading): the title bar
  and a thread started on it take that, remembered; until then, `title(params)`.
- `inset.right` (also `--space-inset-right`) is how much a floating thread covers, to keep controls clear.
- A global profile's window views get `machine`, the one its profile is on.
- **Testing:** `mountUi({ profile: { extensions: [ui], global: true } })`; `render({ space: { kind, params } })` draws
  one with its thread; `window.space()` says what the main area shows.
- On a phone, a space is the whole screen; its thread opens as the thread, from the title.
- **A project's:** a project's profile's spaces are that project's, on its machine (its root: the folder whose
  `.superego/profiles` holds the profile). Each kind is a row under the project's heading in Threads (▦ and its title,
  above its threads), opened in the Threads section, Threads lit. They open with `entry`
  (`space.open` with `project: <root>`). Their links open them only from the project's threads and spaces. Of two of
  the project's profiles declaring one kind, its `default`'s wins. A thread started on one starts in the project's
  folder, on its `profile` or the project's default. Testing: `mountUi({ profile: { ref: { scope: 'project', name,
  dir: '<root>/.superego/profiles/<name>' }, extensions } })`; `render({ space: { kind, params, project: root } })`.
- While a space is open, only it is lit: its row, not a thread's.

### On a phone

Below 600px wide there's no rail and no title bar. The section shown's sidebar is the drawer, the other sections to
switch to at its foot (the main area with them) with `drawer` views (Ego, Unread) and Settings. The thread's title opens its **sheet**: `header` views, where it
runs, archiving, the pane menu and `beside` views. With no sidebar there's no drawer: `titlebar` views and Settings
go in the top bar. `narrow` moves a view elsewhere on a phone.

## Links

A link in a message, ⌃O's list, or a Markdown file (rendered or live preview) is followed by the first handler that
claims it:

1. **the thread's profile's** (`superego.link` in its `ui`), in its own threads;
2. **the extensions'**, in set-up order, minus optional ones the thread goes without (`threads` claims `thread:<id>`,
   and `thread:<machine>/<id>` by machine name or id);
3. **the core's**: files a thread names (relative links, inline code that reads as a path, `wikilink:`) open in the
   pane kind that takes the file; web pages (`http:`, `https:`, `mailto:`) open in the browser, or beside in a pane
   with `urls: true` (Browser).

Unclaimed links open in the browser; in HTML, an unclaimed scheme's links are dropped. To open links your own way,
claim them: nothing else to switch off.

`superego.link({ match, open, render?, target?, scheme? })`:

| | |
|---|---|
| `match` | a scheme (`'ticket:'`), a pattern (`/^https:\/\/linear\.app\//`), or `(href, kind, where) => boolean`, which also sees inline code (`kind: 'code'`, its text as `href`) |
| `open(href, { machine, thread, beside, kind, openFile, openUrl })` | follow one: a click (⌘: `beside`) or from ⌃O. Return (or resolve to) a string to say why it couldn't: the link is struck through with it |
| `render` | gets `{ href, children, code, title, where, open(beside) }`; default: a link that follows it |
| `target(href)` | where it goes, in ⌃O's list |
| `scheme` | the scheme a pattern or test claims (`'ticket'`), so HTML files keep its links |

`[[Note#Heading|alias]]` arrives as `wikilink:Note#Heading` (each part URI-encoded), with "alias" as its text;
`parseWikilink(href)` gives `{ target: 'Note', heading: 'Heading' }` (or `block` for `#^id`). A profile that keeps
notes its own way:

<!-- check: ui -->
```tsx
// In a profile's ui/note.tsx: [[wikilinks]] open the vault's own note pane, found by the vault's rules.
superego.link({
  match: 'wikilink:',
  open(href, { machine, thread }) {
    const { target, heading } = parseWikilink(href)!
    return superego.dispatch('pane.open', { thread: thread!.id, kind: 'note', params: { path: target, heading } }, { machine })
      .then(() => undefined, (error: Error) => error.message)
  },
  target: (href) => parseWikilink(href)!.target,
})
```

Claiming files takes a test: `match: (href, kind) => /\.md$/.test(href)` takes Markdown links and paths in code,
ahead of the core's. The core keeps the file and web defaults (not `files` or `browser`, which are optional), so links
work in threads without them.

## Hearing the window

`superego.on` tells a UI half what happens in the window. It's owned like any registration and stops at teardown. A
thread that goes without the extension isn't heard of; a profile hears only its own threads.

<!-- check: ui; import { unread } from 'superego/unstable' -->
```ts
// A thread wants a look while the window is in the background: say so in the window's title.
superego.on('thread.status', ({ thread, before }) => {
  if (before === undefined || (superego.window.focused && superego.window.visible)) return
  if (unread(thread)) document.title = `• ${thread.title}`    // finished, failed or needs you
})
```

`superego.window` is the state as the event arrives: `focused`, `visible`, the `selection` and its `thread`, the
`machines` and each one's `threads` in use (by machine id). The core marks a finished thread seen the same way, on
`select`, `focus` and `thread.status`. Notifications and the app icon's count are the app's (Settings →
Notifications): an extension needn't notify.

`auth.rejected` (`{ machine, rejection }`, a `ProviderRejection`) is a machine's provider rejecting its credentials,
once however many threads it stops. Those threads are `blocked` with kind `auth` (`waitingForSignIn`), quiet, and
resume once signed in again; `unread` ignores them, and the app notifies once for all.
