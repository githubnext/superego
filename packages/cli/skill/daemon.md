# The daemon half

New to this? Start with [the guide](guide.md) (`superego --skill guide`): the big picture, a first extension end to end, and testing; and [the cheat sheet](cheatsheet.md) of both halves.

An extension's daemon half runs in the machine's daemon, next to the agents. Beyond tools, it can define **actions** (intents
the UI and the command line run, and Ego lists), **methods** (reads a pane or list calls), publish **live values** (state
clients watch), describe **pane kinds** to the agent, mark threads **blocked** (needing the user), and reach
**threads**. A profile lists it in `extensions` like an agent part; Superego tells them apart by the `setup`
function.

<!-- check: module; declare function lookUp(number: string): Promise<{ status: string } | undefined>; declare function refund(number: string): Promise<void> -->
```ts
import { defineDaemonExtension, defineAction, defineExtension, defineTool, obj, str, RpcError } from 'superego'

export default defineDaemonExtension({
  name: 'orders',                       // lowercase; prefixes its actions and values: orders.<something>
  // The pane kinds its UI draws, told to the agent so pane_open can open them.
  panes: { order: 'an order, with its lines and status. Params: { id }' },
  setup(superego) {
    // Tools for the agent, with access to everything in this closure.
    superego.agent(defineExtension({ name: 'orders', tools: [/* defineTool(…) */] }))

    // A read: a pane calls it (call(machine.id, 'orders.find', { number })). Not logged, not an action.
    superego.method('orders.find', async ({ number }) => {
      const order = await lookUp(number)
      if (!order) throw new RpcError('not_found', `No order ${number}`)
      return order                      // any JSON; the caller gets it
    }, { params: obj({ number: str() }) })

    // An action: an intent, run from the UI (dispatch) or the command line (superego do orders.refund --number 12).
    superego.action(defineAction({
      id: 'orders.refund', title: 'Refund an order', expose: ['ui', 'cli'],
      params: obj({ number: str() }),
      async run({ number }) { await refund(number); return null },
    }))

    // A live value: clients watch orders.recent and get every change.
    const recent = superego.value<string[]>('orders.recent', [])
    recent.update((list) => ['1234', ...list].slice(0, 10))

    return () => { /* cleanup: runs when the profile reloads or the daemon stops */ }
  },
})
```

`setup` runs when the profile first loads (the first turn of a thread with it, a window listing one of its threads
([ui.md](ui.md#when-the-ui-loads)), or the daemon starting while one of its threads was working) and again after its files change, with the previous setup's
cleanup run first. Everything it registered (tools, actions, methods, values, settings, status) is its own, as are the pane kinds it describes,
and removed on reload, so register freely. Its name is the prefix of everything it registers; a second extension of
the same name is refused. Profiles load one at a time, so keep `setup` quick, and don't await anything that loads a
profile in it (starting a thread, reading one): that waits on the load in progress, which is waiting on `setup`. Start
such work without awaiting it, or do it in a tool, action or hook. A `setup` that takes over 15s is given up on: torn
down, and the profile fails to load, saying so.

Teardown aborts `superego.signal` first: tie timers, watchers and fetches of your own to it (`watch(path, { signal })`,
`fetch(url, { signal })`), or return a cleanup. Run commands with `spawnGroup(command, args, { cwd, signal })` (from
'superego'), not `spawn`: it runs them as a process group, `stop()` (or the signal) ends all of it, SIGTERM then SIGKILL
after `grace`, and `exited` resolves once none of it is left. Stopping a shell alone leaves what it started running. A cleanup that throws is logged, and the rest still goes.
A cleanup may return a promise: the daemon waits for it (15s at most) before it closes. Return one for work of your own
still finishing (a write landing, a process exiting), and start nothing new once the signal has aborted, so nothing
touches the data folder after the daemon has closed. After teardown,
registering throws, and a live value's `set` and `update` do nothing, so work that outlives it can't publish over the
next version. An edit to any local file an extension imports (a helper) reloads it with its new code; packages load
once.

## The API

| | |
|---|---|
| `superego.agent(extension, { always? })` | give this profile's agents an agent part (`superego --skill tools`). Answers a handle: `replace(next)` puts another of the same name in its place (threads that have it get it from their next request, mid-run too: tools that change), `remove()` takes it away; called, it removes it, so `setup: (s) => s.agent(part)` returns its cleanup. `always: false`: to no thread but those `agentFor` or `agentParts` gives it to. |
| `superego.action(defineAction({ id, title, params?, expose?, run }))` | an action (an intent) named `<name>.<action>`, logged. `expose: ['ui']` (default) is for the window; add `'cli'` for the command line (Ego lists these, to explain them). Add `'outside'` for outside agents, as a tool of `superego mcp`: only for what's safe to hand any MCP client. `run(params, context)` returns JSON or throws `RpcError(code, message, { hint })`. `keys: 'mod+shift+b'` binds it in the window while one of this machine's threads is shown (`thread: true` fills in its `thread`) |
| `superego.dispatch(id, params)`, `superego.actions(exposure?)` | run any action on this machine, as this extension (`settings.set`, another extension's); list them (`'cli'`: what `superego do` runs) |
| `superego.call(id, params)` | read another extension's method on this machine (`skills.list`); rejects when none has it |
| `superego.method(name, run, { params? })` | a read named `<name>.<method>`: clients `call` it; params checked against the schema first. Not logged, not in the palette or the command line |
| `superego.value(key, initial)` | a live value named `<name>.<key>`: `get()`, `set(next)`, `update(fn)`. In memory only; a UI reads it with `useValue(machine, key)` (null until it's published) |
| `superego.scopedValue(key, initial)` | a live value kept per scope (a thread's id): `get(scope)`, `set(scope, next)`, `update(scope, fn)`, `delete(scope)`, `scopes()`. A UI watching one scope (`useValue(machine, key, { scope: thread.id })`) hears only its changes, never another thread's. For anything per thread |
| `superego.view(id, { title, icon?, context, fits, default?, narrow?, order?, value \| method, about? })` | a view drawn from data, with no UI code: the window draws its blocks (`Block[]`, as agents draw: `list`, `table`, `markdown`, inputs, …; `[]` or null: nothing yet). A button `{ id, label, action, params }` runs that action of this extension's on this machine, with the inputs' values in its params by id. A view whose blocks fail the check (`blockErrors`) shows its first error instead. Fed by a value of the extension's (a `thread` view's: by thread id) or a method of its (called with `{ thread }` for a `thread` view). `fits`: `space`, `beside`, `pane`. `about`: tell the agent it can open it as a pane. A remote machine's or a project profile's runs no code in the window, so needs no allowing there; its buttons still have this machine's authority |
| `superego.settings.register({ id, title, settings, ui?, data? \| value? })` | a settings section of its own: id `<name>`, keys `<name>.<key>`. `ui` names a component the UI half registers for it, given the section; its `data` is read with each snapshot, or, with `value: '<name>.<key>'`, it's one of the extension's live values, which the window gives the component as `section.data`, kept current, instead of sending it again with every snapshot. `settings.get(key)` reads any setting, `settings.snapshot()` all of them with their sections (a `value` section's value as its `data`), `settings.onChange(fn)` hears changes |
| `superego.agentKind({ name, runner, menu?, profile? })` | a kind of agent (API ^5.3): threads whose profile says `agent: '<name>'` (the extension's name, or `<name>.<kind>`) have every turn run by `runner`, a pi-durable task, instead of a model. It reads the thread's conversation (`runtime.context`), appends the turn's entries (`AssistantEntry`, `ToolResultEntry`), may publish its answer as it streams (`pi.live.generation.message`, a deferred commit), and completes with `{ entryId }` of its answer, or fails with why. The run is the daemon's: working, done or failed, Stop (its `abort` handler, after `runtime.signal`), messages sent meanwhile. A thread keeps its kind for its whole life (`thread.setProfile` moves one only while it has no conversation). API ^5.6: `menu()` gives its group in the model menus (`{ title, description?, models: [{ value, label, thinking }], unavailable? }`, or nothing while it isn't offered; may be async, up to 3s), its models `<name>/<model>`; `profile: { name, make() }` is the profile a thread started on one of them runs with (made first if need be). The thread's own model and thinking reach `agentParts` (`model`, `thinking`). Claude Agent's (`extensions/claude-agent`) is one. |
| `superego.profileKey(key, { check?, merge?, brings?, title? })` | a key of the extension's own in profiles (`mcpServers` is mcp-servers'): a camelCase word, not one of the core's. As a profile loads, `check(value)` says why its value won't do, if it won't (the profile then fails to load); with `extends`, `merge(base, own)` puts the two together (unset, a profile's own replaces the other's); `brings(value)` names what it brings, shown with the profile (`profile.list`'s `brings`, by `title`). Read it from the thread's profile: `agentParts`' `profile.spec[key]`, a `starting` hook's `draft.profile.spec[key]`. A bundled extension's only |
| `superego.beforeSend(({ thread, text, attachments, content, by, exposure, from }) => …)` | change what each message sent to a thread gives its agent, before the turn starts (`by`: the extension that sent it, absent for the user's, from a window or the command line; `exposure`: `outside` when an outside agent sent it, `cli` the command line, else what `threads.send` passed on; `from`: the thread it's from, as `threads.send` said, or the parent for the prompt a child starts with): `content` is its blocks so far (`{ type: 'text', text }`, `{ type: 'image', data, mimeType }`), the text first; return the blocks to send instead, or nothing. Transforms run in order, each given the last one's; not for threads that go without the extension, a profile's only for its own threads. A throw fails the send |
| `superego.status((threadId) => …)` | return `{ kind: 'question' \| 'permission' \| 'auth', msg? }` while a thread needs the user; it shows as blocked. Or `{ working: 'Waiting: …' }` (API ^5.6): while it works, what its run waits on that isn't the user, said in its status. Call `superego.invalidate()` when what it depends on changes |
| `superego.threads.list({ archived?, hidden? })` | every thread: `{ id, title, cwd, status, profile, facts, … }`; `archived` or `hidden` lists those instead |
| `superego.threads.get(id)` | one thread, archived too; `not_found` if there's none |
| `superego.threads.of(conversationId)` | the thread a tool call belongs to: `superego.threads.of(api.conversationId)` |
| `superego.threads.conversation(id)` | a thread's pi-durable conversation, to submit to or watch |
| `superego.threads.attachments(id)` | the folder on this machine where a thread keeps its files (attachments, images it showed); clients read a file there with `file.read` by its absolute path (an image with `image.read`, as a thumbnail or whole) |
| `superego.threads.start({ cwd?, title?, prompt?, profile?, parent?, hidden?, options? })` | start a thread, as `thread.start` does (its hooks too): `parent` makes it a child; `hidden` keeps it out of every list (an agent of the extension's own: Ego's; it has no profile; find it again by its `owner` in `threads.list({ hidden: true })`, and it takes no messages while the extension is off); `options` are for extensions' `starting` hooks, by name |
| `superego.threads.send(id, text, { whenBusy?, exposure?, from? })`, `lastAnswer(id)`, `entries(id, limit?)` | send a thread a message (after its run, if it's working; `exposure`: whom for, from an action's context; `from`: the thread it's from, when one thread writes another; both kept with the message, and seen by transforms), read its last answer as text, and its newest transcript entries since it was last cleared (newest first: the tool call it's in, say; pi-durable's entry records, whose shape isn't stable) |
| `superego.threads.answering(conversationId, callId)` | how the message a tool call answers came, from a tool's `execute(args, api)`: `answering(api.conversationId, api.callId)` is `{ by?, from?, exposure? }` (`{}` for a window's user's; `exposure: 'outside'` an outside agent's), the user message before the model's message that made the call, not the newest; undefined when the call isn't found. To act for the user alone, require no `by`, no `from` and `exposure` not `outside`: a message another thread or extension sent may carry an outside agent's words |
| `superego.threads.idle(id, { signal? })` | wait until a thread isn't working (its run ended, or it needs the user), whatever extensions it goes without: its info then (at once, if it isn't working now; as it is, once `signal` aborts) |
| `superego.threads.noteRead(reader, read)`, `parentRead(thread)` | what parents have read of their children: `noteRead` says thread `reader` read a thread as `read` (its `ThreadInfo`, as read) says it stood (kept, in memory, only for its parent, and only if it wasn't working); `parentRead(thread)` whether its parent has read it as it stood at `thread.activeAt`, or later (a report of it can go unsaid) |
| `superego.threads.archive(id, { whenIdle? })`, `unarchive(id)` | put a thread away and back; `archive` resolves to `{ notes }`, what each extension's hooks said they did, by name (none for `whenIdle`, which waits for its run to end: a thread archiving itself, across restarts too; its notes are then said in the thread, as Superego's own note) |
| `superego.threads.clear(id)` | start a thread over: its run stopped, a new context, its transcript starting after this (windows showing it watch again), its panes closed |
| `superego.machines.list()`, `superego.machines.call(machine, method, params)` | the other machines this daemon reaches (its `machines.json`, with their links' states) and a call to one, as a client calls it (`thread.list`, `thread.start`, …); none when it reaches no others. |
| `superego.machines.add({ label?, target?, command?, via? })`, `update(id, { label?, enabled?, target?, command? })`, `remove(id)` | change that list (`machines.json`, which the app and `superego machines` keep too): add one by ssh `target` (`command`: what runs there) or `via` a command piping stdio to it; rename, switch off or on, or take one away. `add` and `update` answer its entry. Refused where the daemon reaches no other machines |
| `superego.thread({ starting, started, turnStart, turnEnd, stopped, blocked, archiving, archived, unarchiving, unarchived })` | take part in a thread's life. `blocked`: it came to need the user mid-run (a question), once each time. `stopped(thread, { withdrawn })`: a stop withdrew messages others had queued for it (each one's `MessageOrigin`: `by`, `from`), told in turn with the others (the `turnEnd` of the run it stopped may come before or after it). `starting(draft)` may return `{ cwd, state }` (work elsewhere: a worktree); `draft.options` is what its profile's `options` and `thread.start` asked of extensions, by name. `starting`, `archiving` and `unarchiving` refuse by throwing; the rest are told, a throw only logged. `abandoned(draft, state)`: a later `starting` refused after this one ran, so undo it; `unarchiveAbandoned(thread)`, the same for `unarchiving`. `archived` runs before clients see it archived: clean up there, idempotently (archiving goes on past a failed cleanup, and may be tried again); `archiving` and `archived` may return `{ note }`, what they did in a line (`threads.archive` and `thread.archive` answer `{ notes }`, by extension). In set-up order; not for threads that go without the extension, a profile's only for its own |
| `superego.state<T>({ publish? })` | its own state with each thread, kept in the thread (across restarts): `get(id)`, `set(id, next \| undefined)`, `update(id, edit)`. `publish: { key: '<name>.<key>', empty }`: also a scoped live value, each thread's state in its scope, for the UI to watch (`useValue(machine, key, { scope: thread.id })`): read from the thread when a scope is first watched, told every change made through the state, and let go of once nobody watches it. A scope reads null only until it's read (or while nothing publishes it: the extension off there, which `has(machine, 'ext:<name>')` tells), then `empty` for a thread with no state (or no such thread), else the state; a failed read is logged and stays null. For UI kept with a thread across restarts, without a method to read it back |
| `superego.facts(({ id, state }) => …)` | what clients see of each thread as `thread.facts.<name>`, worked out from its state; nothing for undefined |
| `superego.quiet(({ id, state }) => boolean)` | say a thread is quiet (`thread.quiet`): how its runs end isn't the user's to look at, someone else hears it (thread-reports' child working for its parent). Its finishing or failing isn't unread nor notified; its needing the user still is. Worked out whenever its info is, as facts are (`invalidate()` when what it reads changes) |
| `superego.recap(({ thread, answer, calls }) => …)` | say in a line what a run did, once it ends (`calls`: its tool calls, oldest first, each `{ name, arguments, failed }`): the thread's `done` status carries it, and its notification says it. The first to answer wins; with none, the answer's first sentence. Quick, no side effects. |
| `superego.toolCalls(({ thread, call, result }) => …)` | hear each tool call a thread's agent makes, once it ends: `call` is `{ id, name, args }`, `result` `{ isError, text? }` (`text`: what the model was told). Read-only: the run doesn't wait for it, and a throw is only logged. Not for threads that go without the extension, a profile's only for its own. See [Watching tool calls](#watching-tool-calls). |
| `superego.agentFor(({ id, state, profile }) => …)` | choose a thread's agent: `{ instructions?, model?, thinking?, extensions?, without?, setup? }`, or nothing (`setup`: an agent that sets the machine up, as Ego's; other extensions' `agentParts` see it, and may add their setup tools). The first answer wins; quick, no side effects. Parts it names are given with `superego.agent(part, { always: false })`, which gives them to no other thread |
| `superego.agentParts(({ id, hidden, owner, profile, setup }) => …)` | add parts to whatever agent a thread has (`setup`: its agent sets the machine up): asked at every send, every extension's adding up (after `agentFor`'s parts, before the profile's). `profile` is `{ ref, spec }` as loaded now, so a profile's edit counts from the next turn. Answers parts it gave with `agent(part, { always: false })`, or nothing; may be async, up to 5s (a throw, or later, adds nothing that turn). |
| `superego.extensions()` | the app's extensions on this machine (the core's, bundled and windows', not profiles'): `{ name, title?, description?, version?, optional, on, secrets? }`, as Settings → Extensions has them now. `secrets` are the files an extension says hold keys in the data folder (`about.secrets`: never read by an agent that reads the data folder, as Ego) |
| `superego.auth.flow(context, async (flow) => …)` | run a sign-in flow of its own from an action (`context`: the action's, so the client that asked hears it as `auth.event`, answers with `auth.respond`, stops it with `auth.cancel`). Answers `{ flow }`, for the action to return. `flow.emit(event)` (`auth_url` with an optional loopback `callback`, `device_code`, `info`, `progress`), `await flow.prompt({ type, message })` (`text`, `secret`, `select`, `manual_code`), `flow.signal` (cancelled, or the extension torn down). Ends `done` when it resolves, `failed` with the error when it throws. The window draws it with `SignInFlow` (`superego --skill ui`). |
| `superego.app` | `{ name, id }` of the app |
| `superego.dataDir` | this machine's data folder (`~/.superego`): worktrees keeps its own in `worktrees/` |
| `superego.signal` | an `AbortSignal`, aborted when the extension is torn down (its profile reloaded or gone, the daemon stopping) |
| `superego.agentsDir` | the folder agents share on this machine (`~/.agents`, or `SUPEREGO_AGENTS`): `skills/`, `AGENTS.md` |

## Common patterns

**A tool that needs the thread's folder:**

<!-- check: daemon -->
```ts
const where = defineTool({
  name: 'where', description: "Say the thread's folder.", parameters: obj({}),
  async execute(args, api) {
    const { cwd } = await superego.threads.get(superego.threads.of(api.conversationId)!)
    return { output: [{ type: 'text', text: cwd }] }
  },
})
```

(`api.env?.cwd` is the same folder, without a lookup.)

**Data for a pane:** the pane's UI calls a method with the thread's id; the method reads from disk or the network and
returns JSON. Keep actions for what changes something. See `superego --skill ui`.

**Waiting on the user** (as `agent-ui` does): a tool stores a resolver in a `Map`, publishes the pending question as a
live value, contributes `status` so the thread shows blocked, and an action (`<name>.answer`) resolves it. Mark the
tool `replay: 'safe'` so a restart asks again.

## Watching tool calls

`superego.toolCalls(fn)` calls `fn({ thread, call: { id, name, args }, result: { isError, text? } })` after each tool
call a thread's agent makes, errors too. It only watches: the run doesn't wait for it, and it can't change the result.
A throw is logged. This one marks threads that ran `sqlite3`, for the [sidebar mark in ui.md](ui.md#a-mark-in-the-sidebar):

```ts
// db.ts; in profile.ts: extensions: ['./db.ts']
import { defineDaemonExtension } from 'superego'

export default defineDaemonExtension({
  name: 'db',
  setup(superego) {
    const touched = superego.state<{ why: string }>()
    superego.facts(({ state }) => state)              // clients see it as thread.facts.db
    superego.toolCalls(async ({ thread, call }) => {
      const command = String((call.args as { command?: unknown }).command ?? '')
      if (call.name === 'bash' && /\bsqlite3\b/.test(command)) await touched.set(thread, { why: command.slice(0, 80) })
    })
  },
})
```

## Trying it

```sh
superego actions --all | grep orders     # registered? (after a thread with the profile took a turn)
superego do orders.refund --number 1234  # run an action as the UI would
superego actions log                     # recent runs, with errors
```
