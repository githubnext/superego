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
the same name is refused.

## The API

| | |
|---|---|
| `superego.agent(extension)` | give this profile's agents an agent extension (`superego --skill tools`) |
| `superego.action(defineAction({ id, title, params?, expose?, run }))` | an action (an intent) named `<name>.<action>`, logged. `expose: ['ui']` (default) is for the window; add `'cli'` for the command line (Ego lists these, to explain them). `run(params, context)` returns JSON or throws `RpcError(code, message, { hint })` |
| `superego.method(name, run, { params? })` | a read named `<name>.<method>`: clients `call` it; params checked against the schema first. Not logged, not in the palette or the command line |
| `superego.value(key, initial)` | a live value named `<name>.<key>`: `get()`, `set(next)`, `update(fn)`. In memory only; a UI reads it with `useValue` (null until it's published) |
| `superego.pane(kind, about)` | tell the agent about a pane kind the UI draws, and its params: open_pane lists it |
| `superego.settings.register({ id, title, settings })` | a settings section of its own: id `<name>`, keys `<name>.<key>`. `settings.get(key)` reads any setting, `settings.onChange(fn)` hears changes |
| `superego.status((threadId) => …)` | return `{ kind: 'question' \| 'permission' \| 'auth', msg? }` while a thread needs the user; it shows as blocked. Call `superego.invalidate()` when what it depends on changes |
| `superego.threads.list()` | every thread: `{ id, title, cwd, status, profile, … }` |
| `superego.threads.get(id)` | one thread, archived too; `not_found` if there's none |
| `superego.threads.of(conversationId)` | the thread a tool call belongs to: `superego.threads.of(api.conversationId)` |
| `superego.threads.conversation(id)` | a thread's pi-durable conversation, to submit to or watch |
| `superego.threads.attachments(id)` | the folder on this machine where a thread keeps its files (attachments, images it showed); clients read a file there with `file.read` by its absolute path |
| `superego.app` | `{ name, id }` of the app |

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
