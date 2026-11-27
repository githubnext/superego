# Writing extensions

An extension has up to two halves: a **daemon half** beside the agents on a machine, and a **UI half** in the window.
Either is optional. What a half registers goes when it does.

See also: the [cheat sheet](cheatsheet.md), [the window](window.md) (places, links, events), [lifecycle](lifecycle.md)
(teardown, a thread's hooks, versions).

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

A profile's halves import `'superego'` and `'superego/ui'`; a bundled extension's import the packages directly
(`@superego/daemon`, `@superego/app/ui`, …: [bundled.md](bundled.md)).

### What to import

| Import | What | Stability |
|---|---|---|
| `'superego'` | the daemon half and a profile: `defineDaemonExtension`, `defineProfile`, `defineExtension`, `defineTool`, `defineAction`, the schema helpers (`obj`, `str`, …), `RpcError`, `spawnGroup` (a command run as a process tree that stops as one; `outlive` and `adoptGroup` for one that outlives the daemon), and their types (`DaemonApi`, `ScopedValue`, `Block`, …) | stable: follows the extension API's version |
| `'superego/ui'` | the UI half: `defineUiExtension`, `defineAction`, hooks (`useMethod`, `useValue`, `useDispatch`, `useSelection`, …), `call`, `has`, `version`, components to build from (`Markdown`, `PaneHeader`, `Picker`, `Diff`, `FileEditor`, `Button`, the icons), and their types | stable |
| `'superego/testing'` | test helpers: a daemon with a scripted model, a window with a fake bridge, `isRunning(pid)` (see [Testing](#testing)) | stable |
| `'superego/unstable'` | the window's workings the bundled extensions build on: `useRegistry`, `useShell`, `fileKind`, `Slot`, the project list, `useThreadView`, `channel`, `MONO_FONT`, … | none: changes with the window |

`threads.conversation` and `threads.entries`' records are pi-durable's shapes, unstable too. The rest of the
[cheat sheet](cheatsheet.md) is stable.

## Starting one

```sh
superego extension new notes              # an agent tool that counts words, in a daemon half
superego extension new notes --ui         # a pane of the thread it's beside (described in the profile's panes)
superego extension new notes --badge      # a mark on threads whose last command failed (toolCalls → state → facts → thread.badge)
superego extension new notes --tool --ui  # a tool that adds to the thread's items, and a pane of them (about.panes)
superego extension test notes             # check its types and run its tests
```

`new` makes the extension in its own folder in this project's `default` profile (`-P name` for another, `--user` for
yours), creating the profile if needed. It writes `version`, `api`, a passing test on [`superego/testing`](#testing), a
README, and the profile's types (`tsconfig.json`, `node_modules` linked to `~/.superego/types`), so `test` and an
editor check types.

- Send one of the profile's threads a message and it's there. After an edit, the next turn reloads it;
  `superego extension reload` reloads now.
- A project's profile needs the user to allow it again after an edit (`superego profile allow`, or in the window).
  An agent's allow is refused: ask them.
- A thread keeps the profile it started with: a profile made after (the first `default`, made by `new`) doesn't reach
  it. Start a new thread, or move an idle one: `superego do thread.setProfile --thread <thread> --profile <name>`.

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

Send a thread a message: the daemon loads the profile and the agent has `add_note`. The window loads the UI as soon
as it lists the thread ([ui.md](ui.md#when-the-ui-loads)).

## The build queue, two ways

A tool the agent queues builds with, the thread's queue beside it, a Cancel button on each build, and a shortcut to
show it. Both versions are in [`examples/`](examples), each a profile folder with tests.

The queue is per thread, so it's a **scoped value**: a window showing a thread watches that thread's scope only.

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

Run builds with **`spawnGroup`**: a build's command starts processes of its own, and stopping only its shell leaves
them writing to the thread's folder.

- `stop()` sends the group SIGTERM, then SIGKILL after `grace` (5s), and resolves once nothing of it is left. Given
  `superego.signal`, teardown stops it the same way. On Windows it ends the tree at once (`taskkill /T /F`).
- `exited` waits for the whole group, and says whether it was `stopped`.
- Mark a build running before anything is awaited, so two calls can't both start it; say it's cancelled only once it
  has stopped.

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

**Data-only** ([`build-queue`](examples/build-queue/builds/daemon.ts)): no UI code. A second scoped value holds the
view's blocks per thread, a Cancel button on each build. The shortcut is a machine action with `keys`, offered while
one of that machine's threads is shown (`thread: true` fills in `thread`); it opens the view as a pane.

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

**With a UI half** ([`build-queue-ui`](examples/build-queue-ui/builds/ui.tsx)): a component draws the queue from
the thread's scope, and the shortcut is a window action that shows or hides the view beside the thread.

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

`'superego/testing'` runs an extension as Superego does: the daemon half in a real daemon with a scripted model, the
UI half in the window's own registry and shell, in a DOM, over a fake machine or that daemon.

`superego extension test` type-checks, then runs the profile's `*.test.ts` and `*.test.tsx`. Nothing to install: it
has vitest's `describe`, `it`, `test`, their hooks, `expect` and `vi` (`vi.fn`, `vi.spyOn`, fake timers,
`vi.waitFor`); no snapshots, `vi.mock` or `expect.poll`. A `.ts` file loads as the daemon loads it, types stripped
(import types as `import { type Name }`); a `.tsx` as the window does.

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

### `testDaemon({ profile, extensions, model, dataDir })`

| Option | |
|---|---|
| `profile` | a folder (copied) or files by path |
| `extensions` | set up as the app's own (a factory's with what the test needs: `ordersExtension({ clock })`) |
| `model` | the model's turns in order: `say(text)`, `callTool(name, args)`, `callTools(…)`; or `'echo'`, answering every request (side calls too) with the last user message |
| `dataDir` | run on a folder you made (kept) |

| Member | |
|---|---|
| `thread(prompt)`, `send`, `idle`, `info` | start a thread with the profile (sent, run waited out), message it, wait, read it. A thread is its id or its info |
| `call`, `dispatch` | a method; an `action.run` |
| `watch(key, { scope })` | a live value: `value`, `seen`, `until(check)` |
| `until(check)` | wait until a function returns true (or a promise of it) |
| `toolCalls(thread)` | the calls a thread made, in order: `{ name, args, result: { isError, text } }` |
| `facts(thread)`, `transcript(thread)` | what extensions say of it (`superego.facts`); its entries as JSON text |
| `setSecret(key, value)` | set a `secret` setting as the user would (`null` clears), kept in the test's data folder, never your keychain |
| `extensions`, `features` | manifests of those set up and on, kept current; protocol features only |
| `app`, `dataDir`, `agentsDir` | its id; its folders (skills go in `agentsDir/skills/`; each extension's `superego.dir` is under `dataDir`) |
| `peer`, `connect()` | the connection (`Channels.of(daemon.peer)` opens a channel); another client's, as a second window |
| `profile` | the ref its threads have |
| `edit(path, content)`, `reload()` | change a file and load it (a helper alone too) |
| `restart({ model, whileStopped })` | restart on the same folder (`whileStopped` runs in between); the handle, its watches and a window over it reach the new daemon |
| `close()` | |

<!-- check: daemon; import { expect } from 'vitest'; import { callTool, say, testDaemon } from 'superego/testing'; declare const profile: string -->
```ts
const daemon = await testDaemon({ profile, model: [callTool('enqueue_build', { command: 'make' }), say('Queued.')] })
const thread = await daemon.thread('Build it')
expect(await daemon.toolCalls(thread)).toMatchObject([{ name: 'enqueue_build', args: { command: 'make' }, result: { isError: false } }])
await daemon.restart({ model: [say('Still here.')] })      // the same daemon object, on the same folder
expect((await daemon.send(thread, 'Still there?')).status.msg).toBe('Still here.')
```

`isRunning(pid)` says whether a process is still there: the queue examples cancel a build that started a `sleep`, and
check it's gone.

### `mountUi({ extensions, profile, machines, layout, narrow, select, window })`

| Option | |
|---|---|
| `extensions` | set up as the app's |
| `profile: { extensions, global? }` | set up as that profile's, drawn only in its threads: the test daemon's profile when the machine is one, else the profile `extension test` runs (`ref` for another) |
| `machines` | test daemons (`daemonMachine(daemon, id)`) or fakes (below) |
| `narrow` | a phone, with no sidebars |
| `window: true` | the whole window as the app draws it (rail, sidebar, thread, ⌘K, Settings), with the app's own settings. Needs `// @vitest-environment happy-dom` in the test file for menus, dialogs and fields to work |

`fakeMachine({ threads, values, methods, extensions, features })`: by default `local`, connected, this build's
features, no extensions. `threads.watch` and `thread.list` answer `threads` (none archived or hidden); `value.watch`
answers from `values` (`null` if absent; scoped as `{ [scope]: value }`); `action.list` answers `actions`; settings are
empty; any other method or action runs `methods[name]`, else fails `not_found`. `setValue(key, value, scope)` changes a
value; `calls` records what the window asked (watches aside).

| Member | |
|---|---|
| `render({ view, place, thread })` | draw a view: `text()`, `find(selector)`, `click(text)` (a button, link, tab, menu item, row or element by text or `aria-label`, else a selector; fails naming what's clickable) |
| `render({ pane: { kind, params } })`, `render({ slot, props })` | a pane kind or slot as the window draws it, for `thread`: an id, or a `ThreadInfo` (`testThread({ cwd, without })`: of the mounted profile, else the one under test; `profile: null` for none). Default: the selected thread, the machine's first, or a made-up one. One the thread wouldn't see throws |
| `render({ space: { kind, params } })`, `space()` | a space with its thread beside it; what the main area shows now |
| `render({ tool: { name, arguments, state, result }, thread })` | a tool call's row, from your `superego.tool` |
| `toolRow(name, { thread })`, `describeRun([...names], { thread })`, `mainKind` | a row's description; a run's folded line, and the tool it's shown as |
| `linkHandler(href, 'link' \| 'code', { thread })`, `urlKind({ thread })` | what claims a link there (no thread: outside any); the pane kind web pages open in |
| `placed(place, { thread })`, `press(keys)`, `dispatch`, `select`, `until` | |
| `setMachine(id, { state: 'disconnected' })`, `installProfile` | |
| `key(keys)`, `type(selector, text)` | with `window: true`: keys where the focus is; typing into a field |
| `unmount()` | lets a profile UI still loading land, then tears every extension down (signals abort). Unmount before closing the daemons |

<!-- check: ui; import { expect } from 'vitest'; import { testThread, type TestWindow } from 'superego/testing'; declare const window: TestWindow; declare const thread: ThreadInfo -->
```ts
const card = await window.render({ pane: { kind: 'board.card', params: { card: 'c1' } }, thread: thread.id })
const badge = await window.render({ slot: 'thread.badge', thread: testThread({ cwd: '/work/db' }) })
expect(badge.find('.thread-badge')?.title).toBe('database')
```

Worth a test each (see the kit's own, `packages/sdk/test/kit.test.ts` in Superego's source): teardown (`unmount`, an
edit and `reload`), set up twice (`installProfile` again), a helper edited, one profile on two machines (two daemons in
one window), a machine away or older (`setMachine`, `fakeMachine({ features: [], extensions: [{ name, version: '0.9.0' }] })`),
and a phone (`mountUi({ narrow: true })`).

## When it doesn't show

```sh
superego extensions                   # every extension here: its version and the API it needs, where it's from, how it stands
superego extensions --thread 12       # and what thread 12 goes without, and why
superego extension reload             # load the profile's changes now
```

It shows, for each extension:

- where it's from: the core, bundled, a profile and its file, or a window (no daemon half);
- its state: `set up`, `off`, or `failed`, `refused` or `timed out` with the error;
- what it registered (methods, actions and keys, values, views and their sources, hooks) and who watches its values;
- each profile's load (a project's not allowed says so);
- with `--thread`, why the thread goes without each it lacks: switched off, its profile's `without`, another
  extension's `agentFor`, or another profile's.

`--json` gives it as data (`extension.inspect`). A UI half that throws says so in its place; the window's console has
why.

## Real ones to read

The build queue is in [`examples/`](examples). The bundled extensions are in Superego's source, at
`extensions/<name>/src` (a checkout only).

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
| `mentions` | a `beforeSend` transform (with `mentionResolver`); `composer.complete` (with `superego.window`'s threads, `files.list` and `composer.mentionSources`) and `composer.sentWith`'s `words` |
| `files` | a `method`, a `pane` the agent is told of, an `overlay`, `store`s, `when` |
| `links` | UI only: the window declares it to the machine; a `Picker` over `transcriptLinks`, the links handlers drew |
| `unread` | UI only: a view in the rail `withoutSidebar` and in a phone's `drawer`, an action with keys reading projects, an app setting |
| `threads` | the required one, UI only: views (the list a `sidebar` with a `rail` button of its own, details in the `beside` with ⌘I, the model in the `header`), app settings, tool rows and a `link` |
| `thread-tools` | daemon only: the agent's thread tools, on `superego.threads` (`send` with `from`, `noteRead` for what a thread read, `idle` for thread_read's wait); it exports `readTool` and `listTool` for reuse (Ego) |
| `thread-reports` | daemon only: report-back through `turnEnd` and `blocked` hooks, for the runs the parent asked for (told by `beforeSend`'s `by` and `from`), not what the parent has read (`threads.parentRead`); `quiet` for a child whose parent hears it |
| `worktrees` | `thread` hooks (`starting` moves a thread, `archived` cleans up, `unarchiving` puts back), `state` and `facts`; a `header.chips` chip, a `thread.badge` mark and a `newThreadField` |
| `mcp-servers` | a key of its own in profiles (`profileKey('mcpServers', …)`); a settings section drawn by a component of its own (`settings(ui, …)`) from a live value (the section's `value`), with dialogs and `SignInFlow`; tool rows by prefix (`mcp__*`) with a call's own `verb` and images; a `header` view, a `details.section` slot and a `composer.above` notice, all from the thread's facts |
| `ego` | an agent of its own: a `hidden` thread, `agentFor` with `agent(part, { always: false })`, an `archiving` refusal, a `beforeSend` transform marking an outside agent's message and `threads.answering` to tell a call that answers one; the machines list through `machines.add`/`update`/`remove`; a view in the `rail`, and in a phone's `drawer` |
| `terminal` | bytes on a `channel` (the window's half with `channel` from `superego/unstable`), a `pane` in the pane menu, an action with keys, a `method` for its size, OSC 7501 status as a `scopedValue` and the thread's `status`, OSC 7577 resume records kept in `superego.dir`, `thread` hooks to end its shells |

Diagram sources are the `.mmd` files in [guide/](guide/); re-render with the `diagram` skill
(`bun <skill>/scripts/render.ts x.mmd x.svg`, and `--dark` for `x-dark.svg`).
