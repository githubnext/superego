# Blocks: one JSON UI for agents and extensions

**Status:** Lanes 1 (blocks into the core) and 2 (data views draw blocks, extension API 3.0) are done; Lane 3 is to
come, and most of it went with Lane 2 (see its notes). Merges data views' content (`ViewContent`) into
blocks.

Superego has two JSON schemas for "UI as data, drawn by the window's own components":

- **Blocks** (`packages/blocks`): what an agent draws with `show_ui`, `ask_ui`, `open_ui` and `update_ui`
  (`extensions/agent-ui`). The schema has 20 block types, a strict checker, a React renderer, and a sandboxed `html` frame.
  Replies go back to the thread.
- **Data views** (`packages/protocol/src/views.ts`, `packages/app/src/renderer/data-views.tsx`,
  `data-view-check.ts`): a daemon half declares a view with `superego.view(id, { …, value | method })`, and its content
  is a `ViewContent` (`note`, `facts`, `items`, `table`, `markdown`, `actions`, `empty`). The window draws it with no
  extension code, so a remote machine or a project profile needs no consent. Its buttons run the extension's own
  machine actions.

Data views' content model is mostly a subset of blocks. It has its own checker (201 lines), its own renderer, and
its own tests. This design keeps one schema, one checker and one renderer. **Who drew the blocks decides what they
can do.**

The design has two halves:

- **The declaration half of data views stays as it is.** That covers `DataView`, `fits`, `default`, `narrow`, `order`,
  `value`/`method`, `about`, `view.list` and the registry's placement.
- **What a view shows becomes `Block[]`.**

---

## 1. The one schema

### What data views have that blocks lack

| Data views | Blocks today | After |
| --- | --- | --- |
| `note` | `markdown` | `markdown` |
| `facts` | `kv` | `kv` |
| `table` | `table` | `table` |
| `markdown` | `markdown` | `markdown` |
| `items` (title, subtitle, detail, status glyph, thread link, row buttons) | none | **new `list` block** |
| `actions` (a button runs `<extension>.<name>` with `params`) | `buttons` (reply only) | **`buttons[].action` + `params`**, extensions only |
| a button's `icon` | none | dropped. Row buttons are small text buttons |
| `empty` | none | dropped. A view whose source holds `[]` or null shows the window's "Nothing here yet."; an extension wanting its own words returns a `markdown` block |
| size limits (`LIMITS`: rows, items, text length, params depth/size) | none | **in the schema**, for both (see §4) |

That's the whole gap. Data views never had inputs, layout, code, images or pane links. Blocks have all of them, and
§2 says which an extension view gets.

### The additions

```ts
/** A button: answers or messages (an agent's), or runs one of its extension's actions (an extension's). */
type Button = { id: string; label: string; style?: 'primary' | 'danger'; action?: string; params?: { [key: string]: Value } }

type ListItem = {
  title: string
  subtitle?: string
  /** At the row's end, small: "5m", "+3". */
  detail?: string
  /** A status glyph before it, as threads have. */
  status?: 'idle' | 'working' | 'done' | 'blocked' | 'error'
  /** A thread on the same machine: the title links to it. */
  thread?: string
  buttons?: Button[]
}

type Block =
  | /* …the 20 there are… */
  | { type: 'list'; items: ListItem[] }
  | { type: 'buttons'; buttons: Button[] }   // Button gains action/params
```

- **`list` is for everyone.** Agents managing threads (a Chief of Staff, a reviewer of child threads) get the same
  rows with status glyphs and thread links that extensions do. Each row's `buttons` carry ids that are unique like any
  other.
- **Row buttons' replies say the row.** `describeReply` words a row button's press as `→ Cancel: npm run build`, not a
  bare `→ Cancel`, because rows repeat the same label.
- **`action`/`params` are left out of the agent's guide.** The agent's check refuses them (§2), so the agent never
  needs to read about them.

### What the agent sees

The guide (`BLOCKS_GUIDE`, now 1,747 characters, sent once as the `ui_blocks` prompt section) gains one line, about
150 characters (+9%):

```text
- list {items: [{title, subtitle?, detail?, status?: idle|working|done|blocked|error, thread?, buttons?}]}: rows; thread links a thread by its id.
```

Nothing else changes for agents. The limits, `action`, `params`, and the rules for extension views stay out of the
guide: the checker's error messages teach them when they matter.

### Where it lives

- **The schema moves into `@superego/protocol` (`src/blocks.ts`).** That covers types, `BLOCKS_SCHEMA`,
  `blockErrors`/`checkBlocks`, `describeReply`, `initialValues` and `BLOCKS_GUIDE`. It has no React, and
  `pi-schema` is already a dependency of protocol. Blocks now cross the wire as a machine's view content, so they belong
  with the other wire types. The daemon, the window, agent-ui and the SDK's `'superego'` all import it from there.
- **The renderer moves into the window (`packages/app/src/renderer/blocks/`, with `frame.html` and its CSS).** The
  core draws data views itself, so the renderer must be core. Today `@superego/blocks/ui` imports `@superego/app/ui`,
  so the app can't import it back without a cycle.
- **`packages/blocks` is deleted.** agent-ui imports `Blocks` from `@superego/app/ui`, as it imports the rest of the
  window already.
- **The stable `superego/ui` doesn't export `<Blocks>` yet** (open question 5).

---

## 2. Who can use what

**One renderer and one schema serve everyone. What differs is the host:** what the blocks were drawn by, which decides
what pressing does and what the checker allows.

```ts
/** Who drew the blocks, for the check: what they may contain. */
type BlocksUse =
  | { by: 'agent' }
  | { by: 'extension'; extension: string; thread: boolean }   // thread: a `thread` view (vs a `window` one)

/** What pressing does, for the renderer. */
type BlocksHost =
  | { by: 'agent'; reply?(reply: Reply): Promise<unknown> }            // none: only shown (an answered ask_ui)
  | { by: 'extension'; extension: string; run(action: string, params: Json): Promise<unknown> }

blockErrors(blocks, use): string[]
<Blocks machine thread? blocks host answer? submitLabel? />
```

`<Blocks>` checks with the use its host implies. It draws nothing but the first error, in place, if the check fails
(§4).

| | An agent's (agent-ui) | An extension's view (a daemon half's `superego.view`) |
| --- | --- | --- |
| Display blocks, `list`, layout | yes | yes |
| `buttons` / row buttons | `id` only. Pressing **answers** (ask_ui) or **sends the user's next message** (show_ui, a pane). `action` refused | `action` required: `<extension>.<name>`, run on that machine with `params` and `exposure: 'ui'`. Another extension's or the core's is refused |
| Inputs | yes. Values go with every press | yes. Values go with every press, **merged into the action's params** by input id. A params key that's also an input id is refused (open question 2) |
| Submit button / a lone choice that answers | yes | no: an extension view needs explicit buttons, since there is nothing to "submit" to |
| `html` | sandboxed. `superego.reply`/`send` on a user gesture | sandboxed, **display only**: the frame is told it can't reply, so `superego.reply`/`send` are absent (open question 4) |
| `open` (a pane link) | its thread's panes | `thread` views only. A `window` view has no thread, so it's refused there |
| `image` by path | a file in the thread's folder | `thread` views: the thread's folder. `window` views: `https:`/`data:` only |
| `list[].thread` | a link on the same machine | the same |

**Profiles** fall out of this table. A profile's daemon half is an extension: its views use the extension column, in
its own threads only, in `beside` and `pane` as today. A profile's UI half draws whatever it likes with its own React,
so it doesn't need blocks (open question 5).

**What an agent never gets: a button that runs an action.** Not even with a confirmation. The label is the model's,
and the model may be following injected text, so "Continue" could run `machine.remove`. The user would be the confused
deputy. An agent that wants something done asks with a reply button and does it itself, with its own tools, where its
permissions and transcript apply.

**Agent-ui's pane stays agent-ui's.** Its `ui` pane is many panes per thread (params `{ id }`), each answering to the
thread. A data view is one view per id, with no params, answering to an extension. They share the renderer, not the
declaration.

---

## 3. Live data

A view stays current by being **one value, computed on its machine**:

1. **The source is the whole view.** A view's `value` (a live value, a scoped value for a `thread` view) or `method`
   yields `Block[] | null`. A value pushes: the extension sets new blocks, and every window watching redraws. A method
   pulls, re-read as now: as the thread moves on (a `window` view: any thread on the machine), and after one of the
   view's buttons ran. Agents already work this way: `update_ui` sends new blocks.
2. **Nothing inside blocks binds to anything.** No `{ $value: 'x' }`, no templates, no expressions, no conditionals,
   no client-side state but the inputs' values. To change what's shown, publish new blocks. This one rule keeps blocks
   from becoming a framework. Every "it would be nice if a cell updated by itself" is answered by "set the value
   again". At the sizes the limits allow, re-sending a whole view is cheap.
3. **A redraw keeps what the user typed.** Input values persist by input `id` across redraws. A new id starts at its
   default, and a gone id is dropped. The extension can publish every second without eating the user's typing. Agent
   panes keep their current rule: `update_ui` starts the inputs over, keyed by `at`, because the agent said "this is
   the UI now".

Agents get no live sources. An agent can't publish values, and `update_ui` is its "live". Binding an agent's blocks
to a machine value would add prompt cost and the framework rule 2 refuses.

---

## 4. Security

**The invariant both share:** nothing in the schema runs code in the window's JavaScript. Blocks are data drawn by the
window's components. `html` runs in the sandboxed frame (`allow-scripts` only, an opaque origin, no reach into the window's own `superego`,
messages only through `postMessage` to the host). This invariant is why one renderer is safe for both, and why a remote
machine's or a project profile's view needs no consent, as data views need none today.

**An agent's blocks can:**
- show things
- take input
- answer the agent or send a message to its own thread, as the user, on the user's press only. The frame gates
  `reply`/`send` on user activation.
- open a pane of its own thread
- show an image from its thread's folder (read through the machine, as the window reads any of a thread's images) or
  from the web

**An agent's blocks can't** run any action, dispatch anything, reach another thread or machine, or touch the window's
JS. The checker refuses `action`. The agent host has no `run`.

**An extension's view can also** run that extension's own actions on that machine, exposed to `ui`, on the user's press.
`runViewAction`'s checks stay as they are:
- the prefix check, in the window, against the extension the declaration names
- `action.run` with `exposure: 'ui'`, so the daemon refuses an action not exposed to the UI
- logged through the router as `view → <machine>`

The action validates its own params. A thread view's button must say its thread in `params`, as today.

**An extension's view can't:**
- run another extension's or the core's actions
- reply or send to a thread: an extension that wants that has an action that calls `threads.send`
- give its `html` a voice
- draw outside the places its declaration fits. A profile's view never goes in `space`.

**Checked where it lands, whole.**
- **Every window checks** with `blockErrors(blocks, use)` before drawing. A remote machine, or one of another version,
  isn't the window's to trust. The daemon doesn't check view content: it's an opaque value until a window reads it.
  `blockErrors` is exported for extensions' tests.
- **A failing view is refused whole, not trimmed.** It shows its first error where it would have drawn, and every
  error goes to the console. This replaces data views' "drop what's wrong, show a quiet word" (`checkContent`,
  `warnDropped`, `.data-view__dropped`): a partly drawn view hides the bug, and refusal is what blocks do already.
  Declarations (`checkDataViews`) still drop per declaration, so one bad view doesn't take every view of the machine
  with it.
- **The limits move into the schema** (`maxItems`, `maxLength`, a depth limit checked in `walk`). They follow data
  views' current `LIMITS`:

  | Field | Limit |
  | --- | --- |
  | text | 2,000 |
  | markdown and code | 100,000 |
  | `list.items` | 500 |
  | table rows | 1,000 |
  | columns | 50 |
  | buttons per row or block | 20 |
  | `params` | 16 KB of JSON, 16 deep |
  | nesting | 8 deep |
  | `image.src` | about 2 MB for a `data:` URL |

  Agents' blocks get the same limits. A model never comes near them, and they keep `update_ui` from bloating a thread's
  state. None of it goes in the guide.

**What `html` adds for extension views, and why it's acceptable.** Today a remote machine's agent can already put an
`html` block in your window. An extension's view can't do more with it than an agent can, and with replies off it can
do less. The frame can reach the network, but what's in it is the machine's own data, which that machine's code could
already send anywhere.

---

## 5. What gets deleted, and the migration

### Deleted

| Where | What |
| --- | --- |
| `packages/blocks` | the package: `blocks.ts` moves to protocol, `ui.tsx`/`frame.html`/`styles.css` to the app's renderer, the test to protocol. The root `tsconfig.json` reference and agent-ui's dependency go too |
| `packages/protocol/src/views.ts` | `ViewContent`, `ViewItem`, `ViewAction`. `DataIcon`/`DATA_ICONS` **stay**, for the declaration's icon (the rail, a tab): that's placement, not content |
| `packages/app/src/renderer/data-view-check.ts` | `checkContent`, `params`, `contentOf`, the content half of `LIMITS`. `checkDataViews` (declarations) and its limits stay |
| `packages/app/src/renderer/data-views.tsx` | `DataContent` and `ActionButton`. `DataViewBody`, `Source`, `FromValue` and `FromMethod` stay and draw `<Blocks host={{ by: 'extension', … }}>`. `runViewAction` becomes that host's `run`. `ICONS`/`dataIcon` stay (declarations) |
| `packages/app/src/renderer/app.css` | `.data-view__note`, `__facts`, `__items`, `__item`, `__line`, `__title`, `__detail`, `__subtitle`, `__table*`, `__markdown`, `__actions`, `__button`, `__icon-button`, `__dropped`. The frame's classes (`.data-view`, `--space`, `--beside`, `--pane`, `__heading`, `__machine*`, `__empty`, `__error`) **stay**: `app/test` (smoke, look) finds the Skills view by `.data-view--space` |
| `packages/ui` | `Panel`, if the space frame stops using it: draw the title as the other spaces do |
| `packages/daemon/src/sdk.ts` | the `ViewAction`, `ViewContent`, `ViewItem` exports. In their place: `Block`, `ListItem`, `Button`, `Value`, `blockErrors` |
| `packages/app/test/data-views.test.ts` | the content, checker and button parts (most of its 214 lines). They become renderer tests with an extension host: the prefix refusal, params merged with inputs, refusal shown in place |

### Migrating the data views there are

There are three, plus documentation:

- **`skills.view`** (`extensions/skills/src/daemon.ts`), the only bundled one:

  ```ts
  superego.method(VIEW, async (): Promise<Block[]> => {
    const all = await skills()
    if (!all.length) return [{ type: 'markdown', text: `No skills in ${dir} yet.` }]
    return [{ type: 'list', items: all.map(({ name, description, manual }) => ({ title: `$${name}`, subtitle: description, ...(manual ? { detail: 'by name' } : {}) })) }]
  })
  ```

  Its method's result changes shape, so skills goes to **2.0.0**. `app/test`'s checks (`$smoke-skill`,
  `Checks the smoke.` inside `.data-view--space`) still hold.
- **The build-queue example** (`packages/cli/skill/examples/build-queue`). Its view becomes a `scopedValue<Block[]>`:
  a `list` with a Cancel button per build, `{ id: 'cancel-<id>', label: 'Cancel', action: 'builds.cancel',
  params: { thread, id } }`. Its test changes to match.
- **The starter's data-only kind** (`packages/cli/src/starter.ts`) does the same with its items and Remove buttons.
- **Documentation:**
  - `guide.md`'s data-view section and orders example, `daemon.md`'s `superego.view` row, `bundled.md`
  - `docs/overview.md`'s skills line
  - `docs.test`'s checked snippets
  - `packages/sdk/test/kit.test.ts`'s profile
  - `daemon/test/extension.test.ts`'s orders value
- **The user's profiles** (`~/.superego/profiles`: `default/run`, `chief-of-staff`, `obsidian`): **none uses a data
  view.** Their `superego.view` calls are UI-half views with a `component`. All three declare `api: '^2'`, though, so
  the version bump (§6) touches them. Profiles on gh-m1 and mbp weren't checked: grep them for `superego.view(` with
  `value:`/`method:` before the bump lands.

---

## 6. The extension API version

Removing `ViewContent`, `ViewItem` and `ViewAction`, and changing what a view's source must hold, are breaking changes.
`EXTENSION_API`'s rule is "from 2.5 on without exception": this is a **major, 3.0.0**. The 3.0 changelog line:

> 3.0: a data view's content is blocks (`Block[]`, the schema agents draw with, from `'superego'`), with `list` and
> buttons that run the extension's actions. `ViewContent`, `ViewItem` and `ViewAction` are gone.

What follows from it:

- Every bundled extension's `api` goes from `'^2…'` to `'^3'` (34 `about`s), and so does the starter's template.
- The three user profiles go from `'^2'` to `'^3'`. Without that, the host refuses them before `setup`.
- skills goes to 2.0.0.
- The wire protocol doesn't change. `view.list` keeps its shape, and content travels as opaque JSON in values and
  methods. A window and a machine on either side of the change refuse each other's content in place, with the
  checker's error, rather than mis-drawing it. That's acceptable while every machine runs the same release.

The daemon audit also wants a major, for `capabilities` and `#cap`. Open question 3 asks whether to share one 3.0.

---

## 7. Lanes

The work splits into three lanes, run one after another. Each lane passes `pnpm test` and `pnpm smoke` on its own.

### Lane 1: blocks into the core (done)

**Behaviour:** no change for agents, apart from gaining `list`. This lane does all of §1, plus §2's checker and host.

**Order:**
1. **Schema to protocol.**
   - `packages/protocol/src/blocks.ts`, from `packages/blocks/src/blocks.ts`, plus:
     - `list` and `Button.action`/`params`
     - `BlocksUse` and its rules in `blockErrors`
     - limits and depth
     - row-aware `describeReply`
     - the guide line
   - export from `packages/protocol/src/index.ts`
   - `packages/protocol/test/blocks.test.ts`, from `packages/blocks/test/blocks.test.ts`, plus the agent and
     extension rules
2. **Renderer to the app.**
   - `packages/app/src/renderer/blocks/blocks.tsx`, `frame.html` and `blocks.css`, from `packages/blocks/src/*`
   - `ListBlock`
   - `BlocksHost`
   - the frame told whether it may reply
   - inputs kept across redraws by id
   - `thread` optional
   - export `Blocks` from `packages/app/src/renderer/index.tsx`
3. **agent-ui on the new homes.** Files: `extensions/agent-ui/src/{daemon,reply,shared,transcript,ui,waiting}.tsx?`,
   `package.json` and `test/*`. It passes `host={{ by: 'agent', reply }}`.
4. **Delete `packages/blocks`.** Drop its reference in the root `tsconfig.json`, then `pnpm install` for the lockfile.

**Notes for Lane 2, from Lane 1:**
- **Names as built.** `blockErrors(blocks, use)` and `checkBlocks(blocks, use)` take a `BlocksUse`, with no default.
  The limits are `BLOCK_LIMITS`, so they don't clash with data views' `LIMITS`. `walk` is now `walkBlocks`. New
  helpers: `buttonsOf` (every button, row buttons with their row), `keptValues` (inputs across new blocks).
- **Limits past §4's table.** A `kv` holds at most 100 pairs, after data views' `facts`. A textarea's `default` and an
  `html` page may be 100,000 characters, as Markdown may. `image.src` is capped at 2,000,000 characters.
- **The extension host is ready.** `<Blocks machine thread? blocks host={{ by: 'extension', extension, run }} />` from
  `@superego/app/ui`, where `run(action, params)` gets the button's `params` with every input's value over them, by
  id. `run` should be `runViewAction` (prefix check, router, `exposure: 'ui'`) and then the method's refetch. The
  host gives no submit button, no answering choice and no "pressed" mark. Its `html` frames get `replies: false` and
  have no `superego.reply`/`send`. A failed `run` shows its error under the blocks and goes to the console.
- **Inputs with no button** aren't refused in an extension's view. They draw, but nothing sends them. Refuse them in
  `blockErrors` if that turns out to bite.
- **Empty is the caller's.** Blocks need at least one block, so `DataViewBody` must show "Nothing here yet." for `[]`
  or null before it draws `<Blocks>`.
- **A row with a `thread`** shows that thread's live status (`ThreadRef`'s glyph), not the row's `status`, as data views
  did.
- **Tests.** `packages/app/test/blocks.test.ts` already covers the extension host (a row's action with inputs merged,
  inputs kept across new blocks, refusal in place, a failed run). `data-views.test.ts`'s content tests can go rather
  than move.
- **Classes.** The list's classes are `.blocks-list*`. The `.data-view__*` content classes in `app.css` are still
  there for Lane 2 to delete.

### Lane 2: data views draw blocks (done)

**Needs:** Lane 1. **Covers:** §2's extension column, §4's refusal, §5's deletions in the core, and §6.

**Order:**
1. **Protocol and SDK.**
   - `packages/protocol/src/views.ts`: content types out, doc comments to blocks
   - `packages/protocol/src/contract.ts`: 3.0.0 and its changelog line
   - `packages/daemon/src/sdk.ts`: exports
   - `packages/daemon/src/extension.ts`: `view()`'s doc
2. **The window.**
   - `packages/app/src/renderer/data-views.tsx`: draws `<Blocks>` with the extension host
   - `data-view-check.ts`: the content half out
   - `app.css`
   - `packages/ui/src/panel.tsx` and `index.ts`, if `Panel` goes
   - `packages/app/test/data-views.test.ts`
3. **skills.** Files: `extensions/skills/src/daemon.ts`, `shared.ts` (version 2.0.0), `test/daemon.test.ts`.
4. **The version sweep.**
   - every `extensions/*/src` `about`: `api: '^3'`
   - `packages/daemon/test/{extension,profiles}.test.ts`
   - `packages/sdk/test/kit.test.ts`
   - with the user's go-ahead, `~/.superego/profiles/*/shared.ts`

**Notes for Lane 3, from Lane 2:**
- **Most of Lane 3 landed with Lane 2,** because `pnpm test` type-checks the guide's snippets, the starter and the
  examples, so they had to move with the types: `guide.md` (its table, the data-only snippet, the data-view section),
  `daemon.md`'s `superego.view` row, `bundled.md`'s `api`, the build-queue example and its test, the starter's
  data-only kind and its test, `docs.test`'s prelude and `profile-types.test`. What's left is a read-through of those
  for tone, and anything prose-only. `docs/overview.md` names no content type and needed nothing.
- **Inputs with no button are refused** in an extension's view (`blockErrors`), rather than drawn with nothing to send
  them.
- **`ViewBlocks`** (`data-views.tsx`) is the window's piece between a source and `<Blocks>`: "Loading…", "Nothing here
  yet." for `[]` or null, the method's error, and the extension host. A `window` view is checked as having no thread
  even where it's drawn beside one.
- **skills** shows at most `BLOCK_LIMITS.items` rows and cuts a description at `BLOCK_LIMITS.text`, so a big skills
  folder can't get its view refused.
- **`Panel` stays** in `superego/ui`: it's in the stable surface, and removing it was no part of 3.0.
- **`blockErrors`** is a value export of `'superego'` (in `SDK_EXPORTS` and the shim), for extensions' tests.

### Lane 3: docs, starter, example

**Needs:** Lane 2, and the CLI-cleanup thread merged, since it owns `packages/cli`. **Covers:** §5's documentation.

**Files:**
- `packages/cli/skill/guide.md`, `daemon.md` and `bundled.md`
- `packages/cli/skill/examples/build-queue/builds/{daemon,shared,builds.test}.ts`
- `packages/cli/src/starter.ts`
- `packages/cli/test/docs.test.ts` and `profile-types.test.ts`
- `docs/overview.md`

**Doesn't touch:** `app/test` and `evals`. Keeping the `.data-view*` frame classes and the Skills text keeps smoke and
look as they are. `evals/lib/pane-check.mjs` reads data views as pane kinds, which don't change.

---

## Decisions

The user answered the open questions:

1. **Agents get `list`.** It's in the agent's guide as one line, about 150 characters (done in Lane 1).
2. **Extension views can have inputs.** Their values go into the action's params by input id, and a params key that's
   also an input id is refused. The checker and the host do this already (Lane 1). Lane 2 uses it.
3. **Lanes may edit the user's profiles** in `~/.superego/profiles` for the 3.0 bump (Lane 2). Back them up to
   `~/.superego/backups/` first: they aren't in git. Whether the daemon audit's removals share the 3.0 wasn't
   answered. Per §6, bump for this alone if that work isn't ready.
4. **Extension views get `html`,** display only, in the sandboxed frame. The frame is told it can't reply (done in
   Lane 1).
5. **`<Blocks>` stays out of the stable `superego/ui`** for now. It's exported from `@superego/app/ui` only, for the
   bundled extensions, and from neither `sdk-ui.ts` nor `sdk-unstable.ts`.
