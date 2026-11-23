# The window: views, links and events

## Views and the layout

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/places-dark.svg"><img src="guide/places.svg" alt="The window: the rail and the open space beside it, the thread with its header, transcript and composer.above, the column beside it, panes from the pane menu with the editor's bar and side; the title bar's stand-in, a phone's drawer and an overlay over everything"></picture>

An extension declares **views**: what it offers, and the kinds of place each fits. The shell has **places**, and knows
no extension. The **layout** decides what goes where: each view's `default`, then the user's changes, kept in the app
setting `app.layout` as `app.keys` keeps shortcuts.

<!-- check: ui; import { ChatsIcon, LifebuoyIcon, type SpaceRailProps } from 'superego/ui'; declare const Threads: (props: ViewProps<'window'>) => null, DetailsPane: (props: ViewProps<'thread'>) => null, EgoButton: (props: ViewProps<'window'>) => null, ThreadsRail: (props: SpaceRailProps) => null -->
```ts
superego.view('threads.list', { title: 'Threads', icon: ChatsIcon, context: 'window', fits: ['space'], default: 'space', component: Threads, railButton: ThreadsRail })
superego.view('threads.details', { title: 'Thread details', context: 'thread', fits: ['beside', 'pane'], component: DetailsPane })
superego.view('ego.button', { title: 'Ask Ego', icon: LifebuoyIcon, context: 'window', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10, component: EgoButton })
```

| Place | What it is | A view there gets |
|---|---|---|
| `space` | a button in the rail (its `icon`, or its own `railButton` component), and the sidebar while it's the open one; on a phone, the drawer. The sidebar is shown or hidden (⌘/, the open space's button, its edge dragged narrow; a tight window hides it by itself): its `railButton` is told so (`sidebarHidden`), and can draw more in the rail while it's hidden (Threads' status dots); a space without one just hides | `{ place }`; a `thread` view, the thread shown |
| `rail` | a button in the rail that isn't a space (Ego's) | `{ place }` |
| `drawer` | on a phone, at the drawer's foot beside Settings, where there's no rail | `{ place }` |
| `titlebar` | at the title bar's start: what stands in for a space while there's none (the core's thread picker) | `{ place }` |
| `beside` | a column beside the thread | `{ place, machine, thread }` |
| `pane` | the thread's pane menu: a `thread` view that fits `pane` is a pane kind of its id | `{ place, machine, thread }` |
| `header` | right of the thread's title: a button, a badge | `{ place, machine, thread }` |

- `default` is a place, several, or none (offered, not placed: the user puts it somewhere). `narrow` is where it goes
  on a phone instead. `withoutSpaces` is where it goes while no view is in `space` (Unread's bell in the rail, the core's
  picker in the title bar).
- `app.layout` holds only what the user changed: `{ place: { 'threads.details': 'beside', 'ego.button': null }, order:
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
  component, `usePlacement(view, place)` gives `[placed, toggle]`. ⌘I is `threads.details` in the `beside`, or not.
- Both read and change a place as it's drawn: a thread's place (`beside`, `pane`, `header`) for a thread, as the views
  that thread sees declare them; the window's places for the window. `layout.place` takes the thread as `machine` and
  `thread` (its id), else the selected one; `usePlacement` the thread its view is drawn for (in a thread's place or
  pane), else the selected one, or `usePlacement(view, place, { machine, thread })`. The change is kept by view id, as
  the layout keeps it, so it applies in every thread that has the view: a profile's view taken out of one machine's
  header is out of the other's too. The view's menu says so (*For every thread with Notes*) when the id is declared
  in more than one scope; and the layout file's list gives such an id every place any of them fits.
- The user edits the layout as text: *Edit layout…* (⌘K) opens `~/.superego/layout.json`, `app.layout` as a file,
  applied as it's saved; a mistake (bad JSON, a place there isn't, a place a view doesn't fit) is noted and the last
  good layout stays, and the file is left as typed until it reads. A view it names that no window has now is applied
  all the same and only noted, for when it's back. Its head of `//` comments lists the views the windows declared and
  the places each fits, and `superego layout` prints it; comments of your own below it are kept. For example:

  ```jsonc
  {
    "place": { "threads.details": "beside", "files.folder": ["space", "pane"], "ego.button": null },
    "order": { "pane": ["files.folder", "git.changes"] },
    "narrow": { "place": { "threads.details": "pane" } }
  }
  ```

  A right-click on a view in the window (its ··· beside the thread, its entry in the pane menu) has *Move to*, *Remove
  from here* and *Edit layout…*; a pane's ··· has *Move to* among the pane's own (*Maximize*, *Close*). ⌘K offers each view in each place it fits and isn't in (*Show Files beside the thread*), and *Reset
  layout*. Settings → Appearance → Layout has *Edit layout…* and *Reset*, and no layout can take Settings away: the
  rail always has it, and a phone's drawer, or its top bar while there's no space. A browser keeps its layout itself:
  there *Edit layout…* opens it in a dialog. So `default` is only where a view starts. Draw it to work in every place it `fits`
  (read `place` when it must differ: a menu's side, a button's size), never assume another view sits beside it, and
  don't keep a setting of your own for where it shows: `usePlacement` and `layout.place` are that setting. Declare
  only the places it can really be drawn in.
- `pane(kind, { menu: true })` is a view of the pane menu, of the kind's name, placed there by default.
- A profile's views fit only the places that show a thread (`beside`, `pane`, `header`), in its own threads.

Slots are places that behaviour decides, so the layout doesn't move them: a question card sits on the composer it asks
for. They get `{ machine, thread }`; the editor's also `path` and `open(path)`.

### Data-only views

A daemon half can declare a view as data, and the window draws it with its own components: no UI code ships, so a
remote machine's, or a project profile's, needs no consent to run code in the window, as its UI code would. That's
not no authority: its buttons run that machine's actions. What a view shows is blocks (`Block[]` from `'superego'`),
the schema agents draw with: `markdown`, `callout`, `code`, `table`, `image`, `kv`, `list` (rows: `title`, `subtitle`,
`detail`, `status`, a `thread` to link, `buttons`), layout (`stack`, `row`, `card`, `divider`), inputs, `buttons`, and
`html` (a sandboxed page, display only). A button runs one of the extension's own actions (`action`:
`<extension>.<name>`) on that machine with its `params`, as the window may (one exposed to `ui`); the inputs' values go
into the params by input id. `[]` or null shows "Nothing here yet."; say more with a `markdown` block.

<!-- check: daemon; type Order = { id: string; customer: string; late: boolean }; declare function ship(id: string): Promise<Order[]> -->
```ts
// orders.ts, a daemon half: the open orders, as a space, with a button on each
const open = superego.value<Block[]>('orders.open', [{ type: 'markdown', text: 'No open orders.' }])
const show = (orders: Order[]) => open.set([
  { type: 'markdown', text: `${orders.length} open` },
  { type: 'list', items: orders.map((o) => ({ title: `No. ${o.id}`, subtitle: o.customer, status: o.late ? 'blocked' : 'idle',
    buttons: [{ id: `ship-${o.id}`, label: 'Ship', action: 'orders.ship', params: { id: o.id } }] })) },
])
superego.action(defineAction({ id: 'orders.ship', title: 'Ship an order', params: obj({ id: str() }), run: async ({ id }) => show(await ship(id)) }))
superego.view('orders.open', { title: 'Orders', icon: 'list', context: 'window', fits: ['space', 'beside'], default: 'space', value: 'orders.open' })
```

- The source is a live value of the extension's (`value`), or a method of its (`method`), read again as the thread
  moves on and after a button ran. A `thread` view's value is a `scopedValue`, each thread's blocks in its scope (or a
  plain value holding each thread's by its id: the window watches only that entry), and its method is called with
  `{ thread }`. A thread view's buttons say their thread in `params`.
- Blocks bind to nothing: to change what a view shows, set its value again. The inputs keep what the user typed, by id.
- Data views fit `space`, `beside` and `pane` (a `window` view: `space` and `beside`), and the layout places them as any
  other. A `thread` view in `pane` is a pane kind of its id; with `about`, the agent is told it can open it.
- The window hears of them as every daemon's live value `view.list`. A view a machine's extension declares shows a
  thread only from that machine, and a `window` view gathers every machine's, each under its name. A profile's fit only
  `beside` and `pane`, in its own threads; but a `window` view of one of the user's own profiles (not a project's) is
  the window's, as a bundled extension's: a space too. It's there while the profile is loaded: once a thread of it is
  in use (the daemon loads those as it starts) or starts. An extension's UI half that declares a view of the same id
  draws it instead.
- The window checks what it's sent as it lands, not on the machine's word. A declaration must be of one of that
  machine's extensions that's on, named for it (its id and its source `<extension>.<name>`), in places there are (a
  view carrying a profile's folders never a space), and within bounds; one that isn't is left out, with a warning on the console. Blocks are
  checked whole (`blockErrors(blocks, { by: 'extension', extension, thread })`, from `'superego'`, says what a window
  would): a button that runs another's action or none, a params key that's also an input's id, inputs with no button,
  a `window` view's `open` link or image by path, or more than the limits allow refuses the view, which shows its first
  error in its place.
- The `skills` extension's *Skills* is one (`extensions/skills/src/daemon.ts`).

### On a phone

Below 600px wide there's no rail and no title bar. `space` views are the drawer, with the others to switch to at its
foot beside `drawer` views (Ego, Unread) and Settings. The thread's title opens its **sheet**, which holds the title
bar's (`header` views, where it runs, archiving), the pane menu, and the `beside` views. With no space there's no
drawer: `titlebar` views (the thread picker) and Settings are in the bar at the top instead.
`narrow` moves a view elsewhere on a phone.

## Links

A link in a message, in ⌃O's list, or in a Markdown file (rendered, or clicked in live preview) is followed by the
first handler that claims it, asked in this order:

1. **the thread's profile's** (its `ui` files' `superego.link`), only in that profile's threads;
2. **the extensions'**, in the order they're set up, but not those of an optional one the thread goes without
   (`threads` claims `thread:<id>`, and `thread:<machine>/<id>` for one on another machine, by its name or id);
3. **the core's**, the defaults: files a thread names (relative links, inline code that reads as a path, and
   `wikilink:`), which open in the pane kind that takes the file, and web pages (`http:`, `https:`, `mailto:`), which
   open in the browser, or beside in a pane that shows web pages (`urls: true`, `browser`'s Browser).

A link no handler claims opens in the browser; an HTML link of a scheme none claims there is dropped. So to open
links your own way, claim them: nothing else to switch off. `[[Note#Heading|alias]]` reaches handlers as
`wikilink:Note#Heading` (each part URI-encoded), saying "alias"; `parseWikilink(href)` gives
`{ target: 'Note', heading: 'Heading' }` (or `block` for `#^id`). A profile that keeps notes its own way, say:

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

Return (or resolve to) a string to say why it couldn't: the link is struck through with it. Claiming files is the
same with a test: `match: (href, kind) => /\.md$/.test(href)` takes Markdown links and paths in code alike, ahead of
the core's. The core's file and web handlers stay the core's rather than `files`' or `browser`'s: both extensions
are optional, and a link to a file or a page has to work in a thread that goes without them.

## Hearing the window

`on` tells a UI half what happens in the window, whatever it draws. Listening is owned like everything else, and stops
at teardown. A thread that goes without the extension isn't heard of; a profile hears only its own threads.

<!-- check: ui; import { unread } from 'superego/unstable' -->
```ts
// A thread wants a look while the window is in the background: say so in the window's title.
superego.on('thread.status', ({ thread, before }) => {
  if (before === undefined || (superego.window.focused && superego.window.visible)) return
  if (unread(thread)) document.title = `• ${thread.title}`    // finished, failed or needs you
})
```

Notifications and the app icon's count are the app's own (Settings → Notifications): an extension needn't notify.

`window` is how things are as the event arrives: `focused`, `visible`, the `selection` and the `thread` it shows, the
`machines` the window reaches and each one's `threads` in use (by machine id). The core marks a finished thread seen the same way, on `select`, `focus` and `thread.status`.

`auth.rejected` is a machine's provider rejecting its credentials (`{ machine, rejection }`, a `ProviderRejection`):
once, however many threads it stops. Those threads are `blocked` with kind `auth` (`waitingForSignIn`), quiet on their
own, and go on by themselves once the machine is signed in again; `unread` says nothing of them, and the app notifies
once for all.
