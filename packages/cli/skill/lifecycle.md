# Lifecycle and versions

## Lifecycle and ownership

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/lifecycle-dark.svg"><img src="guide/lifecycle.svg" alt="Set up, registrations owned by the extension, torn down when its profile changes or the daemon stops, then set up again"></picture>

Each set-up of an extension, in either half, has one lifetime: everything it registers is owned by it, and teardown
(its profile reloaded or gone, its UI revoked, the daemon stopping) ends all of it at once.

- Teardown aborts `superego.signal`, then runs `setup`'s cleanup (if it returned one), then undoes every registration,
  last first. Each step is tried whatever the others do: a cleanup that throws is logged, and the rest still goes, its
  name too, so the next version sets up. Torn down twice, nothing more happens.
- Its folder (`superego.dir`) isn't a registration: it stays through teardown, a reload, being switched off and its
  profile going, so the next set-up finds what it kept. `superego extensions` lists the folders of extensions not set up
  now, for the user to delete. Its secrets stay too (cleared in Settings, or `superego secrets clear <key>`).
- Registrations need no cleanup. What isn't a registration does: a timer, a watcher, a fetch, a listener on something
  of its own, a process. Give it the signal (`setInterval` cleared on `abort`, `watch(path, { signal })`, `fetch(url, { signal })`,
  `addEventListener(…, { signal })`, `spawnGroup(command, args, { signal })`), or return a cleanup that stops it. A listener on the signal that throws is logged as
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
- A profile's daemon half loads with its first turn, when a window lists one of its threads, or before an interrupted
  run of it resumes. A project's profile runs only once the user allows it (`superego profile allow`), as its files and those it
  lists from outside its folder are then. Profiles load one at a time: keep `setup` quick, and never await work that
  loads a profile (starting or reading a thread) in it.
- Profiles that name the same file (one `extends` another, or both list it) share one set-up of it, torn down after
  the last lets go. Each gets its agent parts.
- A change loads between runs, never under one: a thread mid-run keeps what it started with. A profile whose folder
  is gone, or that no longer loads or is allowed, is torn down, and its UI with it. A value torn down reads null.
- What a reload runs: a profile's daemon modules load by versions of their own, each the hash of the module and every
  local file it imports, so an edit to a helper alone loads the new code, and that of whatever imports it. A module none
  of whose files changed is the one loaded before, its module-level state with it (keep state in `setup`, which runs
  again); a helper two extensions import is one module, as ever. A file under `node_modules` imported by its path is a
  file like any other; packages and aliases by name (other than `'superego'` and Node's built-ins) are refused. Imports
  are read as JavaScript is (comments and strings aren't imports), static and `import('./literal.ts')` alike; an
  `import()` of a path worked out as it runs is refused, as what it loads couldn't be versioned or vouched for. The window loads a profile's UI modules afresh, all of them,
  whenever any of the profile's files changed.
- What allowing a project's profile vouches for is every file its code can run, read from the same imports a reload
  follows: each module in its folder and every local file they import, hidden or outside it, symlinks followed; a file
  it lists from outside, with what that imports; and its folder's other files (not dotfiles). Its modules can't import
  anything else (a package, an alias), so nothing loads that allowing didn't vouch for. Not in it: files its code reads
  or starts as it runs.
- A profile's UI from another machine runs in the window only once allowed on this computer (the thread's notice, or
  `superego profile allow-ui <name> -m <machine>`), for a hash the window takes of the sources it received; any change
  to them asks again, and Revoke (Settings → Machines) takes out what it registered at once. Once running it has the window's full
  reach, every machine's `call` and `dispatch` included: it runs in the window's own JavaScript, where narrowing its API
  wouldn't stop it calling `window.superego` directly. Real isolation would take a sandboxed tier, which Superego doesn't have yet.

### What each kind of code may do

- **A data-only view** (`superego.view` in a daemon half): no code of the extension's runs in the window, so it asks
  no consent to, and what it sends is checked where it lands. Its buttons still have that machine's authority: they
  run its extension's actions there, as the window may.
- **A remote profile's UI**, once allowed: runs in the window's own JavaScript, with the window's full authority over
  every machine it reaches. Allowing it gives that code as much reach as the window itself.
- **Revoke** takes out what that UI registered (views, panes, actions, slots), aborts its `signal` and runs its
  `setup`'s cleanup, so what it stopped with those stops. It can't undo what its code already did, or stop what it left
  going otherwise (a timer it didn't tie to either, a global, a request). The window offers a reload, which does; what
  was done stays done.
- A **daemon half** (a profile's or the app's) runs with Node's full access on its machine, as this computer's profiles do
  in their daemon (a project's once `superego profile allow`ed).

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

- Hooks run in the order extensions were set up (the core's, the bundled ones, then profiles'), one at a time. Not
  for a thread that goes without the extension; a profile's only for that profile's threads (its profile is loaded
  first, so they run after a restart too). Facts and `agentFor` go by the same rule.
- Archiving an archived thread, or unarchiving one in use, does nothing: the hooks see only real changes.
- `starting`, `archiving` and `unarchiving` may refuse by throwing (an `RpcError` says it cleanly): nothing more
  happens, and the hooks after don't run. `starting` may also move where the thread works and give it state, each
  hook seeing the draft as the one before left it. When a later hook refuses (or making the thread fails), those
  whose `starting` already ran are told `abandoned(draft, state)`, in reverse, to undo it: a worktree goes again.
  Likewise, when a later `unarchiving` refuses (or bringing the thread back fails), those whose `unarchiving` already
  ran are told `unarchiveAbandoned(thread)`, in reverse, to undo what they put back; the thread stays archived.
  `draft.options` is what the thread was asked for by extension: its profile's `options`, then `thread.start`'s.
- The others are told, and awaited in turn. A throw there is logged, and the thread carries on. `archived` runs
  before clients see the thread archived, so it's where cleanup goes. Hooks aren't a transaction: archiving goes on
  past a cleanup that failed, and may be tried again (a restart between), so make cleanup idempotent, and safe to find
  half done. `archiving` and `archived` may return
  `{ note }`, what they did in a line ("Removed the worktree …; branch … kept"): `threads.archive` and `thread.archive`
  answer `{ notes }`, each extension's by its name, and `thread_archive` tells the agent them. `turnStart` and `turnEnd` never hold up a run.
- `turnStart` and `turnEnd` are per run, not per message: a message steered or queued into a run that's going is part
  of it. A run resumed after a restart had started already, so it ends with a `turnEnd` alone; one that ended while
  the daemon was down gets neither.
- `stopped(thread, { withdrawn })` is told when a stop (`thread.stop`) withdrew messages others had queued for the
  thread (another thread's `thread_send`, an extension's): each one's origin, in order. The `turnEnd` of the run it stopped may be told
  before or after it. The user's own aren't withdrawn: they come back to them to write again.
- `blocked` is told when a thread comes to need the user mid-run (an extension's `status`: `agent-ui`'s question), once
  each time: when the extension whose status it is calls `invalidate()`.
- A thread archiving itself mid-turn is `threads.archive(id, { whenIdle: true })`: archived once its run ends, even
  across a restart. What its hooks said they did (or why it couldn't be) is then said in the thread, as Superego's
  own note (`superego.note`).
- State is kept in the thread's document under the extension's name, so it persists, and goes with the thread.
  Facts are recomputed whenever the thread's info is; `invalidate()` when something else they read changed. A
  profile's show once its profile has loaded: at startup for the threads in use, else when one of its threads is.
- `agentFor` is called often: quick, and without side effects. The thread's own model wins over its answer, its answer
  over the profile's, and the profile's over the machine's settings. Its instructions last only while it gives them:
  when it no longer answers, the thread's agent has its profile's prompt again, or none. The parts it picks are its own
  extension's, given with `agent(part, { always: false })`. Its `without` is what the thread goes without, its
  agent's parts, panes and UI alike.
- `agentParts` adds to whatever agent a thread has, where `agentFor` chooses it: every extension's answer counts, not
  only the first. It's asked at each send (not as often as `agentFor`), so it may do some work, up to 5s: start something
  it has never listed, say. A turn already going keeps the parts it started with, but a part replaced
  (`agent()`'s `replace`) is picked up by its next request, as conversations select parts by name. So an extension
  whose tools change (an MCP server's list) replaces its part rather than waiting for the next turn.

Bundled extensions also declare whether they're required, once, in `about` (spread into both halves):

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/required-dark.svg"><img src="guide/required.svg" alt="A required extension is always on; an optional one can be switched off per machine or left out by a profile, and that thread then has none of its agent parts or UI"></picture>

Only the sidebar (`threads`), `worktrees` (archiving removes a folder and unarchiving puts it back: never switched off
between the two) and the core's `markdown` are required. Everything else is optional, `ego` too, and the core's own
`coding-tools`, `panes` and `agents-md`. Where a window part and a machine part should differ, they are two
extensions: `threads` is the required sidebar in the window, and `thread-tools`, the agent's thread tools, an optional
one on the machine, so switching the tools off leaves the sidebar (and the rows and links naming threads).
The core's `panes` is the agent's `pane_open`: switched off, the agent can't open panes, but the window's own pane
kinds stay, being the required core's. An extension with a UI half only needs no daemon half: the window declares it
to each machine, which lists it and lets profiles do without it.

## Versions and compatibility

Three versions, each for its own question:

| Version | What it versions | Where it's said | Who checks it |
|---|---|---|---|
| **The release** | the code a machine runs: its build, and a checkout's git commit | `hello.machine.build` and `commit`, Settings → Machines ("an older Superego") | the user, who updates |
| **The extension API** | what the host gives extensions: `superego.` in either half, `'superego'`, `'superego/ui'`; semver, `EXTENSION_API` in `packages/protocol/src/contract.ts` (a minor version adds, a major one renames or removes) | `hello.api` | the host, setting an extension up |
| **The protocol** | the wire: a generation, `PROTOCOL_VERSION` (`2`), and in it the features each side announces | `hello.version`, `hello.features` | both ends, at `hello` |

And each extension's own **version**, semver, which its other half, profiles and scripts rely on.

### Declaring them

An extension says its version and the extension API it needs in `about` (bundled), or in its definition (a profile's):

<!-- check: daemon -->
```ts
export const about = { name: 'orders', version: '1.2.0', api: '^5', title: 'Orders' } satisfies ExtensionAbout
```

- `version`: a **major** when something relying on its methods, actions, values or data views could no longer follow
  (a method's result changes shape, an action goes); a **minor** when something's added; a patch otherwise. Bundled
  extensions started at `1.0.0`. Unset: it counts as `0.0.0`.
- `api`: the range of extension APIs it works with: `^5` for any 5.x, `^5.1` once it uses something 5.1 added. A host
  outside the range refuses it before `setup` runs, with why: *Extension orders needs extension API ^5.1, and this
  Superego has 5.0.0: update Superego*. A bundled one fails the build's tests; a profile's fails its profile's load
  (the thread says so); a profile UI's is left out, the rest of the profile set up. Unset: any.

The host's `EXTENSION_API` goes up a minor when the API grows, and a major when something an extension could rely on
changes or goes, which also moves every bundled extension's `api`.

### Checking them

Each daemon announces its manifest (`{ name, version, api }`) for every extension set up and on there in
`hello.extensions`, kept current by `features.changed`; `features` holds protocol features only. In the window, `has`
reads those manifests (the protocol's `offers()`):

<!-- check: ui -->
```ts
has(machine, 'ext:git')          // set up and on there, at any version
has(machine, 'ext:git@^1.2')     // at 1.2 or later in 1.x
version(machine, 'git')          // '1.3.0'; '0.0.0' when it says none; undefined when it isn't there or is off
```

Ranges are the usual ones: `^1.2`, `~1.2`, `>=1.2 <3`, `1.2` (1.2.x), `*`, joined with `||`.

The major is the window's to check: it draws a UI half for a machine's threads (its slots, views, panes, tool rows,
entries, links, completions; its window actions while one is shown; its settings section for that machine) only where
that machine runs the extension at the UI half's own major (below 1.0, its own minor, as semver has it), as it draws none for a thread that goes without the extension. A machine that doesn't announce it
(switched off there, or a UI-only extension) doesn't stop it. So a UI half asks `has` only for a minor it relies on
(`@^1.<minor>`), or where it draws without a thread.

Windows declare their extensions to each machine (`extension.declare`), so one with no daemon half is listed there even
where the daemon doesn't bundle it (the app's daemon lists each bundled one's `about`, so it knows them from the start).
When two windows declare one differently, the newest version's word is taken, whatever order they connect in (at the
same version, the two are settled by what they say, the same way each time); an older window's never takes it back.

### The skew policy

What a window and a daemon of different releases do with each other:

- **Another protocol generation:** refused at `hello` (`version_mismatch`: *Update superego on the older side*).
  A generation changes for a break nothing can bridge, and starts clean: no old names, no read-throughs of old data.
- **The same generation:** they work together. The core's methods, actions, notifications and features only grow in
  a generation: `RELEASED` (`packages/protocol/src/released.ts`) lists what generation 2 released, and a test holds
  the daemon to answering all of it. Anything added later in the generation goes in `FEATURES`, is
  announced in `hello.features`, and is checked with `offers()` before it's used; a window reads an extension's daemon
  half's manifest in `hello.extensions`. At another major than the window's UI half, the UI half draws nothing for that
  machine's threads; a minor it relies on, it checks with `has(machine, 'ext:git@^1.2')`.
- **Renaming something released** waits for the next generation.
- **Stored data** isn't migrated: what an older release stored under an old name or in an old place isn't read.
