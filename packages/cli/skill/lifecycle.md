# Lifecycle and versions

## Lifecycle and ownership

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/lifecycle-dark.svg"><img src="guide/lifecycle.svg" alt="Set up, registrations owned by the extension, torn down when its profile changes or the daemon stops, then set up again"></picture>

Each set-up of an extension, in either half, owns everything it registers. Teardown (its profile reloaded or gone, its
UI revoked, the daemon stopping) ends all of it at once.

**Teardown** aborts `superego.signal`, runs `setup`'s cleanup, then undoes every registration, last first. Each step
runs whatever the others do (a throw is logged, the name is freed), so the next version sets up. A second teardown
does nothing.

**What needs cleaning up:** not registrations, but what isn't one: a timer, a watcher, a fetch, a listener, a process.
Give it the signal (`setInterval` cleared on `abort`, `watch(path, { signal })`, `fetch(url, { signal })`,
`addEventListener(…, { signal })`, `spawnGroup(command, args, { signal })`) or return a cleanup that stops it. A signal
listener that throws is logged as the extension's; the others are still told.

**What stays:** its folder (`superego.dir`) and its secrets, through teardown, reloads, being switched off and its
profile going. `superego extensions` lists the folders, and `superego secrets` and `superego extensions` the secrets
(`superego secrets clear <key>`), of extensions not set up now.

**After teardown,** registering throws and leaves nothing behind. A live value's `set` and `update` from late work do
nothing (with one warning), so they can't overwrite the next version's; `get` reads what it last set.

**Limits.** A daemon half's `setup` over 15s is torn down (signal aborted) and its profile fails to load, saying so, so
profiles behind it load. A profile whose modules hang while loading is given up on the same way.

**A UI half's failures are contained:** each view, slot, space, pane, tool row, entry, settings component, New thread
field and link `render` draws in its own boundary. One that throws shows "<extension> failed to draw", its error and
Retry; the rest of the window carries on.

**Names** are claimed while set up: a second extension of the same name is refused. The core's namespaces (`thread`,
`value`, `settings`, …) are never free.

### Loading and reloading

- A profile's daemon half loads with its first turn, when a window lists one of its threads, or before an interrupted
  run resumes. A project's profile runs only once allowed (`superego profile allow`). Profiles load one at a time:
  keep `setup` quick, and never await work that loads a profile (starting or reading a thread) in it.
- Profiles naming the same file (via `extends`, or both listing it) share one set-up of it, torn down after the last
  lets go. Each gets its agent parts.
- Changes load between runs, never during one. A profile whose folder is gone, or that no longer loads or is allowed,
  is torn down, its UI with it. A torn-down value reads null.
- Each daemon module is versioned by a hash of itself and every local file it imports, so editing a helper reloads it
  and its importers. An unchanged module isn't reloaded and keeps its module-level state (keep state in `setup`). A
  helper two extensions import is one module.
- Imports: a file under `node_modules` by path is a file like any other; packages and aliases by name (other than
  `'superego'` and Node's built-ins) are refused. Static imports and `import('./literal.ts')` are followed (comments and
  strings aren't imports); an `import()` of a computed path is refused, as it can't be versioned or vouched for.
- The window reloads all of a profile's UI modules whenever any of its files changed.

### What allowing covers

Allowing a project's profile vouches for every file its code can run, found the way a reload follows imports: each
module in its folder and every local file they import (hidden, outside it, through symlinks); files it lists from
outside and their imports; and its folder's other files (not dotfiles). It can't import anything else, so nothing
loads unvouched. Files its code reads or starts at run time aren't covered.

### What each kind of code may do

| Code | Reach |
|---|---|
| A **data-only view** (`superego.view` in a daemon half) | none of its code runs in the window, so no consent; what it sends is checked on arrival. Its buttons run its extension's actions on that machine |
| A **remote profile's UI**, once allowed | the window's full authority over every machine (`call`, `dispatch`): it runs in the window's JavaScript, where a narrower API couldn't stop it reaching `window.superego`. Superego has no sandboxed tier yet |
| A **daemon half** (a profile's or the app's) | Node's full access on its machine (a project's once allowed) |

Another machine's profile UI is allowed on this computer (the thread's notice, or
`superego profile allow-ui <name> -m <machine>`) for a hash of the sources received; any change asks again. **Revoke**
(Settings → Machines) removes what it registered, aborts its `signal` and runs its cleanup. It can't undo what the
code already did or stop what it left running untied (a timer, a global, a request); the window offers a reload, which
does.

## A thread's life

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/thread-life-dark.svg"><img src="guide/thread-life.svg" alt="starting makes a thread (a hook may move where it works and give it state, or refuse); started; turnStart and turnEnd around each run; archiving then archived on the way to archived, unarchiving then unarchived on the way back"></picture>

<!-- check: daemon; declare function makeWorktree(top: string): Promise<{ path: string; branch: string }>; declare function removeWorktree(path: string): Promise<void>; declare function removeIfClean(path: string): Promise<boolean> -->
```ts
const state = superego.state<{ path: string; branch: string }>()
superego.facts(({ state }) => state)                   // thread.facts.worktrees
superego.thread<{ path: string; branch: string }>({   // the state its starting gives a thread
  async starting(draft) {                              // draft.options: what thread.start asked for, by extension
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

| Hook | When | May |
|---|---|---|
| `starting(draft)` | a thread is being made | return `{ cwd, state }` (work elsewhere: a worktree), or throw to refuse. `draft.options`: its profile's `options`, then `thread.start`'s, by extension. Each sees the draft as the last left it |
| `abandoned(draft, state)` | a later `starting` refused, or making it failed | undo (told in reverse) |
| `started` | it exists | |
| `turnStart`, `turnEnd` | around each run (not each message: steered or queued messages are part of the run) | never holds up a run. A run resumed after a restart gets only `turnEnd`; one that ended while the daemon was down gets neither |
| `blocked` | it came to need the user mid-run (an extension's `status`, as `agent-ui`'s question), once each time, when that extension calls `invalidate()` | |
| `stopped(thread, { withdrawn })` | a stop (`thread.stop`) withdrew messages others queued (another thread's `thread_send`, an extension's): each one's origin (`by`, `from`), in order. Before or after the run's `turnEnd`. The user's own aren't withdrawn: they come back to them | |
| `archiving` | it's being archived | throw to refuse; return `{ note }` |
| `archived` | before clients see it archived | clean up, idempotently; return `{ note }` |
| `unarchiving` | it's being brought back | throw to refuse |
| `unarchiveAbandoned(thread)` | a later `unarchiving` refused, or it failed | undo (in reverse); it stays archived |
| `unarchived` | it's back | |

- Hooks run one at a time in set-up order (the core's, bundled, then profiles'). Not for threads that go without the
  extension; a profile's only for its own threads (loaded first, so they run after a restart too). Facts and
  `agentFor` follow the same rule.
- Archiving an archived thread, or unarchiving one in use, does nothing: hooks see only real changes.
- A refusal (throw; an `RpcError` says it cleanly) stops everything; later hooks don't run. Other hooks' throws are
  logged and the thread carries on.
- Hooks aren't a transaction: archiving goes on past a failed cleanup and may be retried (a restart between), so make
  cleanup idempotent and safe to find half done.
- `{ note }` is what a hook did, in a line ("Removed the worktree …; branch … kept"): `threads.archive` and
  `thread.archive` answer `{ notes }` by extension, and `thread_archive` tells the agent.
- A thread archiving itself mid-turn: `threads.archive(id, { whenIdle: true })`, archived once its run ends, across
  restarts too; its notes (or why it couldn't) are then said in the thread as Superego's own note (`superego.note`).
- **State** lives in the thread's document under the extension's name: it persists and goes with the thread.
  **Facts** are recomputed with the thread's info; `invalidate()` when something else they read changes. A profile's
  show once it has loaded: at startup for threads in use, else when one of its threads is.
- **`agentFor`** is called often: quick, no side effects. The thread's own model beats its answer, its answer the
  profile's, the profile's the machine's settings. Its instructions last while it answers; then the profile's prompt
  (or none) returns. Its parts are its own extension's, given with `agent(part, { always: false })`. Its `without` is
  what the thread goes without: parts, panes and UI.
- **`agentParts`** adds to whatever agent a thread has; every extension's answer counts. Asked at each send, so it may
  work up to 5s (start something new, say). A turn keeps the parts it started with, but a part replaced
  (`agent()`'s `replace`) is picked up by the next request, since parts are selected by name. So an extension whose
  tools change (an MCP server's list) replaces its part.

### Required and optional

Bundled extensions declare whether they're required, in `about` (spread into both halves):

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/required-dark.svg"><img src="guide/required.svg" alt="A required extension is always on; an optional one can be switched off per machine or left out by a profile, and that thread then has none of its agent parts or UI"></picture>

Required: the sidebar (`threads`), `worktrees` (archiving removes a folder and unarchiving restores it, so it can't be
off in between), and the core's `markdown`. Everything else is optional, `ego` and the core's `coding-tools`, `panes`
and `agents-md` included.

Where a window part and a machine part should differ, they're two extensions: `threads` (the required sidebar) and
`thread-tools` (the agent's optional tools), so switching the tools off keeps the sidebar and thread rows and links.
The core's `panes` is the agent's `pane_open`: off, the agent can't open panes, but the window's own pane kinds stay.
A UI-only extension needs no daemon half: the window declares it to each machine, which lists it and lets profiles go
without it.

## Versions and compatibility

| Version | Versions | Where it's said | Checked by |
|---|---|---|---|
| **The release** | the code a machine runs: its build, and a checkout's git commit | `hello.machine.build` and `commit`, Settings → Machines ("an older Superego") | the user, who updates |
| **The extension API** | what the host gives extensions: `superego.` in either half, `'superego'`, `'superego/ui'`; semver, `EXTENSION_API` in `packages/protocol/src/contract.ts` (minor adds, major renames or removes) | `hello.api` | the host, setting an extension up |
| **The protocol** | the wire: a generation, `PROTOCOL_VERSION` (`2`), and the features each side announces | `hello.version`, `hello.features` | both ends, at `hello` |
| **The extension's** | an extension, for its other half, profiles and scripts; semver | its `about` or definition | `has`, `version` |

### Declaring them

In `about` (bundled) or the definition (a profile's):

<!-- check: daemon -->
```ts
export const about = { name: 'orders', version: '1.2.0', api: '^5', title: 'Orders' } satisfies ExtensionAbout
```

- `version`: **major** when something relying on its methods, actions, values or data views could no longer follow (a
  result changes shape, an action goes); **minor** when something's added; else a patch. Bundled ones started at
  `1.0.0`. Unset: `0.0.0`.
- `api`: the extension API range it works with: `^5`, or `^5.1` once it uses something 5.1 added. A host outside the
  range refuses it before `setup`: *Extension orders needs extension API ^5.1, and this Superego has 5.0.0: update
  Superego*. A bundled one fails the build's tests; a profile's fails the profile's load (the thread says so); a
  profile UI's is left out, the rest set up. Unset: any.
- The host's `EXTENSION_API` goes up a minor when the API grows, and a major when something extensions rely on changes
  or goes (which also moves every bundled extension's `api`).

### Checking them

Each daemon announces a manifest (`{ name, version, api }`) for every extension set up and on, in `hello.extensions`,
kept current by `features.changed` (`features` holds protocol features only). In the window, `has` reads them (the
protocol's `offers()`):

<!-- check: ui -->
```ts
has(machine, 'ext:git')          // set up and on there, at any version
has(machine, 'ext:git@^1.2')     // at 1.2 or later in 1.x
version(machine, 'git')          // '1.3.0'; '0.0.0' when it says none; undefined when it isn't there or is off
```

Ranges: `^1.2`, `~1.2`, `>=1.2 <3`, `1.2` (1.2.x), `*`, joined with `||`.

The window checks the major: it draws a UI half for a machine's threads (slots, views, panes, tool rows, entries,
links, completions, window actions, its settings section) only where that machine runs the extension at the UI half's
own major (below 1.0, its minor). A machine that doesn't announce it (off there, or a UI-only extension) doesn't stop
it. So a UI half checks `has` only for a minor it relies on (`@^1.<minor>`), or where it draws without a thread.

Windows declare their extensions to each machine (`extension.declare`), so a UI-only one is listed there (the app's
daemon lists each bundled one's `about` from the start). When two windows declare one differently, the newest
version's word wins, whatever order they connect in (at the same version, deterministically); an older window never
takes it back.

### The skew policy

What a window and a daemon of different releases do:

- **Another protocol generation:** refused at `hello` (`version_mismatch`: *Update superego on the older side*). A
  generation changes only for a break nothing can bridge, and starts clean: no old names or old data read through.
- **The same generation:** they work together. The core's methods, actions, notifications and features only grow
  within a generation: `RELEASED` (`packages/protocol/src/released.ts`) lists generation 2's, and a test holds the
  daemon to all of it. Later additions go in `FEATURES`, are announced in `hello.features`, and are checked with
  `offers()` before use. A UI half at another major than the machine's daemon half draws nothing there; a minor it
  needs, it checks with `has(machine, 'ext:git@^1.2')`.
- **Renaming something released** waits for the next generation.
- **Stored data** isn't migrated: what an older release stored under an old name or place isn't read.
