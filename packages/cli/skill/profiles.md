# Profiles

A profile is what an agent is: a folder with a `profile.ts`, and the files it names.

| Where | Whose | Runs |
|---|---|---|
| `~/.superego/profiles/<name>/` | yours, for every folder on this machine | always |
| `<source>/profiles/<name>/` | yours, from an installed [profile source](#profile-sources) | always |
| `<project>/.superego/profiles/<name>/` | the project's, for threads in it and below (up to its repository's top) | once [allowed](#allowing) |

A thread takes its profile when it starts and keeps it. Without `-P`, it gets `default`: the project's, else yours,
else none. A project's profile replaces yours of the same name, unless it `extends` it.

```sh
superego profile new support           # .superego/profiles/support/profile.ts here, allowed
superego profile new --user            # ~/.superego/profiles/default
superego profile types                 # types for this project's existing profiles (--user: yours)
superego -P support -p "Order 1234?"   # a thread with it
```

## profile.ts

```ts
import { defineProfile } from 'superego'

export default defineProfile({
  description: 'Answers customer mail',              // shown where a profile is picked
  model: 'anthropic/claude-sonnet-4-5',              // provider/model; else the machine's default
  thinking: 'medium',
  // agent: 'claude-agent',                          // another kind of agent, for its threads' whole life
  prompt: 'You answer customer email for Acme. Be brief.',
  extensions: ['./orders.ts'],                       // daemon side
  ui: ['./ui/order.tsx'],                            // window side: defineUiExtension modules
  panes: {                                           // pane kinds its UI adds, told to the agent for pane_open
    order: 'an order, with its lines and status. Params: { id }',
  },
  without: ['agent-ui'],                             // optional extensions to leave out
  options: { worktrees: true },                      // what its threads ask extensions for, by name
  extends: 'user:default',                           // start from your profile of that name, and add to it
  // global: true,                                   // yours only: part of the app, not only of its threads
  mcpServers: [                                      // the mcp-servers extension's key
    'linear',                                        // the machine's, by name
    { docs: { command: 'node', args: ['./tools/docs-mcp.js'], auth: { type: 'env', names: ['DOCS_TOKEN'] } } },  // its own
  ],
})
```

Every field is optional and no other is taken: a misspelt key fails the type check. One that loads anyway (a key no
extension reads, a `without` naming no extension) is reported on the profile's card (its name in the title bar) and in
`profile.list`'s `problems`.

| Field | |
|---|---|
| `prompt` | the agent's instructions, after its extensions' prompt sections. With `extends`, the two are joined |
| `extensions` | paths from the profile's folder. Each default-exports an **agent part**, `defineExtension({ name, tools, sections })` ([tools](tools.md)), or a **daemon half**, `defineDaemonExtension({ name, setup(superego) { … } })` ([daemon](daemon.md)) |
| `ui` | window modules ([ui](ui.md)), drawn only in this profile's threads unless it's global |
| `panes` | each pane kind its UI registers, with its params, so the agent can open one |
| `without` | optional extensions (Settings → Extensions, `superego extensions`) its threads go without: the core's `coding-tools` (read, write, edit, bash), `panes` (pane_open) and `agents-md`; bundled ones such as `skills`, `thread-tools` ([thread-tools.md](thread-tools.md)), `agent-ui`, `terminal`, `mcp-servers`. No tools, prompt sections or UI of theirs. Required ones (the sidebar) can't be left out |
| `options` | what its threads ask extensions for, as `thread.start`'s `options` (a thread's own win): `{ worktrees: true }` gives each a git worktree. Not for threads they start ([thread-tools.md](thread-tools.md#what-a-child-gets)) |
| `model`, `thinking` | apply where a thread hasn't chosen its own |
| `agent` | another kind of agent (an extension's `superego.agentKind`), fixed for each thread's life; see [Claude Agent](#claude-agent) |
| `extends` | `'user:<name>'`: start from your profile of that name |
| `global` | yours only: see [Global profiles](#global-profiles) |

**Extensions' keys.** A bundled extension can add a key (`superego.profileKey`, [daemon.md](daemon.md));
`defineProfile`'s type lists them. It checks the value as the profile loads (a problem fails the load) and merges it
over `extends`.

**`mcpServers`** (the `mcp-servers` extension's) lists the MCP servers its threads use:

- A string names one of the machine's (Settings → MCP servers); an unknown name is left out.
- An object defines the profile's own by name: a `command` (with `args`, `cwd`, plain `env`) or a `url` (with
  `headers`), and `auth`: `oauth`, `api-key`, or secret `env` names. Names: lower-case letters, digits and hyphens, up
  to 24. One named like a machine's replaces it here.
- A command runs in the project's root (its `cwd` default), only once the profile is allowed; changing it means
  allowing again. Secrets and OAuth: Settings → MCP servers → From profiles, or `superego mcp-servers set-secret` /
  `sign-in`. Never in the file.
- With `extends` the lists add up, this profile's winning by name. Read each turn; a machine without the extension,
  or a profile `without` it, runs none.
- The thread's header says which it has (`3 servers`) and why any were left out; so does
  `superego mcp-servers --thread <id>`.

**Imports.** Profile files are TypeScript (types stripped on load) or JavaScript. They may import each other, Node's
built-ins (`node:fs/promises`) and `'superego'` (and `'superego/ui'`, `'react'` in UI modules). There's no
`npm install`: a package or a `package.json` `#` alias imported by name is refused, and the profile doesn't load. A
file imported by path is fine wherever it is (`node_modules` too), and counts toward what's allowed.

## Global profiles

`global: true` makes one of your own profiles part of the app:

- the daemon loads it at start, and its daemon halves run for the daemon's life;
- the window installs its UI as the app's: views in any place (a sidebar in the rail), slots and tool rows in every
  thread, styles window-wide;
- it can add **spaces**, views that fill the main area with a thread docked beside them ([window](window.md#spaces)).

Notes and Canvas are global profiles. A project's profile can't be global (its `problems` say so), and a profile
extending a global one isn't, unless it says so itself.

A non-global profile of yours can still add a sidebar from its daemon half: a data view (`superego.view`,
`context: 'window'`) that fits `sidebar`, shown while the profile is loaded. A project's can't.

## Types

`profile new` and `extension new` give a profile what an editor needs; `superego profile types [name]` gives it to
existing ones (all of this project's, the one named, or yours with `--user`), and again after a fresh clone:

| File | |
|---|---|
| `tsconfig.json` | strict, JSX for React, Node's and the DOM's types. Nothing machine-specific: commit it. One you changed is left alone |
| `node_modules` | a link to `~/.superego/types/node_modules`: declarations for `superego`, `superego/ui`, `superego/unstable`, `superego/testing`, React, Node and vitest, refreshed as the app starts |
| `.gitignore` | `node_modules` |

The daemon doesn't load packages from `node_modules`. The `tsconfig.json` counts toward a project profile's allowance
(so `profile types` allows again one that was allowed); `node_modules` and `.gitignore` don't. `superego extension
test` type-checks with the same tsconfig.

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

Keep your profiles in a repo or folder of their own and install it as a source. Its profiles are its
`profiles/<name>/profile.ts`.

```sh
superego profile install git:github.com/mikker/superego-profiles   # clone it (an https:// URL works too); again: no change
superego profile install ~/dev/superego-profiles                    # a folder, read in place
superego profile install git:github.com/acme/profiles@v1.2          # pinned: a tag, branch or commit
superego profile sources                                            # each source, its state and its profiles
superego profile update [source]                                    # git pull --ff-only (pinned ones stay)
superego profile remove <source>                                    # drop it; a git one's clone is deleted
```

- Git sources are cloned to `~/.superego/sources/<host>/<owner>/<repo>`.
- Their profiles are yours: they run without being allowed. **Installing a source is trusting its code**, so an agent
  can't install one for the user.
- `extends: 'user:<name>'`, `-P <name> --user` and `profile types --user` find them like any of yours.
- Lookup order: `~/.superego/profiles`, then each source in install order. The first of a name wins; the other is
  reported as shadowed (`superego profile`, `profile sources`, Settings → Profiles).
- The list is `~/.superego/profile-sources.json` (`{ "sources": [...] }`); edits are read again, and `profile update`
  clones a listed git source that isn't cloned yet.
- Edits (or a pull) apply from each thread's next turn.

## Allowing

A project's profile runs that repository's code, so the daemon refuses it until it's allowed, and again whenever any
file it runs changes: any file in its folder (`node_modules` and dotfiles aside), and every file its code imports,
wherever it is.

```sh
superego profile allow support     # in the project
```

`profile new` allows what it scaffolds; allow again after editing. Your own profiles are never asked about.

Allowing is the user's consent, never an agent's: from a thread's shell, `profile allow` and `allow-ui` are refused,
and `profile new` and `extension new` leave a project's profile waiting. Tell the user to allow it in the window
(where its thread asks, or Settings → Profiles) or in their own terminal.

Another machine's profile UI is asked about on this computer too, since it runs in the window with reach to every
machine: once for exactly the sources received, again after any change. Allow it from the notice in one of its
threads, or:

```sh
superego profile allow-ui default -m box     # as it is now; a name, or the profile's folder there
superego profile revoke-ui default -m box    # Settings → Machines lists them too, with Revoke
```

## When changes apply

- **A thread keeps the profile it started with.** A profile made after a thread started (your first `default`, a
  project's new one) never reaches it, the thread that wrote it included: say so. Start a new thread, or move an idle
  one onto it: `superego do thread.setProfile --thread <thread> --profile <name>` (refused while it's working).
- The daemon loads a profile when a thread with it takes a turn, and again after its files change: edit, then send the
  thread a message (a run in progress keeps what it started with). `superego extension reload` loads it now and says
  why if it can't. Daemon halves are torn down (their cleanup runs) and set up again.
- The window loads a profile's UI as soon as it lists one of its threads, and again when a shown thread of it moves on
  after a change ([ui.md](ui.md#when-the-ui-loads)).

## Claude Agent

`agent: 'claude-agent'` (experimental) runs the user's own Claude Code, signed in with its own `/login`.

- Picking a Claude Agent model (`claude-agent/opus`, `sonnet`, `haiku`, where `claude` is installed) starts a thread
  on the user's `claude` profile, `{ agent: 'claude-agent' }`, made then if missing.
- Superego's model doesn't apply. Its thread, pane, question, UI, image and task tools reach Claude Code over MCP, and
  the profile's `prompt` is appended to Claude Code's.
- It loads the user's Claude Code settings. A folder's (`.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` and
  what they import, plus skills in `.claude/skills` below it) load only once the user allowed them as they are, since
  they run commands: the thread asks (Allow, over its message box), and again after they change. From a terminal:
  `superego do claude-agent.allow --cwd "$PWD"`. Where another user could write a folder above (a shared `/tmp`), they
  can't be allowed.

`claudeAgent: { permissionMode, settingSources, allowedTools, disallowedTools, model, effort }`:

| Key | |
|---|---|
| `permissionMode` | `default`, `acceptEdits`, `plan`, `auto` or `bypassPermissions`; unset: the machine's (Settings → Claude Agent; `default`: ask) |
| `settingSources` | Claude Code's `user`, `project`, `local`: narrows what it loads, never adding a folder's not allowed |
| `allowedTools`, `disallowedTools` | Claude Code's tool lists |
| `model`, `effort` | an alias or id; `low` … `max`. Apply where a thread didn't pick its own |

## An example

[`examples/build-queue-ui`](examples/build-queue-ui) is complete: a tool, a scoped value per thread, a Cancel action, a
view beside the thread, and tests.

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
