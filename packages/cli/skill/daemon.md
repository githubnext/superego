# The daemon half

New here? Start with [the guide](guide.md) and the [cheat sheet](cheatsheet.md).

A daemon half runs in the machine's daemon, beside the agents. Besides tools, it can define **actions** (intents the
UI and command line run, and Ego lists), **methods** (reads for a pane), **live values** (state clients watch), **pane
kinds** described to the agent, a thread's **blocked** status, and reach **threads**. A profile lists it in
`extensions`, like an agent part; a `setup` function tells them apart.

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

## Setup and teardown

- `setup` runs when the profile first loads (a thread's first turn, a window listing one of its threads
  ([ui.md](ui.md#when-the-ui-loads)), or the daemon starting while one of its threads was working), and again after its
  files change, the previous cleanup first.
- Everything it registers (tools, actions, methods, values, settings, status, pane kinds) is removed on reload, so
  register freely. Its name prefixes all of it; a second extension of the same name is refused.
- Profiles load one at a time. Keep `setup` quick, and don't await anything that loads a profile (starting or reading a
  thread): it waits on this load. Start such work without awaiting, or do it in a tool, action or hook. A `setup` over
  15s is torn down and the profile fails to load, saying so.
- Teardown aborts `superego.signal` first: give it to your timers, watchers and fetches (`watch(path, { signal })`,
  `fetch(url, { signal })`), or return a cleanup. A cleanup may return a promise; the daemon waits up to 15s before it
  closes. A cleanup that throws is logged, and the rest still goes. Start nothing new once the signal has aborted.
- Run commands with `spawnGroup(command, args, { cwd, signal })`, not `spawn`: `stop()` (or the signal) ends the whole
  process group, SIGTERM then SIGKILL after `grace`, and `exited` resolves once none of it is left. Stopping a shell
  alone leaves what it started running.
- (API ^5.18) What should outlive the daemon (it restarts on every update): `spawnGroup(…, { outlive: true })`, its
  output to a file rather than a pipe, its leader's pid, `(await processTable.lookup(pid)).start` and
  `await processTable.boot()` kept; after a restart, check the machine hasn't booted since and the pid is still that
  process, and take it back with `adoptGroup(pid, { grace, start })` (`exited`, `stop()`). At teardown, `release()`
  it: it runs on for the next daemon. Most extensions want the bundled Processes instead
  ([Processes](#processes)): it does all of this, and the user sees and stops them.
- After teardown, registering throws, and a live value's `set` and `update` do nothing.
- An edit to any local file an extension imports reloads it with the new code; packages load once.

## The API

### Actions, methods and values

| | |
|---|---|
| `action(defineAction({ id, title, params?, expose?, keys?, thread?, run }))` | an action `<name>.<action>`, logged. `expose`: `['ui']` (default) for the window; add `'cli'` for the command line (and Ego); `'outside'` makes it a `superego mcp` tool, only for what's safe to hand any MCP client. `run(params, context)` returns JSON or throws `RpcError(code, message, { hint })`. `keys: 'mod+shift+b'` binds it in the window while one of this machine's threads is shown; `thread: true` fills in its `thread` |
| `dispatch(id, params)`, `actions(exposure?)` | run any action on this machine as this extension (`settings.set`, another extension's); list them (`'cli'`: what `superego do` runs) |
| `method(name, run, { params? })` | a read `<name>.<method>` that clients `call`; params checked first. Not logged, not in ⌘K or the command line |
| `call(id, params)` | call another extension's method on this machine (`skills.list`); rejects if none has it |
| `value(key, initial)` | a live value `<name>.<key>`: `get()`, `set(next)`, `update(fn)`. In memory. UI: `useValue(machine, key)` (null until published) |
| `scopedValue(key, initial)` | a live value per scope (a thread's id): `get(scope)`, `set(scope, next)`, `update(scope, fn)`, `delete(scope)`, `scopes()`. UI: `useValue(machine, key, { scope: thread.id })`, which hears only that scope. Use it for anything per thread |
| `view(id, { title, icon?, context, fits, default?, narrow?, order?, value \| method, about? })` | a view drawn from blocks, no UI code: see [Data-only views](window.md#data-only-views) |

### Threads

| | |
|---|---|
| `threads.list({ archived?, hidden? })` | every thread: `{ id, title, cwd, status, profile, facts, … }`; or the archived or hidden ones |
| `threads.get(id)` | one thread, archived too; `not_found` if none |
| `threads.of(conversationId)` | the thread a tool call belongs to: `threads.of(api.conversationId)` |
| `threads.conversation(id)` | its pi-durable conversation, to submit to or watch |
| `threads.attachments(id)` | the folder on this machine where a thread keeps its files. Clients read one with `file.read` by absolute path (an image with `image.read`, thumbnail or whole) |
| `threads.start({ cwd?, title?, prompt?, profile?, parent?, hidden?, options? })` | start a thread as `thread.start` does, hooks too. `parent`: a child. `hidden`: in no list, no profile, an agent of the extension's own (Ego's); find it by `owner` in `list({ hidden: true })`; it takes no messages while the extension is off. `options`: for `starting` hooks, by name |
| `threads.send(id, text, { whenBusy?, exposure?, from? })` | send a message (after its run, if working), drawn as an outlined bubble with your extension's title over it, so it doesn't read as typed by the user. `exposure`: whom for, from an action's context; `from`: the thread it's from. Both are kept, and transforms see them |
| `threads.notice(id, { text, kind?, data?, actions?, agent?, wake? })` | (API ^5.17) tell the user something in a thread without a run (`wake`, API ^5.18: and start its agent's run on it): [Notices](#notices) |
| `threads.lastAnswer(id)`, `threads.entries(id, limit?)` | its last answer as text; its newest transcript entries since last cleared, newest first (pi-durable's records: not a stable shape) |
| `threads.answering(conversationId, callId)` | how the message a tool call answers came: `{ by?, from?, exposure? }` (`{}` for a window's user). Undefined if the call isn't found. To act for the user alone, require no `by`, no `from`, and `exposure` not `outside` |
| `threads.idle(id, { signal? })` | wait until it isn't working (run ended, or needs the user); resolves to its info (as it is, if `signal` aborts) |
| `threads.noteRead(reader, read)`, `threads.parentRead(thread)` | record that `reader` read a thread as `read` (its `ThreadInfo`) said it stood (kept in memory, for its parent only, if it wasn't working); whether a thread's parent has read it as of `thread.activeAt` or later |
| `threads.archive(id, { whenIdle? })`, `threads.unarchive(id)` | `archive` resolves to `{ notes }`, each extension's hooks' notes by name. `whenIdle`: once its run ends, across restarts too, its notes then said in the thread (a thread archiving itself) |
| `threads.clear(id)` | start a thread over: run stopped, new context, transcript starting after this, panes closed |

### A thread's life and state

| | |
|---|---|
| `thread({ starting, abandoned, started, turnStart, turnEnd, stopped, blocked, archiving, archived, unarchiving, unarchiveAbandoned, unarchived })` | hooks into a thread's life: [A thread's life](lifecycle.md#a-threads-life) |
| `state<T>({ publish? })` | its own state with each thread, kept across restarts: `get(id)`, `set(id, next \| undefined)`, `update(id, edit)`. `publish: { key: '<name>.<key>', empty }` also publishes it as a scoped live value: read from the thread when a scope is first watched, updated on each change, released when unwatched. A scope reads null until read (or while the extension is off there), then `empty` for a thread with no state, else the state; a failed read is logged and stays null |
| `facts(({ id, state }) => …)` | what clients see of a thread as `thread.facts.<name>`; nothing for undefined |
| `status((threadId) => …)` | `{ kind: 'question' \| 'permission' \| 'auth', msg? }` while a thread needs the user (it shows blocked); or `{ working: 'Waiting: …' }` (API ^5.6), what its run waits on besides the user. Call `invalidate()` when its inputs change |
| `quiet(({ id, state }) => boolean)` | a thread whose runs someone else hears (thread-reports' child): its finishing or failing isn't unread or notified; needing the user still is. Worked out with its info; `invalidate()` when its inputs change |
| `recap(({ thread, answer, calls }) => …)` | a line saying what a run did (`calls`: `{ name, arguments, failed }`, oldest first), carried by its `done` status and notification. First answer wins; default: the answer's first sentence. Quick, no side effects |
| `toolCalls(({ thread, call, result }) => …)` | hear each tool call once it ends: [Watching tool calls](#watching-tool-calls) |
| `reportToolCall({ thread, call, result })` | (API ^5.20) an agent kind's: tell `toolCalls` of a call its own agent made. See [A kind of agent](#a-kind-of-agent) |
| `beforeSend(({ thread, text, attachments, content, by, exposure, from }) => …)` | rewrite what a message gives the agent before its turn. `content`: blocks so far (`{ type: 'text', text }`, `{ type: 'image', data, mimeType }`), text first; return new blocks, or nothing. `by`: the sending extension (absent for the user's); `exposure`: `outside` (an outside agent), `cli`, or what `threads.send` passed; `from`: the sending thread, or the parent for a child's prompt. Run in order, each given the last one's; a throw fails the send |

| `mention(kind, ({ ref, kind, id, thread }) => …)` | (API ^5.16) say what `@<kind>:<id>` names in a message sent: [Mentions](#mentions) |

Hooks, `state`, `facts`, `beforeSend`, `mention` and `toolCalls` skip threads that go without the extension; a profile's apply
only to its own threads.

### The agent

| | |
|---|---|
| `agent(part, { always? })` | give this profile's agents a part ([tools](tools.md)). Answers a handle: `replace(next)` swaps it (threads get it from their next request, mid-run too), `remove()`; calling it removes it, so `setup: (s) => s.agent(part)` returns its cleanup. `always: false`: only to threads `agentFor` or `agentParts` give it to |
| `agentFor(({ id, state, profile }) => …)` | choose a thread's agent: `{ instructions?, model?, thinking?, extensions?, without?, setup? }`, or nothing. First answer wins; quick, no side effects. `setup`: an agent that sets the machine up (Ego); others' `agentParts` see it |
| `agentParts(({ id, hidden, owner, profile, setup, model, thinking }) => …)` | add parts to whatever agent a thread has, at every send; every extension's add up, after `agentFor`'s and before the profile's. `profile`: `{ ref, spec }` as loaded now. Answers parts given with `agent(part, { always: false })`, or nothing. May be async, up to 5s; a throw or a late answer adds nothing that turn |
| `agentKind({ name, runner, menu?, profile?, describe? })` | (API ^5.3) a kind of agent: see [below](#a-kind-of-agent) |
| `profileKey(key, { check?, merge?, brings?, title? })` | a profile key of its own (`mcpServers` is mcp-servers'), camelCase, not the core's. `check(value)` says why a value won't do (the load fails); `merge(base, own)` for `extends` (default: own replaces); `brings(value)` names what it brings (`profile.list`'s `brings`, by `title`). Read it as `agentParts`' `profile.spec[key]` or `starting`'s `draft.profile.spec[key]`. Bundled only |

### Settings, secrets and files

| | |
|---|---|
| `settings.register({ id, title, settings, ui?, data? \| value? })` | a settings section `<name>`, keys `<name>.<key>`. `ui` names a UI-half component for it. `data` is read with each snapshot; or `value: '<name>.<key>'`, a live value given to the component as `section.data`, kept current |
| `settings.get(key)`, `settings.snapshot()`, `settings.onChange(fn)` | read any setting; all, with sections (a `value` section's as `data`); hear changes |
| `secrets.get(key)`, `secrets.onChange(key, fn)` | (API ^5.8) one of its own `secret` settings, or undefined while unset; hear it set, replaced or cleared. See [Secrets](#secrets) |
| `dir` | (API ^5.8) its folder, `<dataDir>/extensions/<name>`, made 0700 when first read: JSON files, a `node:sqlite` database, a cache. Kept through teardown, being switched off and its profile going (`superego extensions` lists orphaned ones). Ego never reads its files, so the extension's own credentials (a refresh token) may go there |
| `dataDir`, `agentsDir` | the data folder (`~/.superego`); the agents' folder (`~/.agents`, or `SUPEREGO_AGENTS`): `skills/`, `AGENTS.md` |
| `images.fit(image, limits?)` | (API ^5.12) an image (`{ data, mimeType }`, base64) fitted within `{ maxWidth, maxHeight, maxBytes, jpegQuality }` (unset: 2000×2000, 4.5 MB, 80), as the core fits what it sends a model: as it is when it fits, else scaled down and encoded again (PNG, then JPEG at falling qualities). `{ data, mimeType, resized? }`, or undefined when it can't be. On a worker |
| `loginEnv()` | (API ^5.11) the user's login shell's environment (`zsh -ilc`: their `~/.zshrc`'s keys, the PATH with mise's, Homebrew's and npm's programs), which a daemon started from the Dock lacks: `{ env }`, or `{ error }` when the shell didn't answer. Read once by the daemon; a failed read is tried again by the next to ask |

### Machines, sign-in and the rest

| | |
|---|---|
| `machines.list()`, `machines.call(machine, method, params)` | the other machines this daemon reaches (`machines.json`, with link states); call one as a client would (`thread.list`, `thread.start`), as this extension: consent actions refused. Empty when it reaches none |
| `machines.add({ label?, target?, command?, via? })`, `machines.update(id, { label?, enabled?, target?, command? })`, `machines.remove(id)` | change that list (shared with the app and `superego machines`); `add` and `update` answer the entry. Refused where the daemon reaches no other machines, and with `via` or `command` (the user's consent: Settings → Machines or their own terminal) |
| `auth.flow(context, async (flow) => …)` | a sign-in flow from an action, for the client that ran it (`auth.event`, `auth.respond`, `auth.cancel`). Answers `{ flow }` to return. `flow.emit(event)` (`auth_url` with an optional loopback `callback`, `device_code`, `info`, `progress`), `await flow.prompt({ type, message })` (`text`, `secret`, `select`, `manual_code`), `flow.signal`. Ends `done` on resolve, `failed` on throw. The window draws it with `SignInFlow` ([ui](ui.md)) |
| `extensions()` | the app's extensions here (core, bundled, windows'; not profiles'): `{ name, title?, description?, version?, optional, on, secrets? }`. `secrets`: files in the data folder an extension says hold keys (`about.secrets`), which Ego never reads |
| `app` | `{ name, id }` |
| `signal` | aborted at teardown (profile reloaded or gone, daemon stopping); (API ^5.18) its `reason.why` says which: `'stopping'`, `'reload'` or `'failed'` (its setup) |

### A kind of agent

`superego.agentKind({ name, runner, menu?, profile?, describe? })` (API ^5.3): threads whose profile says
`agent: '<name>'` (the extension's name, or `<name>.<kind>`) have every turn run by `runner`, a pi-durable task,
instead of a model. Claude Agent (`extensions/claude-agent`) is one.

- The runner reads the conversation (`runtime.context`), appends the turn's entries (`AssistantEntry`,
  `ToolResultEntry`), may stream its answer (`pi.live.generation.message`, a deferred commit), and completes with
  `{ entryId }` of its answer, or fails with why.
- The daemon owns the run: status, Stop (its `abort` handler, after `runtime.signal`), messages sent meanwhile. An
  agent that takes messages mid-turn places them with `placeSteers(tx, conversationId, runtime.settings, runtime.now())`
  (watch `InboxDoc`).
- A thread keeps its kind for life; `thread.setProfile` moves one only while it has no conversation.
- `menu()` (API ^5.6): its group in the model menus, `{ title, description?, models: [{ value, label, thinking }], unavailable? }`,
  or `{ unavailable }` saying why it isn't offered, or nothing; async up to 3s. Its models are `<name>/<model>`. Made
  the machine's default, it starts new threads only while listed available; else they're refused with `unavailable`.
- `profile: { name, make() }`: the profile a thread started on one of its models runs with, made if missing. The
  thread's model and thinking reach `agentParts` (`model`, `thinking`).
- `superego.reportToolCall({ thread, call: { id, name, args }, result: { isError, text? } })` (API ^5.20): calls the
  runner's agent makes itself, not through Superego's tool round, don't reach `toolCalls` on their own: report each as
  it ends, named as its transcript has it (Superego's names where the tool is the same, its arguments as theirs:
  `bash`'s `command`). Throws for a thread not of this extension's kinds.
- `describe({ id, model?, thinking?, profile?, state? })` (API ^5.7): what a thread runs on, where its model shows:
  `{ model, provider?, thinking?, about?, context? }` ("Claude Opus", `anthropic`, `high`, "runs your Claude Code",
  `{ tokens, max }`), as `ThreadInfo.agent`, `model`, `provider`, `thinking`, `context`. Asked as the info is made:
  keep it quick.

## Secrets

A key or token is a setting of type `secret` in the extension's section. Its value lives in the machine's secret store;
every client (the window, `superego settings`, Ego, `settings.get` over RPC, snapshots) sees only `true` or `false`.

- The user sets it in Settings (Save, Replace, Clear) or with `superego secrets set <key>` in their own terminal. That's
  a consent action (`secrets.set`), refused to a thread's shell and to every extension (`dispatch`, `machines.call`),
  here or on another machine. The action log shows `•••`, and a `validate` message never contains it.
- Secrets, like `dir`, belong to the name: two profiles' extensions of one name share them.
- A secret's key is the extension's name, a dot, then lowercase letters, digits, `.`, `_` or `-` (`mail.api-token`);
  others are refused at registration.

<!-- check: daemon; declare function connect(token: string): void -->
```ts
superego.settings.register({ id: 'mail', title: 'Mail', settings: [
  { key: 'mail.token', title: 'API token', description: 'From your mail provider’s settings.', type: { type: 'secret', placeholder: 'fmu1-…' } },
] })
const reconnect = async () => { const token = await superego.secrets.get('mail.token'); if (token) connect(token) }
superego.secrets.onChange('mail.token', () => void reconnect())
void reconnect()
```

| Where | Store |
|---|---|
| macOS | the login keychain (`security`): a generic password, service `superego-secrets-<hash of the data folder>`, account the key |
| Linux with a Secret Service | `secret-tool` (GNOME Keyring, KWallet) |
| neither, or `SUPEREGO_SECRETS=file` | AES-256-GCM, each value bound to its key, in `~/.superego/secrets.json`, key in `~/.superego/secrets.key`, both 0600 |

`secrets.json` also records which keys are set and where, so a snapshot never asks the keychain. Settings shows where
each is kept.

It keeps tokens out of settings, snapshots, `superego settings`, the data folder as Ego reads it, transcripts and logs.
It isn't a vault: code running as the user can read the keychain (`security find-generic-password`) or the key file,
and an allowed project profile has that reach.

A key in a `string` setting is plain text everywhere (a string's `secret: true` is gone; such a setting is refused).
Change its type to `secret` under the same key: the value moves into the store at the next setup.

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

**Data for a pane:** the pane calls a method with the thread's id; the method returns JSON. Keep actions for changes.
See [ui](ui.md).

**Waiting on the user** (as `agent-ui` does): a tool stores a resolver in a `Map`, publishes the question as a live
value, and contributes `status` so the thread shows blocked; an action (`<name>.answer`) resolves it. Mark the tool
`replay: 'safe'` so a restart asks again.

## Mentions

(API ^5.16) `superego.mention(kind, resolve)` says what a mention of yours names, once a message with one is sent
(`@note:roadmap`, `@canvas:"Fox & Rhino"`: your UI half offers them, `composer.mention`, [ui.md](ui.md#mentions)).
The bundled Mentions extension asks `resolve` with `{ ref, kind, id, thread }` (the id unquoted) and tells the agent
in the block that goes with the message, a line each: `<ref> is a <kind>: <what resolve said>`. Say what it is and how
to read it, in a line; nothing inlined. Answer `undefined` for one that names nothing: it stays as typed, and isn't
drawn as a link. Each answer gets 2s: a slower one, or a throw, counts as nothing (logged), and never holds up the
send. `kind` is lowercase letters, digits and dashes, one resolver per kind (not `thread`, `file` or `folder`).
`mentionResolver(kind, thread)` finds the resolver a thread has, for an extension that reads mentions itself.

```ts
import { defineDaemonExtension } from 'superego'

export default defineDaemonExtension({
  name: 'notes', api: '^5.16',
  setup(superego) {
    superego.mention('note', async ({ id }) => {
      const note = await fetch(`http://localhost:4000/notes/${encodeURIComponent(id)}`).then((r) => r.ok ? r.json() as Promise<{ title: string }> : undefined)
      return note && `${JSON.stringify(note.title)}. Read it with note_read (slug: ${JSON.stringify(id)}).`
    })
  },
})
```

## Notices

(API ^5.17) `superego.threads.notice(id, notice)` tells the user something in a thread without starting a run: checks
failed, a reminder came due, a process exited. It's an entry in the transcript under your extension's title, which
makes the thread unread and notifies as a finished run does, `text` saying why (the thread's status line and the
notification). The agent is told it with its next turn, as context rather than the user's words (`<notice from="…">`):
at once when the thread is idle, else where its run can next take it, which is also when it shows.

| | |
|---|---|
| `text` | what it says: Markdown, a line or a few |
| `kind`, `data` | drawn by your UI half's `entry(kind, component)` (its `entry.data` is `data`) instead of as text |
| `actions` | buttons under it: `{ label, send }` sends the thread `send` as the user's message ("Fix it"); `{ label, action, params? }` dispatches an action on the thread's machine ("Restart"). `style`: `'primary'` or `'danger'`. One that fails says so on the notice |
| `agent` | what the agent is told instead of `text`; `false`, nothing |
| `wake` | (API ^5.18) the agent acts on it: a run starts on it (after the one going), as a message would, with no message beside it |

To wake the agent as well, give it `wake: true` (API ^5.18): its run starts on the notice (Processes' reports do).
An archived thread refuses a notice (`archived`).

<!-- check: module -->
```ts
import { defineAction, defineDaemonExtension, obj, str } from 'superego'

export default defineDaemonExtension({
  name: 'deploys', title: 'Deploys', api: '^5.17',
  setup(superego) {
    superego.action(defineAction({
      id: 'deploys.failed', title: 'Say a deploy failed', runs: 'machine', expose: ['cli'], params: obj({ thread: str(), log: str() }),
      async run({ thread, log }) {
        await superego.threads.notice(thread, {
          text: 'The deploy **failed**.', agent: `The deploy failed. Its log ends:\n${log}`,
          actions: [{ label: 'Fix it', send: 'The deploy failed: find out why and fix it.', style: 'primary' }],
        })
        return null
      },
    }))
  },
})
```

## Processes

(API ^5.18) The bundled Processes extension runs commands that outlive the daemon, and shows them in the Processes
pane; call it with `superego.dispatch` (actions) and `superego.call` (methods). A process belongs to a thread
(`{ thread }`, stopped as it's archived), a folder (`{ folder }`, shared by the threads there, stopped with the last
of them; Run's dev command is one) or the machine (`{ machine: true }`). Each answers a `ProcessInfo`
(`@superego/processes/shared`): `id`, `name`, `owner`, `command`, `cwd`, `state` (`idle`, `starting`, `running`,
`stopping`, `exited`, `failed`, `lost`), `pid`, `run` (how many times it ran), `exitCode`, `error`, …

| | |
|---|---|
| `processes.start` | start one: `command`, and whose it is (`thread`, `folder` or `owner`); `name` (unique among its owner's), `cwd` (relative to the thread's folder, or the folder), `env`, `ready` (text or `/regex/` in its output that says it's up: `starting` till then), `grace` (ms between SIGTERM and SIGKILL), `notify` (`exit`, `failure`, `never`: when its owner thread is woken by its end; a folder's wakes the thread last active there), `restart: 'on-failure'`, `keep` (started again after the machine restarts, if it was running). One of that name running: `ifRunning` `'error'` (`busy`), `'keep'` or `'restart'` |
| `processes.define` | the same, without starting it: an idle one to start later, or a known one's next run changed |
| `processes.restart`, `processes.stop`, `processes.remove` | by `id`, or `name` and its owner; `remove` forgets one that ended, and its output |
| `processes.list` | `{ thread }` (its own and its folder's), `{ folder }` or `{ all: true }`: `ProcessInfo[]` |
| `processes.read` | `{ id, since?, lines?, plain? }`: its output (ANSI colours kept unless `plain`) from a byte position, or its last `lines`: `{ text, from, end, start, first }` |
| `processes.wait` | `{ id, for, timeout }`: `for` is `'ready'`, `'exit'`, or text or `/regex/` in this run's output; `timeout` in seconds (600 at most): `{ outcome: 'matched' \| 'ready' \| 'exited' \| 'timeout', process, tail }` |

<!-- check: daemon -->
```ts
const dev = await superego.dispatch('processes.start', {
  folder: '/src/app', name: 'preview', command: 'npm run preview', ready: 'Local:', notify: 'failure', ifRunning: 'keep',
}) as { id: string }
await superego.call('processes.wait', { id: dev.id, for: 'ready', timeout: 60 })
```

## Watching tool calls

`superego.toolCalls(fn)` calls `fn({ thread, call: { id, name, args }, result: { isError, text? } })` after each tool
call, errors too (`text`: what the model was told). It only watches: the run doesn't wait, and a throw is logged. It
hears a Claude Agent thread's calls too, Claude Code's own included, named as Superego's where they're the same tool
(`bash` with its `command`, `read`, `edit` and `write` with their `path`; their other arguments Claude Code's: an
`edit`'s are `old_string` and `new_string`); its other tools by Claude Code's names (`Grep`, `Skill`, `Agent`). This
one marks threads that ran `sqlite3`, for the [sidebar mark in ui.md](ui.md#a-mark-in-the-sidebar):

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
