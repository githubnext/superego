# Daemon extensions

A daemon extension runs in the machine's daemon, next to the agents. Beyond tools, it can define **actions** (what the
UI, the command line and Ego run), publish **live values** (state clients watch), mark threads **blocked** (needing
the user), and reach **threads**. A profile lists it in `extensions` like an agent extension; Superego tells them apart
by the `setup` function.

```ts
import { defineDaemonExtension, defineAction, defineExtension, defineTool, obj, str, RpcError } from 'superego'

export default defineDaemonExtension({
  name: 'orders',                       // lowercase; prefixes its actions and values: orders.<something>
  setup(superego) {
    // Tools for the agent, with access to everything in this closure.
    superego.agent(defineExtension({ name: 'orders', tools: [/* defineTool(…) */] }))

    // An action: run from the UI (dispatch), the command line (superego do orders.find --number 12) or Ego.
    superego.action(defineAction({
      id: 'orders.find', title: 'Find an order', expose: ['ui', 'cli'],
      params: obj({ number: str() }),
      async run({ number }) {
        const order = await lookUp(number)
        if (!order) throw new RpcError('not_found', `No order ${number}`)
        return order                    // any JSON; the caller gets it
      },
    }))

    // A live value: clients watch orders.recent and get every change.
    const recent = superego.value<string[]>('orders.recent', [])
    recent.update((list) => ['1234', ...list].slice(0, 10))

    return () => { /* cleanup: runs when the profile reloads or the daemon stops */ }
  },
})
```

`setup` runs when the profile first loads (the first turn of a thread with it) and again after its files change, with
the previous setup's cleanup run first. Everything it registered is removed on reload, so register freely.

## The API

| | |
|---|---|
| `superego.agent(extension)` | give this profile's agents an agent extension (`superego --skill tools`) |
| `superego.action(defineAction({ id, title, params?, expose?, run }))` | an action named `<name>.<action>`. `expose: ['ui']` (default) is for the window; add `'cli'` for the command line and Ego. `run(params, context)` returns JSON or throws `RpcError(code, message, { hint })` |
| `superego.value(key, initial)` | a live value named `<name>.<key>`: `get()`, `set(next)`, `update(fn)`. In memory only; a UI reads it with `useValue` |
| `superego.status((threadId) => …)` | return `{ kind: 'question' \| 'permission' \| 'auth', msg? }` while a thread needs the user; it shows as blocked. Call `superego.invalidate()` when what it depends on changes |
| `superego.threads.list()` | every thread: `{ id, title, cwd, status, profile, … }` |
| `superego.threads.of(conversationId)` | the thread a tool call belongs to: `superego.threads.of(api.conversationId)` |
| `superego.threads.conversation(id)` | a thread's pi-durable conversation, to submit to or watch |
| `superego.app` | `{ name, id }` of the app |

## Common patterns

**A tool that needs the thread's folder:**

```ts
async execute(args, api) {
  const thread = (await superego.threads.list()).find((t) => t.id === superego.threads.of(api.conversationId))
  const root = thread?.cwd
}
```

(`api.env?.cwd` is the same folder, without a lookup.)

**Data for a pane:** the pane's UI dispatches an action with the thread's id; the action reads from disk or the
network and returns JSON. See `superego --skill ui`.

**Waiting on the user** (as `ask-user` does): a tool stores a resolver in a `Map`, publishes the pending question as a
live value, contributes `status` so the thread shows blocked, and an action (`<name>.answer`) resolves it. Mark the
tool `replay: 'safe'` so a restart asks again.

## Trying it

```sh
superego actions --all | grep orders     # registered? (after a thread with the profile took a turn)
superego do orders.find --number 1234    # run it as the UI would
superego actions log                     # recent runs, with errors
```
