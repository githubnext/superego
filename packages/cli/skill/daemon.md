# Daemon extensions

New to this? Start with [docs/writing-extensions.md](https://github.com/mikker/superego/blob/main/docs/writing-extensions.md): the big picture, a first extension end to end, and a cheat sheet.

A daemon extension runs in the machine's daemon, next to the agents. Beyond tools, it can define **actions** (intents
the UI and the command line run, and Ego lists), **methods** (reads a pane or list calls), publish **live values** (state
clients watch), describe **pane kinds** to the agent, mark threads **blocked** (needing the user), and reach
**threads**. A profile lists it in `extensions` like an agent extension; Superego tells them apart by the `setup`
function.

```ts
import { defineDaemonExtension, defineAction, defineExtension, defineTool, obj, str, RpcError } from 'superego'

export default defineDaemonExtension({
  name: 'orders',                       // lowercase; prefixes its actions and values: orders.<something>
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

    // A pane kind its UI draws, told to the agent so open_pane can open it.
    superego.pane('order', 'an order, with its lines and status. Params: { id }')

    // A live value: clients watch orders.recent and get every change.
    const recent = superego.value<string[]>('orders.recent', [])
    recent.update((list) => ['1234', ...list].slice(0, 10))

    return () => { /* cleanup: runs when the profile reloads or the daemon stops */ }
  },
})
```

`setup` runs when the profile first loads (the first turn of a thread with it, a window showing one of its threads, or
the daemon starting while one of its threads was working) and again after its files change, with the previous setup's
cleanup run first. Everything it registered (tools, actions, methods, values, settings, pane kinds, status) is its own
and removed on reload, so register freely. Its name is the prefix of everything it registers; a second extension of
the same name is refused. Profiles load one at a time, so keep `setup` quick, and don't await anything that loads a
profile in it (starting a thread, reading one): that waits on the load in progress, which is waiting on `setup`. Start
such work without awaiting it, or do it in a tool, action or hook. A `setup` that takes over 15s is given up on: torn
down, and the profile fails to load, saying so.

Teardown aborts `superego.signal` first: tie timers, watchers and fetches of your own to it (`watch(path, { signal })`,
`fetch(url, { signal })`), or return a cleanup. A cleanup that throws is logged, and the rest still goes. After teardown,
registering throws, and a live value's `set` and `update` do nothing, so work that outlives it can't publish over the
next version. An edit to any local file an extension imports (a helper) reloads it with its new code; packages load
once.

## The API

| | |
|---|---|
| `superego.agent(extension)` | give this profile's agents an agent extension (`superego --skill tools`) |
| `superego.action(defineAction({ id, title, params?, expose?, run }))` | an action (an intent) named `<name>.<action>`, logged. `expose: ['ui']` (default) is for the window; add `'cli'` for the command line (Ego lists these, to explain them). `run(params, context)` returns JSON or throws `RpcError(code, message, { hint })`. `keys: 'mod+shift+b'` binds it in the window while one of this machine's threads is shown (`thread: true` fills in the thread's `id`) |
| `superego.dispatch(id, params)`, `superego.actions(exposure?)` | run any action on this machine, as this extension (`settings.set`, another extension's); list them (`'cli'`: what `superego do` runs) |
| `superego.method(name, run, { params? })` | a read named `<name>.<method>`: clients `call` it; params checked against the schema first. Not logged, not in the palette or the command line |
| `superego.value(key, initial)` | a live value named `<name>.<key>`: `get()`, `set(next)`, `update(fn)`. In memory only; a UI reads it with `useValue(machine, key)` (null until it's published) |
| `superego.scopedValue(key, initial)` | a live value kept per scope (a thread's id): `get(scope)`, `set(scope, next)`, `update(scope, fn)`, `delete(scope)`, `scopes()`. A UI watching one scope (`useValue(machine, key, { scope: thread.id })`) hears only its changes, never another thread's. For anything per thread |
| `superego.pane(kind, about)` | tell the agent about a pane kind the UI draws, and its params: open_pane lists it |
| `superego.view(id, { title, icon?, context, fits, default?, narrow?, order?, value \| method, about? })` | a view drawn from data, with no UI code: the window draws its content (`{ note, facts, items, table, markdown, actions, empty }`; an item `{ title, subtitle, detail, status, thread, actions }`; a button `{ title, action, params }` runs that action on this machine). Fed by a value of the extension's (a `thread` view's: by thread id) or a method of its (called with `{ id }` for a `thread` view). `fits`: `space`, `aside`, `pane`. `about`: tell the agent it can open it as a pane. A remote machine's or a project profile's runs no code in the window, so needs no allowing there; its buttons still have this machine's authority |
| `superego.settings.register({ id, title, settings })` | a settings section of its own: id `<name>`, keys `<name>.<key>`. `settings.get(key)` reads any setting, `settings.snapshot()` all of them with their sections, `settings.onChange(fn)` hears changes |
| `superego.submit(({ thread, text, attachments, content, by }) => …)` | change what each message sent to a thread gives its agent, before the turn starts (`by`: the extension that sent it, absent for the user's, from a window or the command line): `content` is its blocks so far (`{ type: 'text', text }`, `{ type: 'image', data, mimeType }`), the text first; return the blocks to send instead, or nothing. Transforms run in order, each given the last one's; not for threads that go without the extension, a profile's only for its own threads. A throw fails the send |
| `superego.status((threadId) => …)` | return `{ kind: 'question' \| 'permission' \| 'auth', msg? }` while a thread needs the user; it shows as blocked. Call `superego.invalidate()` when what it depends on changes |
| `superego.threads.list({ archived?, hidden? })` | every thread: `{ id, title, cwd, status, profile, ext, … }`; `archived` or `hidden` lists those instead |
| `superego.threads.get(id)` | one thread, archived too; `not_found` if there's none |
| `superego.threads.of(conversationId)` | the thread a tool call belongs to: `superego.threads.of(api.conversationId)` |
| `superego.threads.conversation(id)` | a thread's pi-durable conversation, to submit to or watch |
| `superego.threads.attachments(id)` | the folder on this machine where a thread keeps its files (attachments, images it showed); clients read a file there with `file.read` by its absolute path |
| `superego.threads.create({ cwd?, title?, prompt?, profile?, parent?, hidden?, options? })` | start a thread, as `thread.create` does (its hooks too): `parent` makes it a child; `hidden` keeps it out of every list (an agent of the extension's own: Ego's; it has no profile; find it again by its `owner` in `threads.list({ hidden: true })`, and it takes no messages while the extension is off); `options` are for extensions' `creating` hooks, by name |
| `superego.threads.submit(id, text, { whenBusy? })`, `lastAnswer(id)`, `entries(id, limit?)` | send a thread a message (after its run, if it's working), read its last answer as text, and its newest transcript entries since it was last cleared (newest first: the tool call it's in, say; pi-durable's entry records, whose shape isn't stable) |
| `superego.threads.archive(id, { whenIdle? })`, `unarchive(id)` | put a thread away and back; `archive` resolves to `{ notes }`, what each extension's hooks said they did, by name (none for `whenIdle`, which waits for its run to end: a thread archiving itself, across restarts too; its notes are then said in the thread, as Superego's own note) |
| `superego.threads.clear(id)` | start a thread over: its run stopped, a new context, its transcript starting after this (windows showing it watch again), its panes closed |
| `superego.thread({ creating, created, turnStart, turnEnd, blocked, archiving, archived, unarchiving, unarchived })` | take part in a thread's life. `blocked`: it came to need the user mid-run (a question), once each time. `creating(draft)` may return `{ cwd, state }` (work elsewhere: a worktree); `draft.options` is what its profile's `options` and `thread.create` asked of extensions, by name. `creating`, `archiving` and `unarchiving` refuse by throwing; the rest are told, a throw only logged. `abandoned(draft, state)`: a later `creating` refused after this one ran, so undo it; `unarchiveAbandoned(thread)`, the same for `unarchiving`. `archived` runs before clients see it archived: clean up there, idempotently (archiving goes on past a failed cleanup, and may be tried again); `archiving` and `archived` may return `{ note }`, what they did in a line (`threads.archive` and `thread.archive` answer `{ notes }`, by extension). In set-up order; not for threads that go without the extension, a profile's only for its own |
| `superego.state<T>()` | its own state with each thread, kept in the thread (across restarts): `get(id)`, `set(id, next \| undefined)`, `update(id, edit)` |
| `superego.facts(({ id, state }) => …)` | what clients see of each thread as `thread.ext.<name>`, worked out from its state; nothing for undefined |
| `superego.agentFor(({ id, state, profile }) => …)` | choose a thread's agent: `{ instructions?, model?, thinking?, extensions?, without? }`, or nothing. The first answer wins; quick, no side effects. Parts it names are given with `superego.agent(part, { always: false })`, which gives them to no other thread |
| `superego.app` | `{ name, id }` of the app |
| `superego.dataDir` | this machine's data folder (`~/.superego`): worktrees keeps its own in `worktrees/` |
| `superego.signal` | an `AbortSignal`, aborted when the extension is torn down (its profile reloaded or gone, the daemon stopping) |
| `superego.agentsDir` | the folder agents share on this machine (`~/.agents`, or `SUPEREGO_AGENTS`): `skills/`, `AGENTS.md` |

## Common patterns

**A tool that needs the thread's folder:**

```ts
async execute(args, api) {
  const { cwd } = await superego.threads.get(superego.threads.of(api.conversationId)!)
}
```

(`api.env?.cwd` is the same folder, without a lookup.)

**Data for a pane:** the pane's UI calls a method with the thread's id; the method reads from disk or the network and
returns JSON. Keep actions for what changes something. See `superego --skill ui`.

**Waiting on the user** (as `ask-user` does): a tool stores a resolver in a `Map`, publishes the pending question as a
live value, contributes `status` so the thread shows blocked, and an action (`<name>.answer`) resolves it. Mark the
tool `replay: 'safe'` so a restart asks again.

## Trying it

```sh
superego actions --all | grep orders     # registered? (after a thread with the profile took a turn)
superego do orders.refund --number 1234  # run an action as the UI would
superego actions log                     # recent runs, with errors
```
