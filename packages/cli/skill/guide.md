# Writing extensions

An extension has up to two halves: a **daemon half** next to the agents on a machine, and a **UI half** in the window.
Either can be left out. Everything either half registers is its own, and goes when it does.

## The big picture

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/big-picture-dark.svg"><img src="guide/big-picture.svg" alt="The daemon half gives the agent tools; the UI half dispatches actions to it, calls its methods and watches its live values"></picture>

| The UI half wants to… | The daemon half offers | The UI uses |
|---|---|---|
| change something | `action(defineAction({ id, run }))`: logged, in ⌘K, on the command line | `useDispatch()(id, params, { machine })` |
| read something | `method(name, run, { params })`: a plain request | `useMethod(machine.id, name, params)` in a component, `call(machine, name, params)` elsewhere |
| follow something | `value(key, initial)` | `useValue(machine, key)` |
| follow something per thread | `scopedValue(key, initial)` | `useValue(machine, key, { scope: thread.id })` |

Where they come from:

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/loading-dark.svg"><img src="guide/loading.svg" alt="Bundled extensions are built into the app; profiles in ~/.superego/profiles or a project's .superego/profiles name their extensions and UI modules"></picture>

A profile's halves import `'superego'` and `'superego/ui'`. A bundled extension's halves import the packages directly (`@superego/daemon`, `@superego/app/ui`, …), see [bundled.md](bundled.md).

### What to import

| Import | What | Stability |
|---|---|---|
| `'superego'` | the daemon half and a profile: `defineDaemonExtension`, `defineProfile`, `defineExtension`, `defineTool`, `defineAction`, the schema helpers (`obj`, `str`, …), `RpcError`, `spawnGroup` (a command run as a process tree that stops as one), and their types (`DaemonApi`, `ScopedValue`, `ViewContent`, …) | stable: follows the extension API's version |
| `'superego/ui'` | the UI half: `defineUiExtension`, `defineAction`, hooks (`useMethod`, `useValue`, `useDispatch`, `useSelection`, …), `call`, `has`, `version`, components to build from (`Markdown`, `PaneHeader`, `Picker`, `Diff`, `FileEditor`, `Button`, the icons), and their types | stable |
| `'superego/testing'` | test helpers: a daemon with a scripted model, a window with a fake bridge, `isRunning(pid)` (see [Testing](#testing)) | stable |
| `'superego/unstable'` | the window's workings the bundled extensions build on: `useRegistry`, `useShell`, `useSidebar`, `fileKind`, the project list, `useWatch`, `useThreadView`, … | none: changes with the window |

On a `DaemonApi`, `harness` (pi-durable itself) and `threads.entries`' records are pi-durable's shapes, unstable too.
Everything else in the tables below is stable.

## Starting one

```sh
superego extension new notes          # data-only: a daemon half whose view the window draws from data
superego extension new notes --ui     # with a UI half that draws it itself
superego extension test notes         # check its types and run its tests
```

`new` makes the extension in a folder of its own in this project's profile (`.superego/profiles/default`; `-P name`
for another, `--user` for yours in `~/.superego/profiles`), making the profile if there's none, and lists it there.
It's a working one to change: a tool that adds an item to the thread's list, the thread's items as a scoped value, an
action to clear them, and a view of them beside the thread; `shared.ts` with its `version` and the extension `api` it
needs; a test on [`superego/testing`](#testing); a README; and the profile's types, as `superego profile types`
gives them: a `tsconfig.json`, and `node_modules` linked to `~/.superego/types`, the declarations of `'superego'`,
`'superego/ui'`, `'superego/testing'`, React and vitest built from this Superego's own source, so `test` (and an editor)
checks the types. Send one of the profile's threads a message and it's there; after an edit, the next turn loads it
again (`superego extension reload` loads it now). A project's profile runs as it was allowed: allow it again after
editing (`superego profile allow`).

A thread keeps the profile it started with, so a profile made after it started (the first `default`, made by `new`)
doesn't reach it: not the thread that made it, nor the user's other open threads. Start a new thread to use it, or move
an idle one onto it (`superego do thread.setProfile --thread <thread> --profile <name>`).

## A first extension, end to end

A profile, `~/.superego/profiles/default/`, whose agent keeps notes and whose window shows them in a pane:

```ts
// profile.ts
import { defineProfile } from 'superego'
export default defineProfile({ extensions: ['./notes.ts'], ui: ['./ui.tsx'] })
```

```ts
// notes.ts: the daemon half. A tool for the agent, a read for the pane, and the pane described to the agent.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineDaemonExtension, defineExtension, defineTool, obj, str } from 'superego'

export default defineDaemonExtension({
  name: 'notes', version: '1.0.0', api: '^2',
  setup(superego) {
    const fileOf = async (id: string) => join((await superego.threads.get(id)).cwd, 'NOTES.md')
    const read = async (id: string) => readFile(await fileOf(id), 'utf8').catch(() => '')
    superego.agent(defineExtension({
      name: 'notes',
      tools: [defineTool({
        name: 'add_note', description: 'Add a line to NOTES.md.', parameters: obj({ text: str() }),
        async execute({ text }, api) {
          const id = superego.threads.of(api.conversationId)!
          await writeFile(await fileOf(id), `${await read(id)}- ${text}\n`)
          return { output: [{ type: 'text', text: 'Noted.' }] }
        },
      })],
    }))
    superego.method('notes.read', async ({ id }) => ({ text: await read(id) }), { params: obj({ id: str() }) })
    superego.pane('notes', "the thread's NOTES.md; no params")
  },
})
```

```tsx
// ui.tsx: the UI half. A pane, offered in the thread's pane menu.
import { defineUiExtension, has, useMethod, type PaneProps } from 'superego/ui'

function Notes({ machine, thread }: PaneProps) {
  // Read again as the thread moves on; nothing until the machine has the daemon half (its profile loads with the
  // thread's first turn), then at once.
  const { data, error } = useMethod<{ text: string }>(machine.id, 'notes.read', { id: thread.id },
    { enabled: has(machine, 'ext:notes@^1'), refresh: thread.activeAt })
  if (error) return <div className="pane-empty">{error.message}</div>
  return <pre className="pane-scroll">{data?.text || 'No notes yet.'}</pre>
}

export default defineUiExtension({ name: 'notes', version: '1.0.0', api: '^2', setup: (superego) => superego.pane('notes', { title: 'Notes', component: Notes, menu: true }) })
```

Send a thread a message: the daemon loads the profile and the agent has `add_note`. The window loads its UI as soon as it
lists the thread ([ui.md](ui.md#when-the-ui-loads)). After an edit, the daemon half reloads on the thread's next turn, the UI once the thread moves on.

## The build queue, two ways

A project's build queue: a tool the agent queues work with, the thread's queue beside it, a Cancel button on each
build, and a shortcut to show it. Both versions are in [`examples/`](examples), each a profile folder to copy,
with its tests; a test builds both from there as an author would.

The queue is per thread, so it's a **scoped value**: each thread's in its own scope, and a window showing a thread
watches that scope alone, never another thread's queue.

<!-- check: daemon -->
```ts
const queue = superego.scopedValue<Build[]>('builds.queue', [])
superego.agent(defineExtension({
  name: 'builds',
  tools: [defineTool({
    name: 'enqueue_build', description: "Queue a build in this thread's folder.", parameters: obj({ command: str() }),
    async execute({ command }, api) {
      const thread = superego.threads.of(api.conversationId)!
      queue.update(thread, (builds) => [...builds, { id: api.callId, command, state: 'queued', at: Date.now() }])
      return { output: [{ type: 'text', text: `Queued: ${command}` }] }
    },
  })],
}))
```

Running a build is the part to get right. Its command starts processes of its own (a compiler, a test runner's
workers), and stopping its shell leaves those running, still writing to the thread's folder. So run it with
**`spawnGroup`**, as a process group of its own, and stop the group: `stop()` sends it SIGTERM, then SIGKILL after a
grace (`grace`, 5s), and resolves once nothing of it is left; given `superego.signal`, teardown stops it the same way.
`exited` waits for the whole group too, and says whether it was `stopped`. Say a build is cancelled only once it has
stopped, and claim a build (mark it running) before anything is awaited, so two calls can't both start it. (POSIX
stops a group with the grace; Windows has no groups, so there it ends the tree at once with `taskkill /T /F`.)

<!-- check: daemon; declare const queue: import('superego').ScopedValue<Build[]> -->
```ts
const running = new Map<string, SpawnedGroup>()
const setState = (thread: string, id: string, state: Build['state']) =>
  queue.update(thread, (builds) => builds.map((b) => b.id === id ? { ...b, state } : b))
async function run(thread: string, build: Build) {
  setState(thread, build.id, 'running')                     // claimed, before anything is awaited
  const { cwd } = await superego.threads.get(thread)
  const group = spawnGroup('sh', ['-c', build.command], { cwd, stdio: 'ignore', signal: superego.signal })
  running.set(build.id, group)
  const { code, stopped } = await group.exited              // all of it gone, not just the shell
  running.delete(build.id)
  setState(thread, build.id, stopped ? 'cancelled' : code === 0 ? 'done' : 'failed')
}
superego.action(defineAction({
  id: 'builds.cancel', title: 'Cancel a build', runs: 'machine', params: obj({ thread: str(), id: str() }),
  async run({ thread, id }) {
    await running.get(id)?.stop()                           // answers once the build has stopped
    setState(thread, id, 'cancelled')
    return null
  },
}))
```

**Data-only** ([`build-queue`](examples/build-queue/builds/daemon.ts)): no UI code. The daemon half keeps a second
scoped value, what the view shows, with a Cancel button on each build; the view reads it, each thread its own scope.
The shortcut is a machine action with `keys`, offered while one of that machine's threads is shown (`thread: true`
fills in its `thread`); it opens the view as a pane, which a `thread` view that fits `pane` is.

<!-- check: daemon; declare const queue: import('superego').ScopedValue<Build[]> -->
```ts
const view = superego.scopedValue<ViewContent>('builds.view', { empty: 'No builds queued.' })
const show = (thread: string) => view.set(thread, {
  empty: 'No builds queued.',
  items: queue.get(thread).map((b) => ({ id: b.id, title: b.command, subtitle: b.state,
    actions: [{ title: 'Cancel', action: 'builds.cancel', params: { thread, id: b.id } }] })),
})
superego.view('builds.view', { title: 'Builds', icon: 'terminal', context: 'thread', fits: ['beside', 'pane'], default: 'beside', value: 'builds.view' })
superego.action(defineAction({
  id: 'builds.open', title: 'Show the build queue', runs: 'machine', keys: 'mod+shift+b', thread: true, params: obj({ thread: str() }),
  run: ({ thread }) => superego.dispatch('pane.open', { thread, kind: 'builds.view' }),
}))
```

**With a UI half** ([`build-queue-ui`](examples/build-queue-ui/builds/ui.tsx)): the window draws the queue with a
component of its own, watching the thread's scope, and the shortcut is a window action of the profile's UI, offered in
its own threads, that shows or hides the view beside the thread.

<!-- check: ui -->
```tsx
function Queue({ machine, thread }: ViewProps<'thread'>) {
  const builds = useValue<Build[]>(machine, 'builds.queue', { scope: thread.id }) ?? []
  const dispatch = useDispatch()
  if (!has(machine, 'ext:builds@^1')) return <p className="pane-empty">No build queue on {machine.label}.</p>
  return <ul>{builds.map((b) => (
    <li key={b.id}>{b.command} {b.state}
      <button type="button" onClick={() => void dispatch('builds.cancel', { thread: thread.id, id: b.id }, { machine: machine.id })}>Cancel</button></li>
  ))}</ul>
}
superego.view('builds.list', { title: 'Builds', context: 'thread', fits: ['beside', 'pane'], default: 'beside', component: Queue })
superego.action(defineAction({
  id: 'builds.toggle', title: 'Show or hide the build queue', keys: 'mod+shift+b',
  run: (_params, context) => context.dispatch('layout.place', { view: 'builds.list', place: 'beside' }),
}))
```

## Testing

`'superego/testing'` runs an extension as it runs in Superego: the daemon half in a real daemon with a scripted model,
the UI half in the window's own registry and shell, in a DOM of its own, over a fake machine or that daemon.
`superego extension test` runs a profile's `*.test.ts` and `*.test.tsx` with it, after checking the types. It needs
nothing installed: the app carries TypeScript's compiler and a test runner of its own for vitest's `describe`, `it`,
`test`, their hooks, `expect` and `vi` (`vi.fn`, `vi.spyOn`, fake timers, `vi.waitFor`); snapshots, `vi.mock` and
`expect.poll` aren't there. A `.ts` file loads as the daemon loads it, its types stripped by Node (import a type as one:
`import { type Name }`), a `.tsx` as the window loads it.

```ts
// builds.test.ts, beside the extension in its profile
import { afterEach, expect, it } from 'vitest'
import { callTools, daemonMachine, mountUi, say, testDaemon, type TestDaemon } from 'superego/testing'

const profile = new URL('..', import.meta.url).pathname   // the profile this file is in: copied for the test
let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close() })

it('queues builds and shows the thread its own', async () => {
  daemon = await testDaemon({ profile, model: [callTools({ name: 'enqueue_build', args: { command: 'sleep 30' } }), say('Queued.')] })
  const thread = await daemon.thread('Build it')                   // with the profile; sent, and its run waited out
  const queue = await daemon.watch<{ state: string }[]>('builds.queue', { scope: thread.id })
  await queue.until((builds) => builds[0]?.state === 'running')
  const window = await mountUi({ machines: [daemonMachine(daemon)], select: { thread: thread.id } })
  const beside = await window.render({ place: 'beside', thread: thread.id })
  await window.until(() => beside.text().includes('sleep 30'))
  await beside.click('Cancel')
  expect(await window.press('mod+shift+b')).toBe('builds.open')
  await window.unmount()
})
```

- **`testDaemon({ profile, extensions, model })`**: `profile` is a folder (copied) or files by path; `extensions` are
  set up as the app's own. `model` is the model's turns in order: `say(text)`, `callTool(name, args)`,
  `callTools(…)`. It has `thread(prompt)`, `send`, `idle`, `transcript`, `call`, `dispatch`, `watch(key, { scope })`,
  `features`; `edit(path, content)` then `reload()` to load a change (a helper edited alone loads too);
  `restart({ model })` on the same folder; `close()`.
- **`isRunning(pid)`**: whether a process is still there, to check that what an extension started stopped with it.
  The queue examples' tests cancel a build whose command starts a `sleep` of its own, and check it's gone once the
  build says cancelled.
- **`mountUi({ extensions, profile, machines, layout, narrow, select })`**: `extensions` are set up as the app's,
  `profile: { ref, extensions }` as that profile's (drawn only in its threads). `machines` are test daemons
  (`daemonMachine(daemon, id)`) or fakes: `fakeMachine({ threads, values, methods, extensions, features })`, whose
  `setValue(key, value, scope)` changes a live value, and whose `calls` say what the window asked. Without setup, a
  fake is `local`, connected, with this build's features and no extensions. `threads.watch` and `thread.list` answer
  `threads` (none archived or hidden), `value.watch` a key's value from `values` (`null` if it isn't there; give a scoped
  value as `{ [scope]: value }`), `action.list` answers `actions`, and settings are empty. Any other method, and an
  action, runs `methods[name]`; with none, it fails `not_found`. `calls` leaves out the watches. `mountUi` has
  `render({ view, place, thread })` (`text()`, `find(selector)`, `click(text)`), `placed(place, { thread })`,
  `press(keys)`, `dispatch`, `select`, `setMachine(id, { state: 'disconnected' })`, `installProfile`, `until`, and
  `unmount()`, which tears every extension down (their `signal`s abort).
- **A pane kind or a slot**: `render({ pane: { kind, params } })` and `render({ slot, props })` draw them as the
  window does, for `thread`: an id the machine has, or a `ThreadInfo` as it is (`testThread({ cwd, profile, without })`);
  without one, the selected thread, the machine's first, or a made-up one of `mountUi`'s profile. A kind or slot that
  thread wouldn't see (a profile's in another profile's thread, one it goes `without`) throws, saying what it has.

  <!-- check: ui; import { expect } from 'vitest'; import { testThread, type TestWindow } from 'superego/testing'; declare const window: TestWindow; declare const thread: ThreadInfo -->
  ```ts
  const card = await window.render({ pane: { kind: 'board.card', params: { card: 'c1' } }, thread: thread.id })
  const badge = await window.render({ slot: 'thread.badge', thread: testThread({ cwd: '/work/db' }) })
  expect(badge.find('.thread-badge')?.title).toBe('database')
  ```
- The cases worth a test each, in the kit's own tests (`packages/sdk/test/kit.test.ts` in Superego's source): teardown (`unmount`, an edit and
  `reload`), set up twice (`installProfile` again), a helper edited, one profile on two machines (two daemons in one
  window), a machine away or older (`setMachine`, `fakeMachine({ features: [], extensions: [{ name, version: '0.9.0' }] })`),
  and a phone with no spaces (`mountUi({ narrow: true })`).

## When it doesn't show

```sh
superego extensions                   # every extension here: its version and the API it needs, where it's from, how it stands
superego extensions --thread 12       # and what thread 12 goes without, and why
superego extension reload             # load the profile's changes now
```

For each extension: where it's from (the core, bundled, a profile and its file, or a window, with no daemon half), its
state (`set up`, `off`, or `failed`, `refused` or `timed out` with the error), what it registered (methods, actions with
their keys, values, views and what they read, hooks), and who watches its values, whole or in how many scopes. Then
each profile's load (a project's not allowed says so), and with `--thread`, each extension that thread goes without:
switched off here, its profile's `without`, another extension's `agentFor`, or a profile's of another profile. `--json`
for all of it as data (`extensions.inspect`). What a UI half draws is the window's: one that throws says so in its
place, and the window's console has why.

## Cheat sheet

| Daemon half (`superego.` in `setup`) | For |
|---|---|
| `agent(defineExtension({ tools, sections, hooks }))` → `replace(next)`, `remove()` | the agent's tools, prompt sections and hooks. Its handle puts another part of the same name in its place (threads that have it get it from their next request to the model, mid-run too) or takes it away; called, it's `remove()`, so `setup: (s) => s.agent(part)` returns its cleanup. The handle: 1.7 |
| `action(defineAction({ id: 'x.y', params, run }))` | an intent: logged, in ⌘K; `expose: ['ui', 'cli']` for `superego do`; `keys` binds it in the window while one of the machine's threads is shown (`thread: true`: its `thread` filled in) |
| `method('x.y', run, { params })` | a read for the UI; params checked first |
| `value('x.y', initial)` → `get`, `set`, `update` | live state the UI watches; in memory |
| `scopedValue('x.y', initial)` → `get(scope)`, `set(scope, next)`, `update(scope, edit)`, `delete(scope)`, `scopes()` | live state kept per scope (a thread's id): a window watching one scope hears only its changes, never another thread's; in memory, so `delete` a thread's when it's done |
| `signal` | aborted at teardown: for its own timers, watchers and fetches (below) |
| `pane(kind, about)` | tell the agent about a pane kind, for `pane_open` |
| `view('x.y', { title, icon, context, fits, default, value \| method })` | a view drawn from data (below): no UI code, so a remote machine's or a project profile's runs no code in the window; its buttons still have that machine's authority |
| `status((thread) => ({ kind: 'question' }))`, `invalidate()` | show a thread as needing you |
| `beforeSend(({ thread, text, attachments, content, by, exposure }) => [...content, block])` | add to what a message gives the agent before its turn (a named skill's instructions); return nothing to leave it. `by`: the extension that sent it (`threads.send`, `threads.start`'s prompt), absent for the user's; `exposure`: `outside` when an outside agent sent it, `cli` the command line |
| `settings.register({ id: 'x', settings })`, `settings.get`, `settings.snapshot`, `settings.onChange` | machine settings of its own (`x.…`); read any |
| `dispatch(id, params)`, `actions(exposure)` | run any action on the machine as this extension (`settings.set`); list them |
| `thread({ starting, abandoned, started, turnStart, turnEnd, blocked, archiving, archived, unarchiving, unarchiveAbandoned, unarchived })` | take part in a thread's life (below): make it work elsewhere, refuse to archive it, clean up after it, hear it end a run or come to need the user |
| `state()` → `get(id)`, `set(id, next)`, `update(id, edit)` | state of its own kept with each thread, across restarts; `starting` gives a new one its first |
| `facts(({ id, state }) => …)` | what clients are told of a thread, as `thread.facts.<name>`: worked out from its state |
| `recap(({ thread, answer, calls }) => …)` | say in a line what a run did, once it ends: the thread's `done` status carries it (`msg`), and its notification says it. The first to answer wins; with none, the answer's first sentence. 1.6 |
| `toolCalls(({ thread, call, result }) => …)` | hear each tool call a thread's agent makes, once it ends; read-only ([Watching tool calls](daemon.md#watching-tool-calls)). 1.8 |
| `agentFor(({ id, state, profile }) => ({ instructions, model, extensions, without }))` | choose a thread's agent; the first to answer wins. `agent(part, { always: false })` gives a part only through this, or `agentParts` |
| `agentParts(({ id, hidden, owner, profile }) => [part])` | add to whatever agent a thread has: asked at every send, with its profile as loaded now (`profile.spec`); answers with parts given with `agent(part, { always: false })`. They add up: every extension's, after the chooser's and before the profile's. May be async, up to 5s; later, or a throw, adds nothing to that turn. 1.7 |
| `auth.flow(context, async (flow) => …)` → `{ flow }` | a sign-in flow of its own, for the client an action runs for (its context), carried as a provider's is: `flow.emit({ type: 'auth_url', url, callback })`, `await flow.prompt({ type: 'manual_code', message })`, `flow.signal`. It ends `done` when the function resolves, `failed` when it throws. The window draws it with `SignInFlow` (`superego/ui`). 1.7 |
| `threads.list({ archived, hidden })`, `get(id)`, `of(conversationId)`, `conversation(id)`, `attachments(id)` | reach threads, and the folder a thread keeps files in |
| `threads.start({ …, parent, hidden, options })`, `send(id, text)`, `lastAnswer(id)`, `entries(id, limit)`, `archive(id, { whenIdle })`, `unarchive(id)`, `clear(id)` | start and run threads as the thread tools do; `hidden`: in no list, an agent of its own with no profile, that takes no messages while the extension is off (find it by its `owner` in `list({ hidden: true })`, not by its facts, which are gone while the extension is off); `entries`: the newest since it was last cleared, as pi-durable's entry records (not a stable shape); `clear`: start it over |
| `machines.list()`, `machines.call(machine, method, params)` | the other machines this daemon reaches (its `machines.json`) and a call to one, as a client calls it (`thread.list`, `thread.start`); none when it reaches no others. 1.4 |
| `agentsDir`, `dataDir` | the folder agents share (`~/.agents`): skills, `AGENTS.md`; this machine's data folder (`~/.superego`) |
| `harness` | pi-durable itself; unstable |

| UI half (`superego.` in `setup`) | For |
|---|---|
| `view('x.y', { title, icon, context, fits, default, narrow, withoutSpaces, order, component, railButton, width })` | UI the layout puts in places (below): a space, a rail button, beside the thread, the pane menu, the title bar; `default` where it goes unless the user moves it |
| `slot(name, Component, { order })` | a component in a slot whose place behaviour decides (below): `header.chips` for a chip where the title bar says where a thread works, `thread.badge` for a small mark after its title in the sidebar (a `thread-badge`: a 12px icon with a `title`), `composer.above`, `details.section` (in thread details, ⌘I: an `<h5>` and what you know of the thread), `editor.side`, `editor.bar`, `overlay` |
| `newThreadField({ component, from })` | a field in the New thread dialog: its value goes to `thread.start` as `options.<name>`, for the daemon half's `starting`; `from(thread)` its value for one started like `thread`; bundled only |
| `signal` | aborted at teardown (its profile's UI reloaded or revoked): for its own timers, listeners and fetches (below) |
| `on(event, listener)` → off; `window` | hear the window: `thread.status` (`{ machine, thread, before }`; `before` undefined the first time it's seen), `select` (`{ selection, before }`), `focus` (`{ focused }`), `visibility` (`{ visible }`); `window` is `{ focused, visible, selection, thread }` now. In Electron and browsers alike |
| `appSetting(key)` | one of the app's settings as it is now, outside React |
| `pane(kind, { title, component, icon, file, menu, opens, fallback, folders, urls, width })` | a kind of pane beside the thread; `opens`, `folders`, `urls`: files, folders or web pages a thread names open in it; `fallback`: any file nothing else opens |
| `tool(name, { icon, verbs, subject, stat, meta, body, phrase, file, weight }, { fold })` | how calls to a tool look, described: `verbs: ['Read', 'Reading', 'Read failed']`, `subject(call)` after the verb, `body(call)` what it opens to, `phrase(count)` in a run's line ("read 2 files"); the rest default. The core's coding tools and `threads`' thread tools are rows too |
| `tool(name, Component, { fold })` | how calls to a tool look, drawn whole; `fold: false` shows them outside the run's fold (images) |
| `tool('mcp__*', …)` | a name ending in `*` is a prefix: every tool whose name starts so, where it has no row of its own; the longest prefix wins. 1.7 |
| `SignInFlow` (`superego/ui`) | a sign-in flow drawn as Settings → Providers draws one: `<SignInFlow machine title start={() => dispatch('x.signIn', …)} onClose />`, for an action that answers with `auth.flow`'s `{ flow }`. On the desktop, a flow on another computer whose `auth_url` has a loopback `callback` is caught here and answered for you. 1.7 |
| `entry(kind, Component)` | transcript entries of a kind it writes |
| `link({ match, open, render, target, scheme })` | claim links: `match` a scheme (`'ticket:'`), a pattern, or `(href, kind, where) => boolean` that sees inline code too (`kind: 'code'`); `open(href, { machine, thread, beside, openFile, openUrl })` follows one (a click, ⌘-click `beside`, ⌃O); `render` draws it; `scheme` names the scheme a pattern or test claims (`'thread'`), so HTML files keep its links. Claiming files, `[[wikilinks]]` or web pages overrides the core's: [Links](#links) |
| `composer.complete({ title, word(text, caret), items(word, { machine, thread }) })` | complete the word being typed: `word` finds it (`{ start, query }`), `items` offers `{ label, detail, insert }` |
| `composer.sentWith({ read(blocks), component })` | draw what its `beforeSend` put in sent messages under them (a chip): `read` returns `{ items, blocks }`, and those blocks leave the text |
| `work(divide)` | split a run of work into titled parts (tasks); bundled only |
| `action(defineAction({ id, keys, when, run }))` | a window action with keys, in ⌘K while `when(context)` holds; a profile's only while one of its threads is shown |
| `store('open', initial, { persist })` → `get`, `set`, `use()` | window state its actions and components share, kept as `<name>.open` (`'<name>.open'` is the same one) |
| `appSettings({ id, settings })` | per-user settings; `useAppSetting(key)`, `context.appSetting(key)`; bundled only |
| `settings(ui, Component)` | draw under a settings section that names `ui` |
| `dispatch(id, params, { machine })` | run any action outside React |

Names: everything is `<extension>.<something>`, except tool and pane kind names. In components: `useThreads`,
`useAllThreads`, `useProjects`, `useSelection`, `useMachines` (what each gives, and a thread's `status`: "Reading threads" in
[ui.md](ui.md)), `useValue(machine, key, { scope })`, `useMethod(machine.id, method, params, { enabled, refresh })` (a method's answer, with `error`, `loading` and `refetch`; called again as `params` or `refresh` change, answers to stale calls dropped), `useDispatch`, `call`, `has(machine, 'ext:x')` (whether a machine has an
extension set up and switched on now, kept current; UI-only extensions never appear; `'ext:x@^1.2'` at a version in
a range, see [Versions and compatibility](#versions-and-compatibility)), `version(machine, 'x')`; in panes `<PaneHeader>` and
`useTabNote`; in rows `<ThreadRef machine id>`; `transcriptLinks(machine, thread)`, the links a transcript shows; for a list to pick from (quick open, say), `<Picker label placeholder items filter row onPick onClose digits>`; to build from, `FileEditor`, `Markdown` and `Diff`. Full tables: [daemon.md](daemon.md), [ui.md](ui.md).

Machines update at different times, so a window can meet an older or newer daemon: a UI half that calls its daemon
half checks `has(machine, 'ext:x@<range>')` first, and says so, or offers nothing, when it's missing. See
[Versions and compatibility](#versions-and-compatibility).

## Versions and compatibility

Three versions, each for its own question:

| Version | What it versions | Where it's said | Who checks it |
|---|---|---|---|
| **The release** | the code a machine runs: its git commit (the packages are `0.0.0`) | `hello.machine.commit`, Settings → Machines ("an older Superego") | the user, who updates |
| **The extension API** | what the host gives extensions: `superego.` in either half, `'superego'`, `'superego/ui'`; semver, `EXTENSION_API` (`2.0.0`; 2.0 renamed sessions to projects and dropped generation 1's compatibility names; in 1.x, 1.1 added `signal`, a UI `setup`'s cleanup and `unarchiveAbandoned`; 1.2 `scopedValue` and `useValue`'s `scope`, `useMethod`, a profile's window actions, and `'superego/unstable'` apart; 1.3 `spawnGroup`; 1.4 `machines`; 1.5 channels and `paneClosed`; 1.6 `recap`; 1.7 `agentParts`, `agent()`'s handle, `auth.flow`, tool rows by prefix and `SignInFlow`; 1.8 `toolCalls`) | `hello.api` | the host, setting an extension up |
| **The protocol** | the wire: a generation, `PROTOCOL_VERSION` (`2`), and in it the features each side announces | `hello.version`, `hello.features` | both ends, at `hello` |

And each extension's own **version**, semver, which its other half, profiles and scripts rely on.

### Declaring them

An extension says its version and the extension API it needs in `about` (bundled), or in its definition (a profile's):

<!-- check: daemon -->
```ts
export const about = { name: 'orders', version: '1.2.0', api: '^2', title: 'Orders' } satisfies ExtensionAbout
```

- `version`: a **major** when something relying on its methods, actions, values or data views could no longer follow
  (a method's result changes shape, an action goes); a **minor** when something's added; a patch otherwise. Bundled
  extensions started at `1.0.0`. Unset: it counts as `0.0.0`.
- `api`: the range of extension APIs it works with: `^2` for any 2.x, `^2.1` once it uses something 2.1 added. A host
  outside the range refuses it before `setup` runs, with why: *Extension orders needs extension API ^3, and this
  Superego has 2.0.0: update Superego*. A bundled one fails the build's tests; a profile's fails its profile's load
  (the thread says so); a profile UI's is left out, the rest of the profile set up. Unset: any.
- `capabilities`: optional, finer than a version: things it can do that a client may ask about (`['stat']`).

The host's `EXTENSION_API` goes up a minor when the API grows, and a major when something an extension could rely on
changes or goes, which also moves every bundled extension's `api`.

### Checking them

Each daemon announces, for every extension set up and on there, `ext:<name>` in `features` (as before) and its
manifest (`{ name, version, api, capabilities }`) in `hello.extensions`, both kept current by `features.changed`. In
the window:

<!-- check: ui -->
```ts
has(machine, 'ext:git')          // set up and on there, at any version
has(machine, 'ext:git@^1.2')     // at 1.2 or later in 1.x
has(machine, 'ext:git@<2')       // any version this UI half speaks
has(machine, 'ext:git#stat')     // one that declares the capability
version(machine, 'git')          // '1.3.0'; '0.0.0' when it says none; undefined when it isn't there or is off
```

Ranges are the usual ones: `^1.2`, `~1.2`, `>=1.2 <3`, `1.2` (1.2.x), `*`, joined with `||`. A UI half checks the
daemon half by the majors it speaks (`git` and `skills` ask for `@<2`); a shape that changed in a minor, by `@^1.<minor>`.

Windows declare their extensions to each machine (`extensions.declare`), so one with no daemon half is listed there.
When two windows declare one differently, the newest version's word is taken, whatever order they connect in (at the
same version, the two are settled by what they say, the same way each time); an older window's never takes it back.

### The skew policy

What a window and a daemon of different releases do with each other:

- **Another protocol generation:** refused at `hello` (`version_mismatch`: *Update superego on the older side*).
  A generation changes for a break nothing can bridge, and starts clean: no old names, no read-throughs of old data.
- **The same generation:** they work together. The core's methods, actions, notifications and features only grow in
  a generation: `RELEASED` (`packages/protocol/src/released.ts`) lists what generation 2 released, and a test holds
  the daemon to answering all of it. Anything newer is announced in `FEATURES` and checked with `has` before it's
  used; a window checks an extension's daemon half the same way (`has(machine, 'ext:git@<2')`), and offers nothing,
  or says so, where it's missing. An extension a major ahead of what the window's UI half speaks is left alone by it.
- **Renaming something released** waits for the next generation. Until then, a moved name can be kept answering as an
  alias in `ALIASES` (`packages/protocol/src/compat.ts`), each with a milestone it goes by; generation 2 has none.
- **Stored data** isn't migrated: what an older release stored under an old name or in an old place isn't read.

## Links

A link in a message, in ⌃O's list, or in a Markdown file (rendered, or clicked in live preview) is followed by the
first handler that claims it, asked in this order:

1. **the thread's profile's** (its `ui` files' `superego.link`), only in that profile's threads;
2. **the extensions'**, in the order they're set up, but not those of an optional one the thread goes without
   (`threads` claims `thread:`);
3. **the core's**, the defaults: files a thread names (relative links, inline code that reads as a path, and
   `wikilink:`), which open in the pane kind that takes the file, and web pages (`http:`, `https:`, `mailto:`), which
   open in the browser, or beside in a pane that shows web pages (`urls: true`, `web-panes`' Preview).

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
the core's. The core's file and web handlers stay the core's rather than `files`' or `web-panes'`: both extensions
are optional, and a link to a file or a page has to work in a thread that goes without them.

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
  layout*. Settings → General → Layout has *Edit layout…* and *Reset*, and no layout can take Settings away: the
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
not no authority: its buttons run that machine's actions. The content is a few fixed parts,
any of them, top to bottom: a `note`, `facts` (label and value), `items` (a list: `title`, `subtitle`, `detail`,
`status`, a `thread` to link, `actions`), a `table` (`columns`, `rows`), `markdown`, and `actions` (buttons), with
`empty` for when there's none. A button runs one of the extension's own actions (`<extension>.<name>`) on that
machine, as the window may (one exposed to `ui`); a button naming any other is left out.

<!-- check: daemon; type Order = { id: string; customer: string; late: boolean }; declare function ship(id: string): Promise<Order[]> -->
```ts
// orders.ts, a daemon half: the open orders, as a space, with a button on each
const open = superego.value<ViewContent>('orders.open', { items: [], empty: 'No open orders.' })
const show = (orders: Order[]) => open.set({
  note: `${orders.length} open`,
  items: orders.map((o) => ({ id: o.id, title: `No. ${o.id}`, subtitle: o.customer, status: o.late ? 'blocked' : 'idle',
    actions: [{ title: 'Ship', action: 'orders.ship', params: { id: o.id } }] })),
})
superego.action(defineAction({ id: 'orders.ship', title: 'Ship an order', params: obj({ id: str() }), run: async ({ id }) => show(await ship(id)) }))
superego.view('orders.open', { title: 'Orders', icon: 'list', context: 'window', fits: ['space', 'beside'], default: 'space', value: 'orders.open' })
```

- The source is a live value of the extension's (`value`), or a method of its (`method`), read again as the thread
  moves on and after a button ran. A `thread` view's value is a `scopedValue`, each thread's content in its scope (or a plain value holding each thread's by its id: the window watches only that entry), and its method is
  called with `{ thread }`.
- Data views fit `space`, `beside` and `pane` (a `window` view: `space` and `beside`), and the layout places them as any
  other. A `thread` view in `pane` is a pane kind of its id; with `about`, the agent is told it can open it.
- The window hears of them as every daemon's live value `view.list`. A view a machine's extension declares shows a
  thread only from that machine, and a `window` view gathers every machine's, each under its name. A profile's fit only
  `beside` and `pane`, in its own threads. An extension's UI half that declares a view of the same id draws it instead.
- The window checks what it's sent as it lands, not on the machine's word: a declaration must be of one of that
  machine's extensions that's on, named for it (its id and its source `<extension>.<name>`), in places there are (a
  profile's never a space), and within bounds (how many views, items, rows and columns, how long a string, how deep
  and big a button's params). Content is held to the same. What isn't is left out, with a warning on the console and,
  for content, a quiet word in the view; a view that throws as it draws says so in its place, with Try again.
- The `skills` extension's *Skills* is one (`extensions/skills/src/daemon.ts`).

### On a phone

Below 600px wide there's no rail and no title bar. `space` views are the drawer, with the others to switch to at its
foot beside `drawer` views (Ego, Unread) and Settings. The thread's title opens its **sheet**, which holds the title
bar's (`header` views, where it runs, archiving), the pane menu, and the `beside` views. With no space there's no
drawer: `titlebar` views (the thread picker) and Settings are in the bar at the top instead.
`narrow` moves a view elsewhere on a phone.

## Hearing the window

`on` tells a UI half what happens in the window, whatever it draws. Listening is owned like everything else, and stops
at teardown. A thread that goes without the extension isn't heard of; a profile hears only its own threads.

<!-- check: ui; import { threadNotification } from 'superego/unstable' -->
```ts
// notifications: a thread wants a look while the window is in the background.
superego.on('thread.status', ({ machine, thread, before }) => {
  if (before === undefined || (superego.window.focused && superego.window.visible)) return
  const notification = threadNotification(machine, thread)    // finished, failed or needs you; else nothing
  if (notification) void call('app', 'app.notify', notification)    // the desktop's notification, or the browser's
})
```

`window` is how things are as the event arrives: `focused`, `visible`, the `selection` and the `thread` it shows. The
core marks a finished thread seen the same way, on `select`, `focus` and `thread.status`.

`auth.rejected` is a machine's provider rejecting its credentials (`{ machine, rejection }`, a `ProviderRejection`):
once, however many threads it stops. Those threads are `blocked` with kind `auth` (`waitingForSignIn`), quiet on their
own, and go on by themselves once the machine is signed in again; `threadNotification` says nothing of them, `signInNotification`
says it once for all.

## Lifecycle and ownership

<picture><source media="(prefers-color-scheme: dark)" srcset="guide/lifecycle-dark.svg"><img src="guide/lifecycle.svg" alt="Set up, registrations owned by the extension, torn down when its profile changes or the daemon stops, then set up again"></picture>

Each set-up of an extension, in either half, has one lifetime: everything it registers is owned by it, and teardown
(its profile reloaded or gone, its UI revoked, the daemon stopping) ends all of it at once.

- Teardown aborts `superego.signal`, then runs `setup`'s cleanup (if it returned one), then undoes every registration,
  last first. Each step is tried whatever the others do: a cleanup that throws is logged, and the rest still goes, its
  name too, so the next version sets up. Torn down twice, nothing more happens.
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
  run of it resumes. A project's profile runs only once allowed (`superego profile allow`), as its files and those it
  lists from outside its folder are then. Profiles load one at a time: keep `setup` quick, and never await work that
  loads a profile (starting or reading a thread) in it.
- Profiles that name the same file (one `extends` another, or both list it) share one set-up of it, torn down after
  the last lets go. Each gets its agent parts.
- A change loads between runs, never under one: a thread mid-run keeps what it started with. A profile whose folder
  is gone, or that no longer loads or is allowed, is torn down, and its UI with it. A value torn down reads null.
- What a reload runs: a profile's daemon modules load by versions of their own, each the hash of the module and every
  local file it imports, so an edit to a helper alone loads the new code, and that of whatever imports it. A module none
  of whose files changed is the one loaded before, its module-level state with it (keep state in `setup`, which runs
  again); a helper two extensions import is one module, as ever. Packages (bare imports, `node_modules`) load once:
  restart the daemon for a new version of one. Imports are read as JavaScript is (comments and strings aren't
  imports), static and `import('./literal.ts')` alike; an `import()` of a path worked out as it runs is refused, as
  what it loads couldn't be versioned or vouched for. The window loads a profile's UI modules afresh, all of them,
  whenever any of the profile's files changed.
- What allowing a project's profile vouches for is every file its code can run, read from the same imports a reload
  follows: each module in its folder and every local file they import, hidden or outside it, symlinks followed; a file
  it lists from outside, with what that imports; and its folder's other files (not dotfiles). Not packages, nor files
  elsewhere its code reads or starts as it runs.
- A profile's UI from another machine runs in the window only once allowed on this computer (the thread's notice, or
  `superego profile allow-ui <name> -m <machine>`), for a hash the window takes of the sources it received; any change
  to them asks again, and Revoke (Settings → Machines) takes out what it registered at once. Once running it has the window's full
  reach, every machine's `call` and `dispatch` included: it runs in the window's own JavaScript, where narrowing its API
  wouldn't stop it calling `window.superego` directly. Real isolation is the sandboxed tier PLAN.md plans.

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
- `blocked` is told when a thread comes to need the user mid-run (an extension's `status`: `ask-user`'s question), once
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
`coding-tools`, `panes` and `agents-md`. A package may be two extensions, one per half,
where the halves differ: `extensions/threads` is the required sidebar in the window, and `thread-tools`, the agent's
thread tools, on the machine, so switching the tools off leaves the sidebar (and the rows and links naming threads).
The core's `panes` is the agent's `pane_open`: switched off, the agent can't open panes, but the window's own pane
kinds stay, being the required core's. An extension with a UI half only needs no daemon half: the window declares it
to each machine, which lists it and lets profiles do without it.

## Real ones to read

The build queue ships with this guide, in [`examples/`](examples) beside it. The bundled extensions are in Superego's
source, at `extensions/<name>/src`, so only a checkout has them.

| Extension | Shows |
|---|---|
| [`build-queue`](examples/build-queue), [`build-queue-ui`](examples/build-queue-ui) | a profile's extension both ways: a tool, a `scopedValue` per thread, a Cancel action, a data view or a UI half's view, a shortcut; tests on `superego/testing` |
| `tasks` | the smallest: two tools and a prompt section; a `work` divider |
| `suggestions` | a hook, a side call, a `scopedValue` per thread, a `composer.above` slot |
| `ask-user` | a tool that waits on you: `status`, an action to answer, a `scopedValue` per thread (and the old list kept for older windows), a `tool` view |
| `images` | a tool with `{ fold: false }`, files kept with `threads.attachments` |
| `git` | Changes: a `method` (a read), a `pane` the agent is told of, built on the kit's `Diff`, an `action` with keys |
| `web-panes` | two pane kinds and nothing else; `urls: true` makes web links open in one |
| `skills` | a prompt section, a `submit` transform, a `method`; `composer.complete` and `composer.sentWith` |
| `files` | a `method`, a `pane` the agent is told of, an `overlay`, `store`s, `when` |
| `links` | UI only: the window declares it to the machine; a `Picker` over `transcriptLinks`, the links handlers drew |
| `unread` | UI only: a view in the rail `withoutSpaces` and in a phone's `drawer`, an action with keys reading projects, an app setting |
| `notifications` | UI only: `on('thread.status')`, `on('auth.rejected')` and `window`, `app.notify` (desktop and browser alike), a `composer.above` offer |
| `threads` | the required one: views (the list a `space` with a `rail` of its own, details in the `beside` with ⌘I, the model in the `header`), app settings, tool rows and a `link`; its daemon half is two other, optional extensions: `thread-tools`, on `superego.threads`, and `thread-reports`, report-back through `turnEnd` and `blocked` hooks, for the runs the parent asked for (told by a send transform's `by`) |
| `worktrees` | `thread` hooks (`starting` moves a thread, `archived` cleans up, `unarchiving` puts back), `state` and `facts`; a `header.chips` chip, a `thread.badge` mark and a `newThreadField` |
| `mcp-servers` | a settings section drawn by a component of its own (`settings(ui, …)`) from a live value, with dialogs and `SignInFlow`; tool rows by prefix (`mcp__*`) with a call's own `verb` and images; a `header` view, a `details.section` slot and a `composer.above` notice, all from the thread's facts |
| `ego` | an agent of its own: a `hidden` thread, `agentFor` with `agent(part, { always: false })`, an `archiving` refusal, a `value` older windows follow (the rail button reads the selection); a view in the `rail`, and in a phone's `drawer` |

Diagram sources are the `.mmd` files in [guide/](guide/); re-render with the `diagram` skill
(`bun <skill>/scripts/render.ts x.mmd x.svg`, and `--dark` for `x-dark.svg`).
