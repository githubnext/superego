# Agent parts: tools and prompt sections

An agent part gives a profile's agents tools and prompt sections: `defineExtension`, `defineTool` and `section`
from `'superego'` (pi-durable's extensions underneath).

<!-- check: module; declare const findOrder: ReturnType<typeof defineTool> -->
```ts
import { defineExtension, defineTool, section } from 'superego'

export default defineExtension({
  name: 'orders',                      // lowercase, unique in the profile
  tools: [findOrder],
  sections: [section('orders_policy', () => 'Refunds over $100 need a human. Say so instead of promising one.')],
})
```

Name it in a profile's `extensions`, or pass it to `superego.agent(…)` in a daemon half's `setup` when it needs the
daemon's API ([daemon](daemon.md)).

## Tools

<!-- check: daemon; declare function lookUp(number: string): Promise<{ status: string }> -->
```ts
const findOrder = defineTool({
  name: 'find_order',                  // what the model calls; snake_case
  description: 'Find an order by its number. Returns its lines, status and shipping.',
  parameters: obj({
    number: str({ minLength: 1 }),
    include: opt(union([lit('lines'), lit('shipping')], { description: 'what to add' })),
  }),
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

**Parameters** are JSON Schema from these builders; arguments arrive validated and typed.

| Builder | Takes |
|---|---|
| `str(o?)` | `minLength`, `maxLength`, `pattern`, `format` |
| `num(o?)`, `int(o?)` | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| `bool(o?)`, `unknown(o?)` | |
| `lit(value, o?)` | exactly `value`: a string, number, boolean or null |
| `union([schemas], o?)` | any of them. Fixed choices: `union([lit('metric'), lit('imperial')])` |
| `arr(items, o?)` | `minItems`, `maxItems`, `uniqueItems` |
| `obj({ props }, o?)` | `open: true` allows other keys. A prop is required unless wrapped in `opt(schema)` |
| `nullable(schema, o?)` | the schema or `null` |

Every builder also takes `description`, `title`, `default`, `examples` and `deprecated`. None takes `enum`.

| | |
|---|---|
| `output` | content for the model: `{ type: 'text', text }`, or images |
| `details` | JSON for a tool row to draw ([ui](ui.md)) |
| throw an `Error` | the model gets an error result with its message |
| `api` | `callId`, `conversationId`, `env?.cwd` (the thread's folder), `output(text)` (live output), `await details(value, context)` (details while it runs), `now()`, `executeTool(name, args, context)` |
| `context.abortSignal` | fires when the user stops the agent; pass it to `fetch` and long waits. May be undefined |
| `replay: 'safe'` | the call may run again after a daemon restart cut it off (idempotent, or a wait). Without it, the model gets an `interrupted` error |
| `executionMode: 'sequential'` | don't run in parallel with other calls of the same round |

The model decides when to call a tool from `description` and the parameters' descriptions: write them for it, and say
plainly what the tool returns.

## Prompt sections

<!-- check: daemon; declare function readAgentsMd(cwd: string | undefined): Promise<string | undefined> -->
```ts
section('vault_agents_md', async ({ env }) => readAgentsMd(env?.cwd))   // rendered as <vault_agents_md>…</vault_agents_md>
section('preamble', () => 'You are terse.', { tag: false })              // without the tags
```

A section renders before each request; `undefined` leaves it out. Keep its text stable: one that changes every time
(the current time) defeats prompt caching. For fixed text, the profile's `prompt` is simpler.

## Replacing built-in tools

A tool named like a built-in (`read`, `bash`, …) replaces it in that profile's threads. To drop built-ins, use the
profile's `without` (`coding-tools`, `agent-ui`, `panes`, `thread-tools`, …).

`wrapTool`, `wrapSection` and `hook` are pi-durable's lower-level decorators, by name; prefer tools and sections. To
hear every tool call, see [Watching tool calls](daemon.md#watching-tool-calls).

## Testing a tool

```sh
id=$(superego start . -P <profile> -p "Use find_order for 1234") && superego read "$id" --wait
```

Tool calls and errors show in the transcript. Edits load on the thread's next turn (a project's profile needs allowing
again). For automated tests, see [the guide](guide.md#testing).
