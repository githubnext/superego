# MCP servers for Superego's agents

A design, 2026-11-15. Lanes 1 (the core seams) and 2 (the runtime) are built; lanes 3 and 4 are not yet. It covers how agents in Superego threads use MCP servers: what the
user sets up, where it lives, how it runs, and four lanes to build it in.

## Two MCPs, named apart

Superego will speak MCP in both directions. They share a protocol and nothing else.

| | **Outside agents** (built) | **MCP servers** (this design) |
|---|---|---|
| Superego is | an MCP *server* | an MCP *client* |
| Who uses it | agents outside Superego: Claude Code, Codex, an editor | agents in Superego threads |
| What they get | a machine's actions as tools: `thread_create`, `thread_submit`, … | other people's tools: `mcp__linear__create_issue` |
| Where | `superego mcp` (`packages/cli/src/mcp.ts`) | the bundled extension `mcp-servers` (`extensions/mcp-servers`) |
| Settings | Settings → Outside agents (`mcp.*`) | Settings → MCP servers (`mcp-servers.*`) |
| Profile | — | `mcp: ['linear']`, `mcpServers: { … }` |

The doc, the code and the UI always say "outside agents" for the first and "MCP servers" for the second. The `mcp.*`
keys and the `superego mcp` command keep meaning Outside agents. That's why the new extension is `mcp-servers`, not
`mcp`.

## The model

Three layers, as decided with the user:

1. **Servers and sign-in belong to a machine.** Settings → MCP servers lists that machine's servers: a command (stdio)
   or a URL (Streamable HTTP), and how each signs in (OAuth, an API key, or secret env vars). You sign in once per
   machine. Secrets and tokens stay on that machine, next to its provider credentials. A remote machine has its own
   list, which the window edits the way it edits that machine's providers.
2. **A profile opts in, by name:** `mcp: ['github', 'linear']`. A name means the machine's server of that name, so a
   repo's profile works on any machine that has a server by that name. There's room to narrow tools per server
   later (§Future).
3. **Threads without a profile** get the servers whose "Use in threads without a profile" switch is on. It's off by
   default.

Also, **a project's profile can define servers of its own** (`mcpServers`). They come under profile trust: the
profile isn't loaded until it's allowed, so its commands can't run before that. Their sign-in still goes in the
machine's store.

A thread's servers are worked out again on every turn, as its profile's extensions are. An edit to a profile or to
Settings applies from the next turn.

## Config shapes

### Settings: `<dataDir>/mcp-servers.json`

A machine's servers live in a file of their own, as `machines.json` does. They don't go in `settings.json`, because
the settings registry has no list type. The extension changes the file through actions, and the window draws it in a
custom section (`ui: 'mcp-servers'`), the way it draws Providers. The file holds no secrets. Its field names
follow the `mcpServers` blocks of Claude Code and Cursor (`command`/`args`/`env`, `url`/`headers`), so importing
those configs later is a direct copy.

```jsonc
{
  "servers": {
    "linear": {
      "title": "Linear",
      "url": "https://mcp.linear.app/mcp",
      "auth": { "type": "oauth" },
      "unprofiled": true                      // "Use in threads without a profile"
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": { "type": "api-key" }           // sent as `Authorization: Bearer <key>`; the key is in the store
    },
    "sentry": {
      "command": "npx", "args": ["-y", "@sentry/mcp-server"],
      "env": { "SENTRY_HOST": "sentry.io" },  // plain values only
      "auth": { "type": "env", "names": ["SENTRY_ACCESS_TOKEN"] }  // secret env: names here, values in the store
    },
    "playwright": {
      "command": "npx", "args": ["-y", "@playwright/mcp"],
      "lifetime": "thread"                    // a process per thread (default "machine": one, shared)
    }
  }
}
```

The type, in `extensions/mcp-servers/src/shared.ts`:

```ts
type ServerConfig = {
  title?: string
  // One of: a command (stdio) or a URL (Streamable HTTP; legacy SSE is tried when the URL answers as SSE).
  command?: string; args?: string[]; cwd?: string; env?: Record<string, string>
  url?: string; headers?: Record<string, string>
  auth?:
    | { type: 'oauth'; scopes?: string[]; clientId?: string }       // clientId: for servers without registration
    | { type: 'api-key'; header?: string; scheme?: string }         // default Authorization / Bearer
    | { type: 'env'; names: string[] }                              // stdio: secret env vars
  lifetime?: 'machine' | 'thread'   // default 'machine'
  tools?: 'auto' | 'all' | 'search' // how its tools reach the model (§Tool surface); default 'auto'
  timeout?: number                  // per call, seconds, reset by progress; default 300
  unprofiled?: boolean              // used by threads without a profile; default false
  enabled?: boolean                 // default true
  allowed?: false                   // a command someone other than the user added (Ego): waits for Allow
}
type ServersFile = { servers: Record<string, ServerConfig> }  // keys: /^[a-z][a-z0-9-]{0,23}$/
```

Server names are short, lower-case and hyphenated, with no `__`. A name is the tool prefix, and a profile refers to
a server by its name.

### Secrets: `<dataDir>/mcp-auth.json`

This is the same `FileCredentialStore` as the provider credentials (`agent-settings.ts`): JSON, mode 0600,
serialised, replaced atomically. It's a sibling file, not `auth.json` itself:

- pi-ai owns `auth.json`'s shape and reads every entry as a provider. An MCP token there would get into provider
  listings, and its rewrites would set off provider re-checks and retries (`rereadCredentials`).
- MCP needs more than a credential per server: a client registration, discovery state, and a PKCE verifier while a
  sign-in is going on.

Entries:

| Key | What |
|---|---|
| `server:<id>` | an API key, or the values of `auth.names` |
| `oauth:<resource>` | tokens (access, refresh, expiry, scope), keyed by the server's canonical URL (its OAuth resource) |
| `client:<issuer> <redirect>` | the client registration with that authorization server (from DCR), and its discovery state |

`<id>` is the server's name for one of the machine's own, and `<profile dir>#<name>` for one a project defines. A
project's server therefore never gets a key the user typed for a machine server of the same name. OAuth tokens are
keyed by resource instead: two configs that point at the same URL share one sign-in. That's safe, because the token
was issued for that URL.

Nothing in this file ever reaches a client. Settings sees "set" or "not set", "signed in as …" when the server says,
and the expiry.

### Profiles

```ts
import { defineProfile } from 'superego'
export default defineProfile({
  prompt: 'You triage bugs for Acme.',
  mcp: ['linear', 'sentry'],            // the machine's servers, by name
  mcpServers: {                         // this profile's own: on for its threads, no need to list them in `mcp`
    docs: {
      command: 'node', args: ['./tools/docs-mcp.js'],   // runs in the project's root
      auth: { type: 'env', names: ['DOCS_TOKEN'] },     // the value is entered in Settings, kept in the store
    },
    status: { url: 'https://status.acme.dev/mcp', auth: { type: 'oauth' } },
  },
})
```

- `mcp` takes names only for now. The per-tool narrowing to come will also take
  `{ server: 'linear', tools: ['list_*', 'create_issue'] }` (§Future).
- `mcpServers` has the same shape as a Settings entry, minus `unprofiled`, `enabled` and `allowed`, which don't
  apply. Its `cwd` defaults to the project's root, which is the folder holding `.superego`.
- If a profile's server has the same name as one of the machine's, the profile's wins in that profile's threads,
  just as a project's profile replaces yours. `superego extensions --thread` says so.
- `extends: 'user:<name>'` merges both fields: `mcp` as a union, and `mcpServers` by name, with the project's
  winning.
- `without: ['mcp-servers']` drops every server, the same as switching the extension off.
- A user profile's servers run like the rest of the user's profile, with no allowing. A project's run only once the
  profile is allowed, because the profile isn't loaded before then. Its command line is in `profile.ts`, so any
  change to it means allowing the profile again.

## Decisions

### The client: `@modelcontextprotocol/sdk`

- **pi has no MCP client.** pi-durable 1.5 has the pieces a client plugs into. The README calls an MCP bridge a tool
  that calls tools. The other pieces:
  - `callers: ['tools']` and `deferred: true` on a tool
  - `tool_search` (`@earendil-works/pi-durable/tool-search`): BM25 over the deferred tools, loading the matches
  - code mode's `namespaces`, which group tools by a prefix such as `mcp__github__`
  - `addTools`, which offers by name "a tool … of an MCP server that is reconnecting … once it is again"

  The client itself, meaning transports, the protocol, and OAuth, is left to the host.
- **The SDK is the client.** Version 1.32.2, already a dependency of the CLI, has all of it:
  - stdio, Streamable HTTP and SSE client transports
  - `listChanged` handlers, with debouncing
  - progress, and cancellation through `AbortSignal`
  - protocol versions up to 2025-11-25
  - a whole OAuth client (`client/auth.ts`). You give it an `OAuthClientProvider` and it does the rest: protected
    resource and authorization server discovery, DCR, Client ID Metadata Documents, PKCE, `resource`, and refresh.

  Writing our own would mean doing all that again for no gain. The extension takes the SDK as a dependency at the
  CLI's version, so one copy is bundled. Its client imports pull in zod and ajv, which the app's daemon bundle already
  carries through the CLI.
- **stdio servers get a clean environment**, not the daemon's. That means the SDK's `getDefaultEnvironment()` (HOME,
  PATH, SHELL, TERM, USER, LOGNAME), then the config's `env`, then the stored secret values. The daemon's own
  environment can hold `ANTHROPIC_API_KEY` and the like (README, Environment), so no server inherits it. Each server
  runs as its own process group (`spawnGroup`, `process-group.ts`), so stopping it stops everything it started.

### Where it lives: a bundled extension, plus four seams in the core

`extensions/mcp-servers` has a daemon half (servers, sign-in, tools, actions, the settings section) and a UI half
(the section, transcript rows, the thread's chip). It's optional, like every bundled extension: a machine can switch
it off, and a profile can go without it.

The extension API is short of four things, and Lane 1 adds them:

1. **`superego.agentParts(fn)`: parts that add up.** `agentFor` gives a thread's agent to the first chooser that
   answers. MCP has to add its parts to whatever agent a thread has, so it can't use `agentFor`. The new hook:
   - Each extension's `agentParts` is asked at submit, in `agentOf`, and its parts are added after the chooser's and
     before the profile's.
   - It gets `{ id, hidden, owner, profile?: { ref, spec } }`. The `spec` is the profile as loaded *now*, so profile
     edits take effect on the next turn.
   - It may be async, up to a limit the core enforces (5s). A first turn can then wait briefly for a server it has
     never listed. Every extension's is asked at once; one that's late or throws adds nothing to that turn (logged
     once).
   - It returns only parts the extension gave with `agent(part, { always: false })`, matched by the name they were
     given: returning the first object still gives the part installed under that name now.
   - It isn't asked while a thread is being made (only its model counts then), only at submit.
2. **`agent()` returns a handle** with `replace(next)` and `remove()`. A server's part is installed and replaced again
   as its tools change, under the same name. Conversations select parts by name, so the next request picks up the
   change without configuring the thread again (pi-durable resolves the registry per phase). The handle is also a
   function that removes the part, so a one-line `setup: (s) => s.agent(part)` still returns a valid cleanup.
3. **`superego.auth.flow(context, run)`**: a sign-in flow of an extension's own, carried by the existing `auth.event`,
   `auth.respond` and `auth.cancel`. `context` is the action's (`DaemonContext`): the events go to the client that
   ran it. It answers `{ flow }` at once, which the action returns, as `auth.login` does. `run(flow)` gets
   `{ id, signal, emit(event), prompt(prompt, { signal }) }`. The flow ends `done` when `run` resolves and `failed`
   when it throws (`Cancelled` after `auth.cancel`). It's also cancelled when the extension is torn down. An answered
   prompt now says `prompt_closed` to every client. The window shows MCP sign-ins with the same component it uses for
   providers, `SignInFlow` (`packages/app/src/renderer/sign-in-flow.tsx`). It's out of `SettingsView.tsx` and exported
   from `superego/ui`: `<SignInFlow machine title start={() => dispatch('mcp-servers.login', …)} onClose />`. The flow
   machinery is out of `agent-settings.ts` and in `auth-flows.ts`, and providers use it too.
4. **Tool rows by prefix** in the UI half: `superego.tool('mcp__*', row)`. A `*` may only end the name. A tool's own
   row wins over a prefix, and a longer prefix wins over a shorter one.

`ProfileSpec` gains `mcp` and `mcpServers` (in `profiles.ts`, with the `extends` merge and checks). The checks cover
names, exactly one of `command` or `url`, `args` as strings, and `env` and `headers` as maps of strings. The rest,
such as `auth`'s shape, is left to the extension. The core only carries them; the extension reads them. The server's
type is `ProfileMcpServer`, exported from `'superego'`. The extension's `ServerConfig` is that type plus
`unprofiled`, `enabled` and `allowed`.

### Which servers a turn has

The extension's `agentParts`, for a thread:

- **Hidden threads** (an extension's own: Ego's) get none.
- **With a profile:** the servers in `spec.mcp` that the machine has, are enabled and aren't waiting on Allow, plus
  every server in `spec.mcpServers`.
- **Without a profile:** every server with `unprofiled: true`.
- A name that matches no server, a disabled server, or one waiting on Allow is left out, and the thread says why
  (§UI).

What it returns: a part per server (`mcp:<name>`) holding its tools, and the shared part `mcp-servers`. The shared
part carries the prompt section and the `afterTool` hook. When any of the thread's servers is deferred, it also adds
`tool_search`.

**Child threads** (`thread_start`) work it out for themselves, from their own profile. Nothing is inherited.

### Server lifetime

- **Shared by default.** A `lifetime: 'machine'` server is one process (stdio) or one session (HTTP) on the machine,
  used by every thread that has it. `lifetime: 'thread'` gives each thread its own:
  - for servers that keep state per session, such as a browser
  - for servers that should see the thread's folder: its `cwd` is the thread's folder, and it gets that folder as its
    MCP root

  A project's server is shared among that profile's threads, and runs in the project's root.
- **Lazy, with a cached tool list.** Every server's last `tools/list` (with its `instructions`) is kept in
  `<dataDir>/mcp/cache/<id>.json`. Parts are installed from the cache when the extension sets up, which is before
  interrupted runs resume, so a resumed run finds its tools. That way the model can be offered a server's tools
  before the server runs, and a server starts:
  - when it's added, edited or signed in to, to check it and fill the cache (then stopped again if idle)
  - in the background when a thread that has it starts a turn (`turnStart`), so the first call doesn't wait for
    the start-up
  - on a call, if it isn't running yet
  - for a server with no cache yet (a project's server the first time): in `agentParts`, which waits up to 5s. If
    that isn't enough, the turn goes on without it, the section says it's still starting, and its tools come on the
    next turn.
- **Idle stop.** A shared server that no call has used for 10 minutes, and that no working thread has, is stopped.
  The cache keeps its tools offered. A thread's own server stops 10 minutes after the thread's last call, or when the
  thread is archived or cleared. Neither kind outlives the daemon.
- **Restarts.**
  - Editing a server's config restarts it once its calls in flight finish.
  - Settings has Restart, and the CLI has `superego mcp-servers restart <name>`.
  - An HTTP session that expires (`404` with `Mcp-Session-Id`) is set up again once, without telling anyone.
- **Crashes.**
  - A stdio server that exits fails its calls in flight with its exit code and the last lines of its stderr. It's
    started again on the next need.
  - Three crashes within a minute mark it `failed`, and it stays failed until Restart or a change to its config.
    The state, and why, shows in Settings and on the threads that have it.
- **Logs.**
  - What goes in `<dataDir>/logs/mcp/<id>.log`: each server's stderr, its `notifications/message` logging, and
    connection errors (status codes, not bodies, for HTTP auth).
  - The log rotates at 1 MB, keeping one old file.
  - Stored secret values are replaced with `***` before writing.
  - Read it with `mcp-servers.log {server, lines}` (Settings → Show log) or `superego mcp-servers logs <name>`.

### Tool surface

- **Names: `mcp__<server>__<tool>`.** We use pi-durable's form rather than `github__create_issue`:
  - Its `tool_search` ranks tools by it (it finds `mcp__peekaboo__app` for "peekaboo app").
  - Code mode's namespaces use it.
  - Claude Code uses it, so models know the form.
  - The `mcp__` prefix keeps server tools clear of built-ins and makes the UI's prefix rows trivial.

  Characters outside `[A-Za-z0-9_-]` become `_`. A name over 64 characters (the providers' limit) is cut, and six
  hex characters of its hash are added. The extension keeps the map back to the server's own name.
- **Schemas** go to pi-durable as JSON Schema. pi-durable takes any JSON Schema object (`ToolRegistration.parameters`,
  through pi-schema), and pi-ai fits it to each provider. The extension only normalises:
  - the root must be `type: 'object'`
  - `$schema` is dropped
  - local `$ref`s into `$defs` are inlined, a few levels deep
  - a tool whose schema still won't go is skipped, and its server's status names it

  An `outputSchema` becomes `structuredOutputSchema`, and `structuredContent` becomes its `structuredOutput`, which
  code mode will use later. The `title` and `annotations` go into the row (§UI).
- **Results** become pi content:

  | MCP content | Becomes |
  |---|---|
  | text | text |
  | image | an image the model sees |
  | audio | a line saying it was left out |
  | `resource_link` | a line with its URI, name and type |
  | embedded text resource | its text, under its URI |
  | blob | saved in the thread's files (`threads.attachments`) and named by path |

  `isError` makes an error result. Output is capped (50 KB, head kept), and the full text is saved beside the thread
  and named by path, as code mode does.
- **Progress** notifications become the call's live output and reset its timeout. Stop sends
  `notifications/cancelled` through the call's `AbortSignal`.
- **`tools/list_changed`** lists the tools again, updates the cache, and replaces the server's part. The next request
  offers the new list. Loaded deferred tools stay loaded by name. A call to a tool that went away gets an error result
  saying so.
- **Instructions.** A server's `instructions` (from `initialize`) go in the `mcp-servers` prompt section, up to 2 KB
  each. The section has a line per server, so the model knows what each is for and which are deferred: name, title,
  state, and how many tools.
- **Context cost: deferred loading is in v1.** pi-durable already has it, so it's cheap, and the tool count runs away
  quickly. GitHub's server alone has dozens of tools.
  - It's decided per server, not per thread, so a server's tools are the same in every thread and the prompt cache
    keeps.
  - `tools: 'auto'`, the default, defers a server's tools once it has more than 15, or more than about 5k tokens of
    schemas.
  - `'all'` always offers them. `'search'` always defers them.
  - A loaded tool is appended to the request, so the cache isn't broken. It stays loaded on that branch, through
    compactions too.
  - Code mode, where scripts call MCP tools and only the output reaches the model, is a later step (§Future).
- **Other MCP features, v1:**
  - Roots: only `lifetime: 'thread'` servers get them (the thread's folder). Shared servers aren't told of any.
  - Sampling: not offered.
  - Elicitation: not offered (§Future: as `ask_ui`).
  - Prompts and resources: not used (§Future).
  - Logging: to the log.
  - The client capabilities sent in `initialize` say exactly this.

### Durability

pi-durable commits a call's intent before `execute()`. If the daemon dies while a tool runs, the tool runs again only
if it says `replay: 'safe'`. Otherwise the model gets an `interrupted` error result, with whatever output was
committed.

- **Every MCP tool is `replay: 'unsafe'`, the default.** Its side effects are unknown, and `readOnlyHint` is a hint the
  spec tells clients not to trust. After a restart, a call that was in flight is never sent again.
- **The model is told what that means.** The extension's `afterTool` hook sees the interrupted result (by its
  diagnostic code) and rewrites the text: "Superego restarted while `linear.create_issue` was running. It may or may
  not have taken effect on the server. Check (for example, list the issues) before calling it again." The window
  shows the row as *Interrupted: may have run* (§UI).
- A thread's own server is gone after a restart anyway. Its session state is lost, and the message says so.
- Later, and opt-in per server: `replay: 'read-only'`, which trusts the server's `readOnlyHint` and runs read-only
  calls again. Not in v1.

### Sign-in

- **API keys and secret env values** are typed into Settings (secret fields) or given with
  `superego mcp-servers set-secret <name>` (read from stdin), and kept in the store. A key goes out as
  `Authorization: Bearer <key>`, or in the header the config names.
- **OAuth (HTTP servers)** follows the MCP authorization spec, through the SDK's `auth()` and an `OAuthClientProvider`
  over the store:
  - *Discovery.* A `401` with `WWW-Authenticate` leads to the server's protected resource metadata (RFC 9728), and
    from there to its authorization server's metadata (RFC 8414, or OpenID discovery). The discovery state is kept
    with the client registration.
  - *Registration*, in this order:
    1. a `clientId` in the config, with an optional secret in the store, for servers that want a registered app
    2. dynamic client registration (RFC 7591), registered once per authorization server and redirect URI, and
       kept

    Client ID Metadata Documents come later, once Superego has a URL to host its metadata on (§Decided questions,
    §Future).
  - *The flow:* authorization code with PKCE (S256), `state`, and `resource` (RFC 8707) set to the server's canonical
    URL, so the token is good only there.
  - *Refresh* happens before a call when the token has less than a minute left, inside the store's serialised
    `modify`. Two threads therefore never use the same refresh token twice, which matters where refresh tokens
    rotate.
  - *A refresh that's refused* (`invalid_grant`), or a `401` that a refresh doesn't fix, puts the server into
    `needs-sign-in`. Its calls then fail at once with an error result: "linear needs you to sign in again (Settings →
    MCP servers)". It's a tool error, not a blocked thread. The model can carry on without the server, and the
    window shows a notice on the thread (§UI).
- **Where the browser flow runs.** The flow runs in the daemon of the server's machine. That's where the verifier,
  the code exchange and the tokens are, and the tokens never leave it. Only the browser is somewhere else.
  - Providers today: the daemon listens on its own loopback (`127.0.0.1:1455` for OpenAI) and sends `auth_url`. The
    window opens the URL in the user's browser. When that browser is on another computer, the redirect goes nowhere,
    so pi-ai also asks with a `manual_code` prompt, "paste the redirect URL", and the user pastes it.
  - MCP does the same, with one addition. The redirect URI is fixed per app, `http://127.0.0.1:<port>/mcp/callback`,
    with the port in `AppConfig`. `auth_url` gets an optional `callback` with that URI.
  - **Daemon on this computer:** the daemon catches the redirect itself.
  - **Daemon on another machine, desktop app:** the app's main process listens on that port on *this* computer
    while the flow is open. It catches the redirect and answers the flow's `manual_code` prompt with the whole
    redirect URL (`auth.respond`). The daemon checks `state` and exchanges the code, so signing in to a remote machine
    feels like signing in locally. This is built (`packages/app/src/main/sign-in-callback.ts`). It watches every
    `auth.event` from a machine other than `local`, so it doesn't depend on which window or component drew the flow.
    It listens only for `http://127.0.0.1` or `localhost` callbacks at a port of 1024 or above, one flow per port.
    It stops when the flow ends, after 10 minutes, or when it catches the redirect. A taken port is left alone.
    For it to work, the flow must emit `auth_url` with `callback`, and then open a `manual_code` prompt, even when
    its own daemon listens too. The daemon's own listener closes that prompt when it catches the redirect first,
    through `prompt`'s `signal`.
  - **A browser or phone,** or a port that's taken: the user pastes the redirect URL, as with providers today.
  - **The command line** (`superego mcp-servers login <name>`, `-m` for another machine) prints the URL and listens
    the same way.
  - Later, the same `callback` can fix OpenAI sign-in on remote machines too. That's not part of this work.

### UI

**Settings → MCP servers**, per machine, beside Providers:

- One row per server:
  - name and title
  - what it runs: `npx -y @sentry/mcp-server` or `mcp.linear.app`
  - a state dot: off, stopped, starting, running · 23 tools, needs sign-in, failed, waiting for Allow
  - the switch *Use in threads without a profile*
  - a menu: Edit, Restart, Show log, Sign out, Remove
- A row needing sign-in has **Sign in** (OAuth) or **Set key** (API key or env). A failed one shows its last error
  line, with Show log.
- **Add server** opens a dialog:
  - Command or URL, as a segmented control
  - the name, filled in from the URL or package
  - args, and env as plain or secret
  - auth: none, OAuth, API key, or env
  - lifetime and tools, under More

  On save, the server is started once to check it. The dialog shows "Connected · 23 tools", or the error, before
  it closes. A short list of well-known servers (`catalog.ts`) fills in the fields; Ego uses the same list.
- **From profiles**, a second group: the project servers the daemon has seen, with their profile and project. Each
  shows whether its profile is allowed, and has its sign-in. You can't edit them here; they're the profile's.
- For a remote machine, it all works the same through that machine's link (relayed in a browser), as Providers
  does.

**In the transcript**, MCP calls are rows like any other (`superego.tool('mcp__*', …)`):

- the plug icon
- the verb: *Called* / *Calling* / *Failed*, or *Interrupted: may have run*, in the warning tone
- the subject: `Linear · create_issue` (the tool's `title` where it has one) and the first short string argument
- the body: the arguments as JSON, folded, then the result as text, with images inline
- for a `tool_search` row: *Looked for tools: "issue"*, and the tools it loaded

**On the thread:**

- A **chip in the header** shows the thread's servers (`3 MCP`). It opens a list of each server with its state, and
  says why any were left out: no such server here, disabled, waiting for Allow, needs sign-in.
- The same list is in thread details (⌘I).
- A server that needs sign-in, in a thread that has it, puts a notice over the composer with *Sign in*, as
  `AuthNotice` does for providers.

`superego extensions --thread <id>` (the `extensions.inspect` report) lists the servers too, each with where it's
from and its state. The extension adds them to the report's `thread` section, using the same reasons.

### Ego

Ego helps set up a server ("connect Linear"), within its settings-only powers:

- **A tool, `superego_mcp_servers`:** list, add (from the catalogue by name, or as a command or URL), edit, remove,
  and switch *Use in threads without a profile*. It runs the extension's actions.
- **It never handles secrets.** The tool's schema has no secret fields. The prompt tells Ego to send the user to
  Settings → MCP servers → *name* → Sign in / Set key, and never to ask for a key in chat, where it would sit in the
  transcript.
- **A command it adds waits for the user.** It's saved with `allowed: false`, and Settings shows the whole command
  line with **Allow**. Running a command is running code, which is more than setup. A URL server needs no Allow; it
  only needs sign-in, which only the user can do anyway.
- **Not for outside agents.** When the message Ego is answering came with `<outside-agent>`, the tool refuses, the
  same way `thread_start` does. A server is a way to run commands and reach accounts.
- Ego's own thread uses no MCP servers (hidden threads get none, as above).

### Security

- **Project commands run only after the profile is allowed.** The profile isn't loaded before, and any change to
  `profile.ts`, its command lines included, means allowing it again. Settings → From profiles shows each command in
  full.

  What the command runs (`./tools/docs-mcp.js`) is the project's code, as its build scripts are. Only the profile
  is hashed for trust, not the files that script reads; the doc for profile authors says so.
- **Secrets:**
  - only in `mcp-auth.json` (0600), never in `mcp-servers.json` or `profile.ts`
  - never in a settings snapshot, an action's result, a log (redacted) or a transcript
  - a project's server can't read a key stored for a machine server of the same name, because keys are by server id
  - OAuth tokens go only to the resource they were issued for
- **HTTP servers must use `https`,** except on loopback.
- **Clean environments** for stdio servers (above), in a process group of their own.
- **Outside agents (`superego mcp`) never touch any of it.** No `mcp-servers.*` action says `'mcp'` in its `expose`:
  not list, add, edit, remove, Allow, sign-in or sign-out, set-secret, restart, or logs. A test checks that none of
  them is in the MCP list, as for settings and auth today. Nor can they get there through Ego (above). The servers'
  tools are never offered through `superego mcp`: the outside agent gets Superego's actions, not the servers
  Superego's agents use.

  An outside agent can still start a thread, where the machine allows it (`mcp.startThreads`), and that thread gets
  its servers like any other (§Decided questions).
- **Tool results are untrusted input**, the way web pages are. The row and the result say which server they came
  from. There's nothing more to do in v1.

### Protocol and compatibility

- **The extension announces `ext:mcp-servers`** in `hello`, like every extension. The window draws the section, chip
  and rows only for machines that have it. An older daemon has no section and no rows. An older app drawing a newer
  daemon's settings gets the section's text without its custom part: it can't edit servers, and nothing breaks.
- **New core pieces are additive, so no new `FEATURES` entry is needed:**
  - **`auth_url.callback`** is an optional field, and older apps ignore it, so pasting still works.
  - **`auth.event` and `auth.respond` for extensions' flows** keep their shape. A flow is a flow.
  - **The `agentParts` hook, `agent()`'s handle, `auth.flow`, the prefix rows and `SignInFlow`** are extension API.
    They went in as `EXTENSION_API` 1.7.0, and an extension asks for them with `api: '^1.7'`.
- **Actions** (`mcp-servers.add`, `edit`, `remove`, `allow`, `login`, `logout`, `set-secret`, `restart`) are new, so
  `released-actions.json` only grows.
- **A profile with `mcp` on an older daemon** loads without it, because the core ignores keys it doesn't know. Its
  threads run without servers, and `superego extensions --thread` is where to look.

## Decided questions

These were open in the first draft; the user settled them.

1. **Outside agents' threads get MCP servers**, like any thread of that profile. A thread an outside agent starts
   (`mcp.startThreads`) works out its servers as any other does. The Can start threads setting says so in its
   description (Lanes 2 and 4).
2. **No Client ID Metadata Documents for now.** There's no site to host Superego's client metadata on, so
   registration is a configured `clientId`, else dynamic client registration. CIMD is future work (§Future).
3. **A command Ego adds waits for the user's Allow.** It's saved with `allowed: false` and doesn't run until the user
   allows it in Settings (§Ego).

## Lanes

Four lanes, each one thread's work. Order: **1, then 2, then 3 and 4 side by side.** Each lane runs the checks in
AGENTS.md. Lanes 1 and 4 touch `packages/app`, so they run smoke.

### Lane 1: Core seams

Owns the API the extension needs, with nothing MCP-specific in it.

- `superego.agentParts(fn)`: parts that add up, asked at submit in `agentOf` with the live profile spec, async with a
  5s limit
- `agent()` returning `{ replace, remove }`
- `superego.auth.flow(run)` over `auth.event`, `auth.respond` and `auth.cancel`. Provider flows move onto the same
  machinery (`auth-flows.ts`).
- `auth_url.callback`, and the desktop app's loopback catcher that answers the `manual_code` prompt for a remote
  machine's flow
- `ProfileSpec.mcp` and `mcpServers`: types, checks, the `extends` merge
- tool rows by prefix (`tool('mcp__*')`), and `SignInFlow` moved out of Settings and exported from `superego/ui`

Files:
- `packages/daemon/src/{extension.ts,daemon.ts,profiles.ts,agent-settings.ts}`, and a new `auth-flows.ts`
- `packages/protocol/src/settings.ts` (`AuthEvent`)
- `packages/sdk` (types)
- `packages/app/src/renderer/{extension.tsx,tool-rows.tsx,SettingsView.tsx,sdk-ui.ts}`
- `packages/app/src/main` (the catcher)
- `packages/cli/skill/{profiles.md,daemon.md,ui.md}` for the new API

Tests: daemon tests for parts adding up, a part replaced mid-run, a flow from an extension, and the profile merge; a
smoke step for a provider sign-in that still works.

Depends on nothing.

**Built.** As above, except:
- `auth.flow` takes the action's context: `superego.auth.flow(context, run)`.
- The catcher is `packages/app/src/main/sign-in-callback.ts`.
- `SignInFlow` lives in `packages/app/src/renderer/sign-in-flow.tsx`.
- `DaemonOptions.agentPartsLimit` shortens the 5s limit for tests.

Its tests are `packages/daemon/test/agent-parts.test.ts`, `packages/app/test/sign-in-callback.test.ts`, the prefix
case in `packages/app/test/tool-rows.test.ts`, and a smoke step (an API key through Settings → Providers, then Sign
out).

Lane 2 should know:
- Give each server's part with `agent(part, { always: false })` at setup, from the cache, and keep the handle.
  Return those parts from `agentParts` and call `replace` when the tools change. Don't install a part per thread;
  `agentParts` picks among installed parts.
- `profile.spec.mcpServers` is the *merged* map, so a server that came from the user's profile through `extends`
  can't be told from the project's. `profile.ref` is the thread's profile, so a server's id is
  `<ref.dir>#<name>`, and `cwd` defaults to the project root above `ref.dir`.
- Hidden threads (`hidden: true`) get no servers: that's the extension's rule, applied to `hidden` and `owner`.
- `ProfileMcpServer` is the shared base type to extend.

### Lane 2: The runtime

Owns `extensions/mcp-servers`'s daemon half, with every way to sign in except OAuth:

- the config file and its actions; the secret store (`mcp-auth.json`)
- connections over the SDK (stdio and Streamable HTTP, with none, API key or env auth)
- the clean environment and process groups
- lifetime: shared or per thread, lazy, the cache, idle stop, restarts, crashes, logs
- the tool bridge: names, schemas, results, progress, cancellation, `list_changed`, instructions, the prompt section,
  deferred loading with `tool_search`
- the `afterTool` rewrite for interrupted calls
- `agentParts` selection: profile, unprofiled, hidden
- profile servers under trust
- facts, the inspect report, the settings section's `data`
- `superego mcp-servers` (list, logs, restart, set-secret)

Files:
- `extensions/mcp-servers/{package.json,tsconfig.json}`
- `extensions/mcp-servers/src/{shared.ts,daemon.ts,config.ts,store.ts,connections.ts,tools.ts,results.ts}`
- `extensions/mcp-servers/test/*`, with a fixture server built on the SDK's `McpServer`: stdio and HTTP, a tool that
  hangs, one that crashes, one that changes its list
- registration in `app/src/daemon.ts`
- the root `tsconfig.json` references
- a `packages/cli/src` command

`shared.ts` (the config, the section's `data` and the action params) lands first, so Lane 4 can start on it.

Depends on Lane 1.

**Built.** As above, except:
- The runtime is in `servers.ts` (`Runtime`: the servers, their parts, sessions, idle stop, crashes, the cache);
  `daemon.ts` wires it to the API. Tests: `test/connections.test.ts`, `test/daemon.test.ts` (against a real daemon,
  the fixture `test/fixture.ts` as a command and over HTTP), `test/tools.test.ts`, and
  `packages/cli/test/mcp-servers.test.ts`.
- **Settings' data is also a live value.** An extension can't tell the settings registry its section's `data` changed,
  so the section's `data` is right when Settings is read, and the live value `mcp-servers.servers` (the same
  `SectionData`) is kept current as servers start, stop and fail. Draw from the value.
- **Actions:** `add`, `edit` (whole config; `rename`), `remove`, `set` (`unprofiled` or `enabled` alone), `allow`,
  `set-secret` (`{ server, values }`, `null` forgets one), `logout` (forgets the server's stored secrets),
  `restart`, `log`. `login` is named in `ACTIONS` for lane 3. Add, edit, allow, set-secret and restart start the
  server to check it (up to 30s) and answer `{ server: ServerInfo }`. All are `['ui', 'cli']`; none `mcp`.
- **Who added a command isn't guessed.** An action can't tell Ego from the window (`context.source` is a name either
  way), so `add` and `edit` take `allowed: false`, and Ego's tool must pass it for a command. An edit without it keeps
  what the server had: a waiting server stays waiting until `allow`.
- **The prompt section leaves out running and stopped.** The section renders before every request, so a state that
  flips would break the prompt cache. A server reads as its tool count (and "find them with tool_search" when
  deferred), or as unavailable with why (off, waiting, needs sign-in, failed), or "still starting" before its first
  listing.
- **Names on disk:** the cache is `<dataDir>/mcp/cache/<name>.json` for the machine's servers and
  `<name>@<hash>.json` for a profile's (`<hash>`: eight hex of its id); logs are `<dataDir>/logs/mcp/` by the same
  names. Agent parts are `mcp:<name>` and `mcp:<name>@<hash>`, the shared one `mcp-servers`, and `tool_search` comes
  in `mcp-servers-search`.
- **A profile's server's config is kept in its cache**, as the profile said when it was last loaded (so allowed then).
  A run resumed after a restart can start it before the profile's next turn.
- **Where commands run:** a machine server in `cwd` or the home folder; a profile's in the folder holding its
  `.superego` (the project's root; for a user profile, the data folder's parent), `cwd` resolved against it; a
  thread's own in the thread's folder.
- **API keys:** `scheme` defaults to `Bearer` only for the `Authorization` header; another header gets the bare key.
- **A `401`** (a refused key, or a server that wants OAuth) puts the server in `needs-sign-in`, its calls failing at
  once, until its secrets change or it's restarted.
- **A thread's own server** stops when the thread is archived and after 10 idle minutes. Clearing a thread has no
  hook, so it doesn't stop it.
- **`superego extensions --thread`** prints the thread's servers from its facts (`thread.ext['mcp-servers']`); the
  core's report has no seam for extensions, and none was added.
- **The interrupted rewrite** keeps the call's partial output and puts the message in the result's diagnostic, its code
  still `interrupted`.
- `Settings → Outside agents → Can start threads` says that a thread one starts has its servers like any other.

Lane 3 should know:
- `connections.ts`'s `Launch.oauth` is an `OAuthClientProvider`, passed to the HTTP transports. Nothing sets it yet:
  `Runtime.connect` (servers.ts) builds the launch, and should give one for `auth.type === 'oauth'`.
- A `401` sets `server.refused` (`needs-sign-in`); `Runtime.secretsChanged(server)` clears it and restarts the
  sessions. Call that once a sign-in or sign-out changes the store.
- `SecretStore.modify(key, edit)` runs under the store's lock, for refresh. Every stored string is hidden in logs
  (`SecretStore.secrets()`), tokens included.
- `logout` forgets `server:<id>`; add the server's `oauth:<resource>` tokens.

Lane 4 should know:
- Settings: draw `SectionData` from the live value `mcp-servers.servers` (`servers`: the machine's in the file's
  order; `profiles`: those seen from profiles). `ServerInfo.error` is why it's failed, waiting or needs sign-in, else
  its last error. The section is `order: 25`, just after Providers.
- The thread's chip and details: `thread.ext['mcp-servers']` (`ThreadServers`), with `LEFT_OUT` for the reasons.
- Rows: a call's `details` are `CallDetails` (server, tool, titles, annotations, saved files), set as the call starts,
  so an interrupted call's row has them too. An interrupted call is an `mcp__*` result with an `interrupted`
  diagnostic. `tool_search`'s details are `{ loaded }`.
- Ego's tool passes `allowed: false` to `add` and `edit` for a command.

### Lane 3: OAuth

Owns sign-in to remote servers:

- an `OAuthClientProvider` over the store
- discovery, registration (a configured `clientId`, then DCR), PKCE, `resource`
- refresh under the store's lock, and `needs-sign-in` on `invalid_grant`
- `mcp-servers.login` and `logout` through `superego.auth.flow`, with the daemon's loopback listener and the fixed
  redirect URI (`AppConfig`)
- `superego mcp-servers login`

Files:
- `extensions/mcp-servers/src/oauth.ts`
- the auth hook in `connections.ts`
- `extensions/mcp-servers/test/oauth.test.ts`, against a fake authorization server: the SDK's server-side
  `mcpAuthRouter` with an in-memory provider. It covers discovery, DCR, refresh, a rotated refresh token with two
  threads at once, `invalid_grant`, and a pasted redirect URL.

Depends on Lanes 1 and 2.

### Lane 4: UI, Ego and docs

Owns everything the user sees and reads:

- the extension's UI half: Settings → MCP servers (rows, states, Add and Edit dialog, the check on save, Show log,
  Sign in and Set key through `SignInFlow`, From profiles, Allow), the transcript rows, the header chip, the thread
  details list, the needs-sign-in notice
- the well-known catalogue
- Ego's `superego_mcp_servers` tool and its prompt lines
- README (the extension's row, Profiles), PLAN (§3b and a progress entry), the skill topics

Files:
- `extensions/mcp-servers/src/{ui.tsx,styles.css,catalog.ts}`
- `extensions/ego/src/{tools.ts,daemon.ts}`, `extensions/ego/test/*`
- `README.md`, `PLAN.md`
- `packages/cli/skill/{profiles.md,bundled.md}`
- `app/test/look.sh` shots of the section and a transcript with MCP rows

Depends on Lane 1 (prefix rows, `SignInFlow`) and on Lane 2's `shared.ts`. It runs alongside Lane 3, with OAuth
rows working once Lane 3 lands.

## Future

- **Importing** servers from Claude Code (`~/.claude.json`, `.mcp.json`) and Cursor (`~/.cursor/mcp.json`). The
  config shapes already match, so it's a copy, plus moving secrets into the store.
- **Per-tool narrowing** in profiles: `mcp: [{ server: 'linear', tools: ['list_*', 'create_issue'] }]`.
- **Code mode** over MCP tools (`@earendil-works/pi-durable/codemode` with `namespaces`): scripts call the tools,
  and only the output reaches the model.
- **Elicitation** as `ask_ui` blocks; **prompts** as `/` commands in the composer; **resources** as `@` mentions.
- **Replay of read-only calls**, opt-in per server (§Durability).
- **CIMD** once Superego has a URL to host its client metadata on.
- **The same remote-callback catch for provider sign-in** (OpenAI on a remote machine).
- **Sandboxing stdio servers** (no network, or only the project's folder) for projects' servers.
