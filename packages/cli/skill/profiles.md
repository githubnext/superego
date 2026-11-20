# Profiles

A profile is what an agent is: a folder with a `profile.ts`, and whatever files it names.

| Where | Whose | Runs |
|---|---|---|
| `~/.superego/profiles/<name>/` | yours, for every folder on this machine | always |
| `<source>/profiles/<name>/` | yours, from a profile source you installed (see below) | always |
| `<project>/.superego/profiles/<name>/` | the project's, for threads in it and below | once allowed |

A thread takes its profile when it starts and keeps it. Without `-P`, it gets the profile called `default`: the
project's if there is one, else yours, else none (plain Superego). A project's profile of a name replaces yours of
that name, unless it `extends` it.

```sh
superego profile new support           # scaffolds .superego/profiles/support/profile.ts here, and allows it
superego profile new --user            # ~/.superego/profiles/default
superego profile types                 # types for this project's profiles that were there already (--user: yours)
superego -P support -p "Order 1234?"   # a thread with it
```

## profile.ts

```ts
import { defineProfile } from 'superego'

export default defineProfile({
  description: 'Answers customer mail',              // shown where a profile is picked
  model: 'anthropic/claude-sonnet-4-5',              // provider/model; else the machine's default
  thinking: 'medium',
  // agent: 'claude-agent',                          // another kind of agent, for its threads' whole life (below)
  prompt: 'You answer customer email for Acme. Be brief.',
  extensions: ['./orders.ts'],                       // daemon side: see below
  ui: ['./ui/order.tsx'],                            // window side: defineUiExtension modules
  panes: {                                           // pane kinds its UI adds, listed to the agent for pane_open
    order: 'an order, with its lines and status. Params: { id }',
  },
  without: ['agent-ui'],                             // built-ins to leave out
  options: { worktrees: true },                      // what its threads ask extensions for, by name: a worktree each
  extends: 'user:default',                           // start from your profile of that name, and add to it
  mcpServers: [                                      // the mcp-servers extension's key: MCP servers its threads use
    'linear',                                        // the machine's, by name
    { docs: { command: 'node', args: ['./tools/docs-mcp.js'], auth: { type: 'env', names: ['DOCS_TOKEN'] } } },  // its own
  ],
})
```

Every field is optional, and no other is taken: a misspelt key, or one that's gone, fails the type check. A profile
that loads with one anyway (a key no extension here reads, a `without` naming no extension) is told so on its card
(the profile's name in the title bar) and in `profile.list`'s `problems`.

- **`prompt`** is the agent's instructions, after the prompt sections of its extensions. With `extends`, the two
  prompts are joined.
- **`extensions`** are paths from the profile's folder. A module's default export is either
  - an **agent part**, `defineExtension({ name, tools, sections })`: tools and prompt sections
    (`superego --skill tools`), or
  - a **daemon half**, `defineDaemonExtension({ name, setup(superego) { … } })`: actions the UI and command
    line run, live values, a thread's blocked status, and agent parts of its own (`superego --skill daemon`).
- **`ui`** are modules for the window (`superego --skill ui`). They draw only in this profile's threads.
- **`panes`** describes each pane kind the UI registers, so the agent knows it can open one and with which params.
- **`without`** takes the names of optional extensions, the ones Settings → Extensions lists (and `superego
  extensions`): the core's `coding-tools` (read, write, edit, bash), `panes` (pane_open) and `agents-md`, and bundled
  ones such as `thread-tools` (thread_start, thread_read, …: [thread-tools.md](thread-tools.md)), `agent-ui`, `terminal` or `mcp-servers`. Its threads get
  none of their tools or prompt sections, and the window shows none of their UI there. Required ones (the
  sidebar) can't be left out.
- **`options`** is what its threads ask extensions for, by name, as `thread.start`'s `options` (a thread's own win):
  `{ worktrees: true }` gives each a git worktree of its own, in a git repository. Not the threads they start: those
  take their own profile's ([thread-tools.md](thread-tools.md#what-a-child-gets)).
- **Extensions' keys.** Besides these, a profile takes keys a bundled extension registers (`superego.profileKey`,
  [daemon.md](daemon.md); `defineProfile`'s type lists them); that extension checks them as the profile loads (a problem fails it) and merges them over
  `extends`. The one bundled: **`mcpServers`**, the `mcp-servers` extension's, a list of the MCP servers its threads
  use: a string names one the machine has (Settings → MCP servers; a name it has none of is left out), and an object
  defines servers of the profile's own, by name, each a `command` (with `args`, `cwd`, plain `env`) or a `url` (with
  `headers`), and how it signs in (`auth`: `oauth`, `api-key`, or secret `env` names, their values entered in Settings,
  never in the file). Names are lower-case letters, digits and hyphens, up to 24. With `extends`, the two lists add
  up, a server of its own by name this profile's winning. The extension reads it each turn; a machine without it (or a
  profile `without` it) runs no servers. A command of the profile's runs in the project's root (its `cwd` defaults
  there), and only once the profile is allowed: its command line is part of `profile.ts`, so changing it means allowing
  the profile again. Their secrets (`auth.names`' values, an API key) are set in Settings → MCP servers → From
  profiles, or `superego mcp-servers set-secret`; OAuth signs in there too, or with `superego mcp-servers sign-in`. A
  server of its own named as one of the machine's replaces it in this profile's threads. The thread's header says
  which servers it has (`3 servers`), and why any it names were left out; `superego mcp-servers --thread <id>` too.

Profile files are TypeScript (the daemon strips the types as it loads them) or JavaScript. They may import each other
and Node's built-ins (`node:fs/promises`, …). `'superego'` is the only package they get (and `'superego/ui'` and
`'react'` in UI modules); there is no `npm install`.

## Types

`superego profile new` (and `extension new`) gives the profile what an editor needs to check it; `superego profile
types [name]` gives it to profiles that were there before (all of this project's, the one named, or yours with
`--user`), and again after a fresh clone:

- `tsconfig.json`: strict, JSX for React, Node's and the DOM's types. Nothing in it is about this computer, so a
  project commits it. One you've changed is left as it is.
- `node_modules`: a link to `~/.superego/types/node_modules`, declarations only, for `superego`, `superego/ui`,
  `superego/unstable`, `superego/testing`, React, Node and vitest. They're built from Superego's own sources with each
  build, and the app copies its own there whenever it starts, so an upgrade brings new ones; the link stays.
- `.gitignore`: `node_modules`, since the link is this computer's.

The daemon doesn't load from `node_modules`, and neither it nor the `.gitignore` counts toward a project profile's
allowance; the `tsconfig.json` does, so `profile types` allows again a profile that was allowed. `superego extension test`
checks types with the same tsconfig before it runs the tests.

## What 'superego' exports

```ts
import {
  defineProfile,                                     // profile.ts
  defineExtension, defineTool, section,              // agent parts
  wrapTool, wrapSection, hook,                       // decorating other extensions' tools and sections
  defineDaemonExtension, defineAction, RpcError, spawnGroup,   // daemon halves (`runs: 'machine'` is implied)
  obj, str, num, int, bool, arr, opt, lit, union, nullable, unknown,   // JSON Schema for parameters
} from 'superego'
```

## Profile sources

Your profiles can live in a repo or folder of their own, installed as a source the way Pi installs packages. A source
is a git repo, `git:<host>/<owner>/<repo>[@ref]` (an `https://` URL works too), cloned to
`~/.superego/sources/<host>/<owner>/<repo>`, or a folder, `~/…` or absolute (a path from here, from the command line),
read in place. Its profiles are its `profiles/<name>/profile.ts`.

```sh
superego profile install git:github.com/mikker/superego-profiles   # clone it; again, nothing changes
superego profile install ~/dev/superego-profiles                    # a checkout of it, read in place
superego profile install git:github.com/acme/profiles@v1.2          # pinned: a tag, branch or commit
superego profile sources                                            # each source, its state and its profiles
superego profile update [source]                                    # git pull --ff-only (pinned ones stay)
superego profile remove <source>                                    # drop it; a git one's clone is deleted
```

Their profiles are yours: they run without being allowed, like those in `~/.superego/profiles`, so **installing a
source is trusting its code**, and an agent can't install one for the user. `extends: 'user:<name>'`, `-P <name>
--user` and `profile types --user` find them by name like any of yours.

Yours are looked for in `~/.superego/profiles` first, then each source in the order installed: of two of one name,
the first is used, and the other is told of as shadowed (`superego profile`, `profile sources`, Settings → Profiles).
The list is `~/.superego/profile-sources.json` (`{ "sources": [...] }`); edited by hand, it's read again, and
`profile update` clones a git source it lists that isn't cloned yet. A source's edits (or a pull) apply as any of your
profiles' do: from each thread's next turn.

## Allowing

A project's profile runs code from that repository, so the daemon refuses it until it is allowed, and again whenever
any file in its folder changes (the folder is hashed; `node_modules` and dotfiles aside):

```sh
superego profile allow support     # in the project
```

`superego profile new` allows what it scaffolds; after you edit a project's profile yourself, allow it again. Your own
profiles in `~/.superego/profiles` are never asked about.

Allowing is the user's consent, never an agent's: run in a thread's shell, `profile allow` (and `allow-ui`) is refused,
and `profile new` and `extension new` leave a project's profile waiting. An agent that made or changed one tells the
user to allow it: in the window (where its thread asks, or Settings → Profiles), or in their own terminal.

A profile's UI from another machine is asked about on this computer too, since it runs in the window with reach to
every machine: once for exactly the sources the window received, again after any change. Allow it from the notice in
one of its threads, or:

```sh
superego profile allow-ui default -m box     # as it is now; a name, or the profile's folder there
superego profile revoke-ui default -m box    # Settings → Machines lists them too, with Revoke
```

## When changes apply

- **A thread keeps the profile it started with.** A profile made after a thread started (your first `default`, a
  project's new one) never reaches that thread, the one that wrote it included, so the user's open threads don't gain
  its tools: say so. Start a new thread to use it (`superego -p "…"`), or move an idle one onto it with `superego do
  thread.setProfile --thread <thread> --profile <name>` (refused while it's working).
- The daemon loads a profile when a thread with it takes a turn, and again when its files changed: edit, then send the
  thread another message (a thread mid-run keeps what it started the run with). `superego extension reload` loads it
  now, and says why if it doesn't load. Daemon halves are torn down (their cleanup runs) and set up again.
- The window loads a profile's UI as soon as it lists one of its threads (sidebar or navigator), and again when a
  shown thread of it moves on after a change ([ui.md](ui.md#when-the-ui-loads)).
- `model`, `thinking` and `options` apply where a thread hasn't chosen its own.
- `agent` picks another kind of agent for the threads that start with the profile, fixed for each thread's life: an
  extension's (`superego.agentKind`). `'claude-agent'` (experimental) runs the user's own Claude Code, signed in with its
  own `/login`; Superego's model, tools and prompt sections don't apply to those threads.

## An example

[`examples/build-queue-ui`](examples/build-queue-ui) is a complete one: a tool, a scoped value per thread, a Cancel
action, a view of its own beside the thread, and tests. Read it for a working pattern.

A minimal one with a tool:

```ts
// .superego/profiles/support/profile.ts
import { defineProfile } from 'superego'
export default defineProfile({ prompt: 'Answer customers. Look orders up before answering.', extensions: ['./orders.ts'] })
```

```ts
// .superego/profiles/support/orders.ts
import { defineExtension, defineTool, obj, str } from 'superego'

export default defineExtension({
  name: 'orders',
  tools: [defineTool({
    name: 'find_order',
    description: 'Find an order by its number.',
    parameters: obj({ number: str() }),
    async execute({ number }) {
      const order = await fetch(`https://acme.example/orders/${number}`).then((r) => r.json())
      return { output: [{ type: 'text', text: JSON.stringify(order) }] }
    },
  })],
})
```
