# Agent extensions: tools and prompt sections

An agent extension gives a profile's agents tools and pieces of system prompt. Superego's agents run on pi-durable,
and these are its extensions: `defineExtension`, `defineTool` and `section`, imported from `'superego'`.

```ts
import { defineExtension, defineTool, section, obj, str, opt, num } from 'superego'

export default defineExtension({
  name: 'orders',                      // lowercase, unique in the profile
  tools: [findOrder],
  sections: [section('orders_policy', () => 'Refunds over $100 need a human. Say so instead of promising one.')],
})
```

Name it in a profile's `extensions` (a module's default export), or hand it to `superego.agent(…)` from a daemon
extension's `setup` when it needs the daemon's API too (`superego --skill daemon`).

## Tools

```ts
const findOrder = defineTool({
  name: 'find_order',                  // what the model calls; snake_case
  label: 'Find order',                 // optional, for people
  description: 'Find an order by its number. Returns its lines, status and shipping.',
  parameters: obj({ number: str({ minLength: 1 }), include: opt(str({ description: 'lines | shipping' })) }),
  async execute({ number }, api, context) {
    api.output(`looking up ${number}…\n`)        // streams to the transcript while it runs
    const order = await lookUp(number)
    return {
      output: [{ type: 'text', text: JSON.stringify(order) }],   // what the model sees
      details: { number, status: order.status },                 // JSON for a UI to draw the call with
    }
  },
})
```

- **`parameters`** is JSON Schema built with `obj`, `str`, `num`, `int`, `bool`, `arr`, `opt` (optional), `lit`,
  `union`, `nullable`, `unknown`. Each takes options like `{ description, minLength, enum }`. Arguments arrive
  validated and typed.
- **The result**: `output` is a list of content (`{ type: 'text', text }`, or images) for the model. `details` is
  JSON for UIs (a tool renderer reads it; `superego --skill ui`). Throw an `Error` to give the model an error result
  with its message.
- **`api`**: `api.callId` (this call's id), `api.conversationId`, `api.env?.cwd` (the thread's folder),
  `api.output(text)` (live output), `await api.details(value, context)` (details while it runs, for a UI to show
  progress), `api.now()`, `api.executeTool(name, args, context)` (call another tool).
- **`context.abortSignal`** fires when the user stops the agent: pass it to `fetch` and long waits.
- **`replay: 'safe'`** says the call may run again after a daemon restart cut it off (it's idempotent, or waits for
  something). Without it, an interrupted call gives the model an `interrupted` error instead.
- **`executionMode: 'sequential'`** keeps it from running in parallel with other calls of the same round.

Tools should do one thing and say plainly what they return. The model reads `description` and the parameters'
descriptions to decide when to call it: write them for the model.

## Prompt sections

```ts
section('vault_agents_md', async ({ env }) => readAgentsMd(env?.cwd))   // rendered as <vault_agents_md>…</vault_agents_md>
section('preamble', () => 'You are terse.', { tag: false })              // without the tags
```

A section renders before each request; returning `undefined` leaves it out. Sections are cached by what they return,
so one that changes every time (the current time) defeats prompt caching: keep them stable.

A profile's `prompt` is simpler for fixed text. Use a section for text computed from the thread's folder or other
state.

## Replacing built-in tools

A profile's tool with the name of a built-in one (`read`, `bash`, …) replaces it in that profile's threads. To leave
built-ins out entirely, use the profile's `without` (`coding-tools`, `ask-user`, `panes`, `thread-tools`, …).

`wrapTool`, `wrapSection` and `hook` are pi-durable's lower-level decorators (wrapping a tool by name, hooking tool
calls and generations); prefer tools and sections, and read pi-durable's README before reaching for them.

## Testing a tool

Start a thread with the profile and ask for it: `superego -P <profile> -p "Use find_order for 1234"`. Tool calls and
errors show in the transcript. Edits load on the thread's next turn (a project's profile needs allowing again).
