# Writing extensions

An extension has up to two halves: a **daemon half** next to the agents on a machine, and a **UI half** in the window.
Either can be left out. Everything either half registers is its own, and goes when it does.

This topic builds one and tests it. Beside it: the [cheat sheet](cheatsheet.md) of both halves, [the window](window.md)
(views and places, links, window events), and [lifecycle](lifecycle.md) (teardown, a thread's hooks, versions).

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
| `'superego'` | the daemon half and a profile: `defineDaemonExtension`, `defineProfile`, `defineExtension`, `defineTool`, `defineAction`, the schema helpers (`obj`, `str`, …), `RpcError`, `spawnGroup` (a command run as a process tree that stops as one), and their types (`DaemonApi`, `ScopedValue`, `Block`, …) | stable: follows the extension API's version |
| `'superego/ui'` | the UI half: `defineUiExtension`, `defineAction`, hooks (`useMethod`, `useValue`, `useDispatch`, `useSelection`, …), `call`, `has`, `version`, components to build from (`Markdown`, `PaneHeader`, `Picker`, `Diff`, `FileEditor`, `Button`, the icons), and their types | stable |
| `'superego/testing'` | test helpers: a daemon with a scripted model, a window with a fake bridge, `isRunning(pid)` (see [Testing](#testing)) | stable |
| `'superego/unstable'` | the window's workings the bundled extensions build on: `useRegistry`, `useShell`, `fileKind`, `Slot`, the project list, `useThreadView`, `channel`, `MONO_FONT`, … | none: changes with the window |

On a `DaemonApi`, `threads.conversation` and `threads.entries`' records are pi-durable's shapes, unstable too.
Everything else in the [cheat sheet](cheatsheet.md) is stable.

## Starting one

```sh
superego extension new notes              # an agent tool, in a daemon half
superego extension new notes --ui         # a pane, UI half only
superego extension new notes --badge      # a sidebar mark: a daemon half sets a fact, a UI half draws it
superego extension new notes --tool --ui  # a tool, and a pane of what it did
superego extension test notes             # check its types and run its tests
```

`new` makes the extension in a folder of its own in this project's profile (`.superego/profiles/default`; `-P name`
for another, `--user` for yours in `~/.superego/profiles`), making the profile if there's none, and lists it there.
It's the smallest working one of its shape to change: a tool that counts words; a pane of the thread it's beside
(described to the agent in the profile's `panes`); a mark on threads whose last command failed (`toolCalls` → `state` →
`facts` → `thread.badge`); or a tool that adds to the thread's items and a pane of them (`about.panes`). Each has its
`version` and the extension `api` it needs, a test on [`superego/testing`](#testing) that passes as made, a README, and
the profile's types, as `superego profile types` gives them: a `tsconfig.json`, and `node_modules` linked to
`~/.superego/types`, the declarations of `'superego'`, `'superego/ui'`, `'superego/testing'`, React and vitest built
from this Superego's own source, so `test` (and an editor) checks the types. Send one of the profile's threads a message
and it's there; after an edit, the next turn loads it again (`superego extension reload` loads it now). A project's profile runs as it was allowed: the user allows it again
after an edit (`superego profile allow`, or in the window). That's their consent: an agent's is refused, so ask them.

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
  name: 'notes', version: '1.0.0', api: '^5',
  panes: { notes: "the thread's NOTES.md; no params" },
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
  },
})
```

```tsx
// ui.tsx: the UI half. A pane, offered in the thread's pane menu.
import { defineUiExtension, has, PaneMessage, useMethod, type PaneProps } from 'superego/ui'

function Notes({ machine, thread }: PaneProps) {
  // Read again as the thread moves on; nothing until the machine has the daemon half (its profile loads with the
  // thread's first turn), then at once.
  const { data, error } = useMethod<{ text: string }>(machine.id, 'notes.read', { id: thread.id },
    { enabled: has(machine, 'ext:notes@^1'), refresh: thread.activeAt })
  if (error) return <PaneMessage>{error.message}</PaneMessage>
  return <pre className="pane-scroll">{data?.text || 'No notes yet.'}</pre>
}

export default defineUiExtension({ name: 'notes', version: '1.0.0', api: '^5', setup: (superego) => superego.pane('notes', { title: 'Notes', component: Notes, menu: true }) })
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
scoped value, what the view shows as blocks, with a Cancel button on each build; the view reads it, each thread its
own scope. The shortcut is a machine action with `keys`, offered while one of that machine's threads is shown
(`thread: true` fills in its `thread`); it opens the view as a pane, which a `thread` view that fits `pane` is.

<!-- check: daemon; declare const queue: import('superego').ScopedValue<Build[]> -->
```ts
const view = superego.scopedValue<Block[]>('builds.view', [])
const show = (thread: string) => view.set(thread, [{
  type: 'list',
  items: queue.get(thread).map((b) => ({ title: b.command, subtitle: b.state,
    buttons: [{ id: `cancel-${b.id}`, label: 'Cancel', action: 'builds.cancel', params: { thread, id: b.id } }] })),
}])
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
  if (!has(machine, 'ext:builds@^1')) return <PaneMessage>No build queue on {machine.label}.</PaneMessage>
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
  set up as the app's own (a factory's with the options a test needs: `ordersExtension({ clock })`). `model` is the
  model's turns in order: `say(text)`, `callTool(name, args)`, `callTools(…)`; or `'echo'`, a model that answers every
  request with the last user message (side calls to the thread's model too). `dataDir` runs it on a folder you made
  (and keeps it). It has `thread(prompt)`, `send`, `idle`, `info`, `call`, `dispatch` (an `action.run` call),
  `watch(key, { scope })` (`value`, `seen`, `until(check)`), `until(check)` (a function that returns true, or a promise
  of it); `toolCalls(thread)`, the calls a thread made in order (`{ name, args, result: { isError, text } }`),
  `facts(thread)`, what extensions say of it (`superego.facts`), and `transcript(thread)`, its entries as JSON text
  (a thread is its id or its info); `setSecret(key, value)` sets a `secret` setting as the user would (`null` clears
  it), kept in the test's data folder, never your keychain, which also holds each extension's `superego.dir`; `extensions` (the manifests of those set up and on there, kept current: where yours shows) and
  `features` (protocol features only); `app` (its own id), `dataDir` and `agentsDir` (skills go in `skills/`); `peer`,
  the connection (`Channels.of(daemon.peer)` opens a channel), and `connect()` for another client's, as a second
  window; `profile`, the ref its threads have; `edit(path, content)` then `reload()` to load a change (a helper edited
  alone loads too); `restart({ model, whileStopped })` on the same folder (`whileStopped` runs while no daemon does),
  after which the same handle, its watches and a window over it reach the new daemon; `close()`.

  <!-- check: daemon; import { expect } from 'vitest'; import { callTool, say, testDaemon } from 'superego/testing'; declare const profile: string -->
  ```ts
  const daemon = await testDaemon({ profile, model: [callTool('enqueue_build', { command: 'make' }), say('Queued.')] })
  const thread = await daemon.thread('Build it')
  expect(await daemon.toolCalls(thread)).toMatchObject([{ name: 'enqueue_build', args: { command: 'make' }, result: { isError: false } }])
  await daemon.restart({ model: [say('Still here.')] })      // the same daemon object, on the same folder
  expect((await daemon.send(thread, 'Still there?')).status.msg).toBe('Still here.')
  ```
- **`isRunning(pid)`**: whether a process is still there, to check that what an extension started stopped with it.
  The queue examples' tests cancel a build whose command starts a `sleep` of its own, and check it's gone once the
  build says cancelled.
- **`mountUi({ extensions, profile, machines, layout, narrow, select, window })`**: `extensions` are set up as the app's,
  `profile: { extensions }` as that profile's (drawn only in its threads): the test daemon's profile when the machine
  is one, else the profile `extension test` runs (`ref` for another). `machines` are test daemons
  (`daemonMachine(daemon, id)`) or fakes: `fakeMachine({ threads, values, methods, extensions, features })`, whose
  `setValue(key, value, scope)` changes a live value, and whose `calls` say what the window asked. Without setup, a
  fake is `local`, connected, with this build's features and no extensions. `threads.watch` and `thread.list` answer
  `threads` (none archived or hidden), `value.watch` a key's value from `values` (`null` if it isn't there; give a scoped
  value as `{ [scope]: value }`), `action.list` answers `actions`, and settings are empty. Any other method, and an
  action, runs `methods[name]`; with none, it fails `not_found`. `calls` leaves out the watches. `mountUi` has
  `render({ view, place, thread })` (`text()`, `find(selector)`, `click(text)`: a button, link, tab, menu item, list
  row or any element by its text or `aria-label`, else a selector; it fails naming what there is to click),
  `placed(place, { thread })`,
  `press(keys)`, `dispatch`, `select`, `setMachine(id, { state: 'disconnected' })`, `installProfile`, `until`, and
  `unmount()`, which lets a profile's UI the window is still fetching land, then tears every extension down (their
  `signal`s abort): unmount before closing the daemons it's on. `window: true` draws the whole window, as the app does
  (`ui.window`: the rail, the sidebar, the thread, ⌘K, Settings, and what opens over them), to see your view in place
  and drive it as a person would: `key('mod+k')` presses keys where the focus is, `type(selector, text)` types into a
  field. Its app settings are the app's own. Give its test file `// @vitest-environment happy-dom`: the window's menus
  and dialogs open, and its fields take typing, only in a DOM that was there as React and they loaded.
- **A pane kind or a slot**: `render({ pane: { kind, params } })` and `render({ slot, props })` draw them as the
  window does, for `thread`: an id the machine has, or a `ThreadInfo` as it is (`testThread({ cwd, without })`, a thread
  of `mountUi`'s profile while it's mounted, else of the profile under test; `profile: null` for none);
  without one, the selected thread, the machine's first, or a made-up one of `mountUi`'s profile. A kind or slot that
  thread wouldn't see (a profile's in another profile's thread, one it goes `without`) throws, saying what it has.
- **Tool rows and links**: `render({ tool: { name, arguments, state, result }, thread })` draws a call's row as the
  transcript does, from what your `superego.tool` said; `toolRow(name, { thread })` is that description,
  `describeRun(['read', 'mcp__x__y'], { thread })` a run's folded line and `mainKind` the tool it's shown as.
  `linkHandler(href, 'link' | 'code', { thread })` is what claims a link there (no thread: outside any, a settings page),
  and `urlKind({ thread })` the pane kind web pages open in.

  <!-- check: ui; import { expect } from 'vitest'; import { testThread, type TestWindow } from 'superego/testing'; declare const window: TestWindow; declare const thread: ThreadInfo -->
  ```ts
  const card = await window.render({ pane: { kind: 'board.card', params: { card: 'c1' } }, thread: thread.id })
  const badge = await window.render({ slot: 'thread.badge', thread: testThread({ cwd: '/work/db' }) })
  expect(badge.find('.thread-badge')?.title).toBe('database')
  ```
- The cases worth a test each, in the kit's own tests (`packages/sdk/test/kit.test.ts` in Superego's source): teardown (`unmount`, an edit and
  `reload`), set up twice (`installProfile` again), a helper edited, one profile on two machines (two daemons in one
  window), a machine away or older (`setMachine`, `fakeMachine({ features: [], extensions: [{ name, version: '0.9.0' }] })`),
  and a phone with no sidebars (`mountUi({ narrow: true })`).

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
for all of it as data (`extension.inspect`). What a UI half draws is the window's: one that throws says so in its
place, and the window's console has why.

## Real ones to read

The build queue ships with this guide, in [`examples/`](examples) beside it. The bundled extensions are in Superego's
source, at `extensions/<name>/src`, so only a checkout has them.

| Extension | Shows |
|---|---|
| [`build-queue`](examples/build-queue), [`build-queue-ui`](examples/build-queue-ui) | a profile's extension both ways: a tool, a `scopedValue` per thread, a Cancel action, a data view or a UI half's view, a shortcut; tests on `superego/testing` |
| `tasks` | the smallest: two tools and a prompt section; a `work` divider |
| `suggestions` | a hook, a side call, a `scopedValue` per thread, a `composer.above` slot |
| `agent-ui` | tools that wait on you (one queue, a `scopedValue` per thread, `status` while it asks, an action to answer, one `composer.above` card claiming the composer), tools that draw blocks (`tool` views, some `{ fold: false }`), a pane kind drawn from its `state` with each thread, published per thread (`state({ publish })`), and a prompt section the tools' descriptions point to |
| `images` | a tool with `{ fold: false }`, files kept with `threads.attachments` |
| `git` | Changes: a `method` (a read), a `pane` the agent is told of, built on the kit's `Diff`, an `action` with keys |
| `browser` | a pane kind, described in `about.panes` (so no daemon half: the daemon lists its `about`); `urls: true` makes web links open in it, `menu: true` offers it in the pane menu, an app setting (its search engine) and an action with keys (`⌘T`) |
| `skills` | a prompt section, a `beforeSend` transform, a `method`; `composer.complete` and `composer.sentWith` |
| `mentions` | a `beforeSend` transform; `composer.complete` (with `superego.window`'s threads and `files.list`) and `composer.sentWith`'s `words` |
| `files` | a `method`, a `pane` the agent is told of, an `overlay`, `store`s, `when` |
| `links` | UI only: the window declares it to the machine; a `Picker` over `transcriptLinks`, the links handlers drew |
| `unread` | UI only: a view in the rail `withoutSidebar` and in a phone's `drawer`, an action with keys reading projects, an app setting |
| `threads` | the required one, UI only: views (the list a `sidebar` with a `rail` button of its own, details in the `beside` with ⌘I, the model in the `header`), app settings, tool rows and a `link` |
| `thread-tools` | daemon only: the agent's thread tools, on `superego.threads` (`send` with `from`, `noteRead` for what a thread read, `idle` for thread_read's wait); it exports `readTool` and `listTool` for reuse (Ego) |
| `thread-reports` | daemon only: report-back through `turnEnd` and `blocked` hooks, for the runs the parent asked for (told by `beforeSend`'s `by` and `from`), not what the parent has read (`threads.parentRead`); `quiet` for a child whose parent hears it |
| `worktrees` | `thread` hooks (`starting` moves a thread, `archived` cleans up, `unarchiving` puts back), `state` and `facts`; a `header.chips` chip, a `thread.badge` mark and a `newThreadField` |
| `mcp-servers` | a key of its own in profiles (`profileKey('mcpServers', …)`); a settings section drawn by a component of its own (`settings(ui, …)`) from a live value (the section's `value`), with dialogs and `SignInFlow`; tool rows by prefix (`mcp__*`) with a call's own `verb` and images; a `header` view, a `details.section` slot and a `composer.above` notice, all from the thread's facts |
| `ego` | an agent of its own: a `hidden` thread, `agentFor` with `agent(part, { always: false })`, an `archiving` refusal, a `beforeSend` transform marking an outside agent's message and `threads.answering` to tell a call that answers one; the machines list through `machines.add`/`update`/`remove`; a view in the `rail`, and in a phone's `drawer` |
| `terminal` | bytes on a `channel` (the window's half with `channel` from `superego/unstable`), a `pane` in the pane menu, an action with keys, a `method` for its size, OSC 7501 status as a `scopedValue` and the thread's `status`, `thread` hooks to end its shells |

Diagram sources are the `.mmd` files in [guide/](guide/); re-render with the `diagram` skill
(`bun <skill>/scripts/render.ts x.mmd x.svg`, and `--dark` for `x-dark.svg`).
