# A thread that runs the user's Claude Code: proof and design

2026-11-20. A design; waves 1 to 3 (§4) are built. The terms behind it are in
[claude-subscriptions.md](claude-subscriptions.md), whose §3(a) this builds on. **This is not legal advice.**

The idea: an opt-in second agent kind for threads. The thread runs the user's own installed, unmodified `claude`
through the TypeScript Agent SDK, signed in by the user with Claude Code's own `/login`. Superego never sees, stores
or passes on a Claude credential. Everything else stays Superego's: the transcript, status, panes, notifications,
phone and web access, and remote machines.

---

## 1. What the proof of concept showed (2026-11-20, this Mac)

The scratch files are outside the repo, in `~/scratch/claude-code-poc/`: `poc.mjs`, `mock-anthropic.mjs`, a
`README.md` and the logs of each run.

**Setup:**
- `claude` 2.1.325, installed with mise at `~/.local/share/mise/installs/claude/latest/claude`.
- `@anthropic-ai/claude-agent-sdk` 0.3.323, installed in the scratch folder through npm's default registry. It pulls
  in a per-platform package holding its own `claude`, 2.1.323.
- `query()` with `pathToClaudeCodeExecutable` pointing at the user's binary, `includePartialMessages: true`,
  `permissionMode: 'default'`, `settingSources: []`, a `canUseTool` that logs and allows, and
  `mcpServers: { superego: { type: 'stdio', command: 'superego', args: ['mcp'] } }`.
- The system prompt is the `claude_code` preset, with a line appended.

**`claude` isn't signed in to a Claude plan on this Mac.**
- `env -u ANTHROPIC_API_KEY claude auth status` says `"loggedIn": false, "authMethod": "none"`.
- The only credential Claude Code finds is the `ANTHROPIC_API_KEY` in this shell's environment
  (`"authMethod": "api_key", "apiKeySource": "ANTHROPIC_API_KEY"`).
- As the brief asked, I didn't sign in, and I ran **no turns on the plan, nor on that API key**.

To prove the mechanics without a sign-in or any spending, the turns ran against `mock-anthropic.mjs`. It's a scripted
stand-in for the Messages API, which the unmodified `claude` reached through `ANTHROPIC_BASE_URL` with a dummy key.
Everything on Superego's side of the process boundary is the same either way. What the mock can't show is listed under
"Not proven".

| Capability | Result |
|---|---|
| **The user's binary, not the SDK's** | Worked. `system:init` reported `claude_code_version=2.1.325`, the user's install, not the SDK's bundled 2.1.323. |
| **Not signed in, against the real API** | Fails cleanly and costs nothing. `init` still arrives, with `apiKeySource: "none"` and the MCP tools listed. Then a `result` arrives with `subtype: "success"` but `is_error: true` and the text `"Not logged in · Please run /login"`, and the SDK's iterator throws `Claude Code returned an error result: Not logged in · Please run /login`. (`poc-real-init.log`) |
| **Streaming events** | Worked. Each turn gave `system:init`, `system:status`, `stream_event` (`message_start`, `content_block_start`, several `content_block_delta` `text_delta`s, `content_block_stop`, `message_delta`, `message_stop`), one `assistant` per model message, `user` carrying tool results, and `result`. |
| **Superego's tools over MCP** | Worked. `init.mcp_servers` showed `superego` as `connected`, and the 11 tools of `superego mcp` were listed as `mcp__superego__*`: `ego_ask`, `pane_open`, `profile_list`, `thread_archive`, `thread_list`, `thread_read`, `thread_rename`, `thread_send`, `thread_start`, `thread_stop`, `thread_unarchive`. A real call to `mcp__superego__thread_list` returned this machine's threads. **MCP tools are deferred:** the request carried only 13 tools (Agent, Bash, Edit, Read, ToolSearch, …), so the model first called `ToolSearch` with `select:mcp__superego__thread_list` to load the tool, and then called it. |
| **`canUseTool` asked for a permission** | Worked. It was called once, for `mcp__superego__thread_list` with `{}`. It wasn't called for `ToolSearch`, which Claude Code allows by itself. |
| **Resuming by `session_id`** | Worked. Three `query()` calls, the second and third with `resume: <first session_id>`, all reported the same `session_id`, and the history sent to the API grew from 2 to 11 to 14 messages. Claude Code keeps the session in `~/.claude/projects/<cwd as a slug>/<session_id>.jsonl` on the machine it ran on. |
| **Raw CLI instead** | Worked. `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` gives the same event types (`poc-cli-run.log`). |
| **Start-up cost** | About 250 ms from `query()` to `init` for each turn, because each `query()` spawns a new `claude` process, plus the MCP server's start. |

**Not proven** (each needs a signed-in `claude` and a few real turns on the plan):
- that a plan sign-in drives the SDK. Anthropic's support article says it does, and T3 Code, Conductor and Cline rely
  on it;
- the real model's behaviour with deferred MCP tools: whether it finds Superego's tools without being told;
- `rate_limit_event` messages, and what plan rate limits and errors look like;
- `interrupt()`, a denied permission, `AskUserQuestion`, and a long-lived process fed by streaming input.

**One finding to act on:** Claude Code takes `ANTHROPIC_API_KEY` from its environment ahead of the plan sign-in. A
daemon started from a shell that has one would silently bill the API, not the plan. Superego has to give the child an
environment without Anthropic credentials (§3.2), and show which one Claude Code used: `init.apiKeySource`, and
`claude auth status`'s `authMethod`.

---

## 2. Picking it

- **On a profile:** `agent: 'claude-agent'`. A thread started with that profile is a Claude Agent thread for its whole
  life, as Amp does it. Profiles can also set its options (§3.4, §3.5): `claudeAgent: { permissionMode, allowedTools,
  disallowedTools, settingSources, model, effort }`.
- **In the model menu:** a group named "Claude Agent", showing Claude Code's own model aliases (`opus`, `sonnet`,
  `haiku`) and effort levels. Its description: "Runs your Claude Code on <machine>". The group appears only when
  `claude` is installed on that machine; when it isn't signed in, the group shows that, with the fix (§3.6).
- **Fixed per thread.** Changing a thread's model within the group is fine, through `setModel()` or the next turn's
  `model`. Moving a thread between pi and Claude Agent isn't offered: the two keep different histories. A later wave
  could fork a pi thread into a new Claude Agent thread with a summary.
- **Off by default.** It's a setting, "Claude Agent threads", on each machine, until Anthropic answers §7.

**As built (wave 3, 2026-11-20): one mechanism, the profile.**
- A profile's `agent: 'claude-agent'` is what makes a thread a Claude Agent thread, as before. The model menu's group
  is a way to pick such a profile: the extension's `agentKind` gives a `menu()` (its group in `agent.models`, as
  `ModelCatalog.agents`: `claude-agent/opus`, `sonnet`, `haiku`, with effort levels as thinking) and a `profile`
  (`claude`, the one first-run setup makes, made then if it isn't there). `thread.start` with one of its models and no
  profile named starts with that profile; with a profile of another kind it's refused, saying so, and so is a
  Superego model with a Claude Agent profile. The thread keeps its model (`claude-agent/sonnet`) and thinking as its
  own, and the turn passes them as `model` and `effort` (a profile's `claudeAgent.model` and `effort` otherwise).
- The New thread dialog shows the group between the favourites and the providers, "Claude Agent · Runs your Claude
  Code" ("on <machine>" for another machine); picking one of its models picks its profile (listed before it's made),
  and a Claude Agent profile picked offers only its models. Signed out, the group says "Not signed in: run claude, then
  /login" and its models can't be picked.
- Moving a thread: `thread.setProfile` moves a thread between kinds only while it has no conversation (no entry the
  agent saw since it was last started over), and drops its own model then; after that it's refused: "This thread runs
  on Superego's own agent, and the claude profile on Claude Agent: a thread can't move between them once it has a
  conversation, as each keeps its own." There's no model menu on a thread yet (only the New thread dialog's).
- The "Claude Agent threads" switch wasn't added: it's off until a thread is started on it (a profile, or its group in
  the menu), and the extension has Settings → Extensions' switch.

## 3. Shape

### 3.1 Where it lives

A bundled extension, `extensions/claude-agent`, with a daemon half and a small UI half, like `agent-ui`. It owns the
agent kind, the Settings section and the transcript entries. The daemon core gains only what any second agent kind
needs: a thread's `agent`, and a way for an extension to run a thread's turns. Superego's `pi` threads are unaffected.

### 3.2 The process, and who owns it

- **A durable task per turn** (`defineTask`, `claude-agent.turn`) owns one `query()`. Running inside the thread's
  pi-durable conversation keeps the thread's model: `run` present means working; Stop aborts the task; a daemon
  restart restarts the task.
  - **The seam (wave 1 spike, 2026-11-20).** pi-durable hard-wires runs to its `GenerationTask`: `startRun` creates
    one for every input, and only `pi.generation` may own `pi.live.run`. An extension's task can't own a run without a
    change to pi-durable, so it got one, in `patches/@earendil-works__pi-durable@1.6.0.patch` (upstream:
    github.com/earendil-works/pi, `packages/durable`, offered there as `docs/research/pi-durable-runner-upstream.md`):
    - `AgentState.runner`: the name of an installed task that runs each turn instead of a model request
      (`configure({ runner })`, or `createConversation({ agent: { runner } })`).
    - The generation's `prepare` sees it and *delegates*: it creates the runner as a child it owns and waits
      (a new `delegate` phase; `GenerationTask` version 4 on pi 1.6). When the runner completes with its answer's entry
      (`{ entryId }`), the run ends as for a model's final answer (inputs settled, boundaries, queued messages,
      `afterRun`); when it fails, the run fails `model_error` with its message.
    - So pi-durable keeps everything about the run: `pi.live.run` means working, Stop (`Conversation.abort()`)
      cascades to the runner and ends the run `aborted`, a partial the runner published as
      `pi.live.generation.message` becomes an aborted entry, messages sent meanwhile queue and start the next run.
    - The runner only appends the turn's entries (`AssistantEntry`, `ToolResultEntry`) and publishes its partial.
    - Proven with a fake runner (`packages/daemon/test/runner-seam.test.ts`): a turn, streaming, a tool call and
      result, the answer, and Stop.
  - **In the daemon:** a profile's `agent` (`'claude-agent'`) is kept on the thread at its start (`ThreadMeta.agent`),
    for its whole life. An extension offers a kind with `superego.agentKind({ name, runner })` (extension API 5.3);
    the daemon sets the thread's runner at its start and each send, and needs no model of Superego's for it. A kind
    that isn't on here refuses the thread's start, or a send.
  - The lockfile (the patch, the SDK) was recorded on a machine that reaches registry.npmjs.org: this Mac couldn't.
- **One process per turn at first**, then one per active thread. Wave 1 calls `query({ prompt, options: { resume } })`
  for each user message, which is simple and survives restarts, at ~250 ms per turn. Wave 4 keeps one `query()` per
  active thread, fed by an `AsyncIterable` of user messages (streaming input), so a message sent mid-turn reaches
  Claude Code as it does in its own TUI. That process closes after a few idle minutes.
- **Restarts.** The thread keeps Claude Code's `session_id`, in a doc of the extension's own. A turn cut off by a
  restart or crash is resumed from it. The turn's lost partial text isn't replayed: the turn shows as interrupted,
  saying so, and the user sends again. Claude Code's own `.jsonl` is the source of truth for the conversation;
  Superego's entries are its mirror (§5).
- **The binary.**
  - `pathToClaudeCodeExecutable` comes from a setting, by default `claude` found on the machine's login shell's
    `PATH` (mise, Homebrew and npm installs differ).
  - The SDK's bundled binaries aren't installed: `pnpm.overrides` remove them, as T3 Code does, so Superego never
    ships Claude Code.
  - Superego doesn't install or update `claude`.
- **The environment.**
  - The child gets the daemon's environment minus every Anthropic and Claude Code credential:
    - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_OAUTH_TOKEN`;
    - `CLAUDE_CODE_OAUTH_TOKEN`;
    - `ANTHROPIC_BASE_URL`;
    - Bedrock and Vertex switches.
  - So Claude Code uses its own sign-in, and the thread can't bill something the user didn't pick.
  - A profile may opt in to passing them (`claudeAgent: { env: 'inherit' }`), for API-key or plan-credit users.
  - The transcript's first row says which auth Claude Code reported (`init.apiKeySource`).
- **Identity.** Superego doesn't set `CLAUDE_CODE_ENTRYPOINT`, a user agent or anything else that changes how
  Claude Code describes itself. T3 Code sets `CLAUDE_CODE_ENTRYPOINT=t3-code`, which reportedly changes how headless
  use is counted (claude-subscriptions.md §0). Ask Anthropic before doing the same (§7).
- **Stopping.**
  - Stop calls `interrupt()` and then aborts the `AbortController`.
  - Archiving or deleting the thread ends its process.
  - The process runs in its own process group (`process-group.ts`), so nothing outlives the daemon.
- **How many at once.** A per-machine cap on Claude Agent turns running at once, defaulting to 3 (Settings → Claude
  Agent, "Threads at once"). Turns over the cap wait, oldest first, as `working`, their status saying "Waiting: 3
  Claude Agent threads are running" (a status contribution's `{ working }`, `Status.msg` while working, shown in the
  transcript's working row and the thread's card). A turn takes its place before it starts `claude` and keeps it to
  its end (waiting on an approval too); Stop while it waits leaves the queue. This keeps background use nearer the
  "ordinary, individual usage" the plans assume.

### 3.3 Events into the transcript

Claude Code's messages become entries of the thread's conversation, so the existing transcript, recaps, search and
unread logic apply. Where they fit pi-durable's own entries (`UserEntry`, `AssistantEntry`, `ToolResultEntry`), they
use those, so the transcript's tool rows (Read, Edit, Bash…) render them unchanged.

| Claude Code message | In Superego |
|---|---|
| `system:init` | The thread's facts: Claude Code's version, model, permission mode, auth source, MCP servers and their status (a failed `superego` server is an error row). Kept, not shown as a row. |
| `stream_event` `text_delta` / `thinking_delta` | The live streaming text of the current assistant row, published as the turn's live state (like pi's partial message). |
| `assistant` | An `AssistantEntry`: text, thinking and `tool_use` blocks, converted to pi-ai's message shape (`toolCall` with id, name and arguments). |
| `user` with `tool_result` | A `ToolResultEntry` per result, matched by `tool_use_id`. |
| `user` (replayed prompt) | Already there: the user's own message was appended when it was sent. |
| `system:status`, `tool_progress`, `api_retry` | Live state only: "Retrying (2/10)…", a tool's progress. |
| A subagent's `assistant` / `user` (`parent_tool_use_id` set), `task_notification` | Steps under its `Agent` call's row (built in wave 2, §3.4's end). |
| `compact_boundary` | A row saying Claude Code compacted the conversation. |
| `rate_limit_event` | `allowed_warning`: a note on the thread. `rejected`: the turn ends as an error saying when the limit resets (`resetsAt`). |
| `result` `success` | The turn ends: the thread is done. `total_cost_usd`, usage and `num_turns` go into the thread's usage (shown as an estimate, since a plan isn't billed per token). |
| `result` with `is_error: true`, or another `error_*` subtype | The turn fails with Claude Code's text. "Not logged in · Please run /login" maps to the sign-in state (§3.6), not a plain error. |
| The SDK iterator throws, or the process exits | The turn fails with the message and the process's last stderr lines. |

### 3.4 Approvals into blocked status

- `canUseTool(toolName, input, { signal, suggestions })` adds a waiting item to the thread. A status provider, like
  agent-ui's `superego.status`, makes the thread `blocked` with `kind: 'permission'` and a `msg` such as
  `Bash: npm test`. It then shows as "Permission" everywhere: the rail, the menu bar, notifications, the phone.
- The waiting item renders in the transcript with Allow, Deny and, when Claude Code offers `suggestions`, "Always
  allow …". The answer goes back as `{ behavior: 'allow', updatedInput, updatedPermissions? }` or
  `{ behavior: 'deny', message }`.
- If the turn is stopped, the `signal` withdraws the item.
- `AskUserQuestion` comes through `canUseTool` too. It's shown with agent-ui's question UI (`kind: 'question'`), and
  the answer is returned as Claude Code expects.
- `ExitPlanMode` shows the plan, with "Approve plan" or "Keep planning".
- Profiles pick `permissionMode` (`default`, `acceptEdits`, `plan`, `auto`). `bypassPermissions` is only allowed when
  the profile says so explicitly. Approvals made with "always" are Claude Code's own (its local settings), not
  Superego's.
- The waiting items live in a doc, so a restart shows them again. A restarted process can't answer an old request,
  though: after a restart, a waiting approval becomes "Interrupted: send again".

**As built (wave 2, 2026-11-20).**
- The waiting items are claude-agent's own (`claude-agent.waiting`, a scoped value by thread, oldest first), answered by
  `claude-agent.answer` (`allow`, `always`, `deny` with a message) from the card above the composer. ⌃1–⌃3 pick, as for
  agent-ui's questions (its `keyMove`); what's typed denies, saying why or what to do instead. The thread's status is
  `blocked`, `kind: 'permission'`, `msg` like `Bash: npm test`.
- Each tool call gets its row (its entry, and a live slot while it runs) as Claude Code makes it, so an approval shows
  under the call it's for; what asks about a call waits for its row (5 s at most).
- "Always allow …" is offered when `suggestions` come, labelled from them (`Always allow Bash(npm test *)`), and
  answered with them as `updatedPermissions`. Claude Code would keep its rules in the folder's own settings
  (`.claude/settings.local.json`), which load only once the user allowed them as they are (and would change by it): so
  Superego keeps the tool rules itself, by folder (`always-allowed.json` in its data folder), passes them each turn as
  `allowedTools`, and has Claude Code apply the folder-bound updates for the session only.
- `AskUserQuestion` runs the thread's own agent-ui `ask_user` (the same tool as a Superego thread's, through §3.5's
  tool runner), one question at a time, and answers `{ ...input, answers: { [question]: label } }`. Several picks are
  typed, comma-separated.
- `ExitPlanMode`: Claude Code reads the plan from its plan file and puts it in the input it asks about (`plan`); the
  card shows it, with "Approve plan" (allow, leaving plan mode) and "Keep planning" (deny, with what was typed).
- Superego's own MCP tools are allowed in `canUseTool` (by `mcpServer.source === 'sdk'`), not by `allowedTools`, which
  would shadow the callback for them.
- A profile's `claudeAgent`: `permissionMode` (unset: `default`, passed explicitly, so Claude Code's own
  `defaultMode` doesn't apply; `bypassPermissions` only when the profile says it, with
  `allowDangerouslySkipPermissions`), `settingSources` (narrowing what may load: `user`, and the folder's `project` and `local` once allowed),
  `allowedTools`, `disallowedTools`.
- Stop withdraws what waits and closes its call ("Stopped"). A restart closes the turn's open calls with
  "Interrupted: … Send again to go on." **Found while building it:** a clean daemon stop doesn't count in a task's
  `restarts` (only crashes do), so wave 1 would have run an interrupted turn again; the turn now leaves a memo as it
  starts, and a turn that finds it is the interrupted one.
- **Subagents.** Claude Code 2.1.325 runs `Agent` calls in the background: the call's result ("Async agent launched")
  comes first, the subagent's messages after it, then a `task_notification`. So a subagent's steps (its text, its
  calls and their results, cut to 2,000 characters each) are kept with the thread, by the `Agent` call
  (`claude-agent.subagents`, published from the extension's thread state, the newest 20), and its row draws them with
  the app's own rows (`ToolSteps`, from `superego/unstable`), saying whether it's still running.

### 3.5 Superego's tools over MCP

- **In-process, bound to the thread.** Instead of spawning `superego mcp`, which works but doesn't know which thread
  is calling, the extension passes an SDK MCP server (`createSdkMcpServer`) built from the same exposed-action table
  as `packages/cli/src/mcp.ts`, with the calling thread filled in. Then `thread_start` starts a child of *this* thread,
  `pane_open` opens beside it, and reports come back to it.
- **Agent tools as MCP tools.** `ask_user`, `ask_ui`, `show_ui`, `open_ui`/`update_ui`, `show_images` and the task
  tools are pi-durable tools today. Wave 2 exposes those that make sense as MCP tools on the same server. Waiting ones
  use the same waiting items as approvals. Others stay pi-only at first (§4).
- **Deferred loading.** MCP tools reach the model through `ToolSearch`. The appended prompt names Superego's tools in
  a line each, so the model knows to load them.
- **The prompt.** `systemPrompt: { type: 'preset', preset: 'claude_code', append }`, where `append` holds what Superego
  says about itself: panes, threads, blocks, and the profile's instructions. This keeps Claude Code's own prompt (and
  its safety instructions), as T3 Code does; Cline instead drops the preset.
- **Settings sources.** By default `['user', 'project', 'local']`, so the user's `CLAUDE.md`, skills, hooks and MCP
  servers apply, as in their own Claude Code. A profile can narrow it.
- **The user's MCP servers.** A Superego profile's `mcpServers` (the `mcp-servers` extension) can be passed along as
  `mcpServers` entries. Secrets stay on the machine, in the child's config, not in the prompt.

**As built (wave 2, 2026-11-20): the thread's own tools, not the outside-action table.** The table `superego mcp`
serves is for agents outside any thread: `thread.start` from it is gated on a setting and makes no child, `thread.send`
signs nothing, nothing notes what was read. A Claude Agent thread is a Superego thread, so it gets what a Superego
thread's agent has: the tools of its agent (`runtime.agent()`'s, as its extensions and profile give them), run by the
turn through a small tool runner (`tools.ts`: the call's id is Claude Code's `tool_use` id, from
`_meta['claudecode/toolUseId']`; arguments checked against the tool's schema; `details` kept for the call's row). So
`thread_start` makes a child of this thread (and its report comes back), `thread_send` signs "From [this thread]",
`pane_open` opens beside it and checks the kinds, `ask_user`/`ask_ui` wait in agent-ui's queue, and the rows draw as a
Superego thread's (`mcp__superego__x` is named `x` in the transcript).
- **Offered:** `thread_start`, `thread_read`, `thread_send`, `thread_list`, `thread_machines`, `thread_archive`,
  `pane_open`, `ask_user`, `ask_ui`, `show_ui`, `open_ui`, `update_ui`, `show_images`, `task_start`, `task_finish`.
- **Pi-only, and why:** the coding tools (Claude Code has its own); skills (it reads its own `.claude/skills`, and
  gets Superego's own as a plugin, below);
  AGENTS.md (it reads `CLAUDE.md`); the MCP servers of Settings and profiles (passing them on is later work); Ego's
  setup tools (Ego's thread isn't a Claude Agent one); any other extension's tools, which may need what the runner
  doesn't give (nested calls, tasks, memos: refused, saying so), and every extension's hooks, which don't run in
  Claude Code's loop.
- **The appended prompt:** a line saying it's a Superego thread; `<superego_tools>` naming the server, how to load a tool
  (`select:mcp__superego__<name>`), and each tool's first sentence; then the sections a Superego thread renders, as it
  renders them: `markdown`, `where`, `panes`, `threads`, `ui_blocks`, `images`, `task_reporting`, and the profile's
  `instructions` last.
- **The binary:** `SUPEREGO_CLAUDE` names one; else the login shell's `claude`, as before. (Settings → Claude Agent is
  wave 3.)

**The `superego` skill and command line (2026-11-20).** A Claude Agent thread's Claude Code has Superego's own skill
and knows which thread its `superego` calls come from, as a Superego thread does:
- **The skill as a plugin of the daemon's.** The SDK's `plugins` (`{ type: 'local', path }`, passed as
  `--plugin-dir`) loads a plugin for the session alone. The daemon makes one as it starts,
  `<dataDir>/claude-agent/plugin` (`.claude-plugin/plugin.json` named `superego`, and `skills/superego` linking the
  skill folder of the build it runs, `out/skill`), so Claude Code lists `superego:superego` beside the user's own
  skills. Nothing is written to `~/.claude` or to `.claude/skills` in the thread's folder (`settingSources` still
  reads the user's own). The app passes the folder in (`claudeAgent({ skills: [SKILL_DIR] })`), as it does the skills
  extension's.
- **The calling thread.** Claude Code's environment carries `SUPEREGO_THREAD=<thread id>` (`threadEnv`), as every
  Superego thread's shell does, so `superego` run from its Bash says so in hello (`from`): it's refused the user's
  consent, and what it sends or starts is that thread's (`superego send` and `superego start`'s first message signed
  from it). `superego start` doesn't make a child (as from a pi thread's shell); `superego do thread.start --parent
  "$SUPEREGO_THREAD"` does. The rest of what the CLI needs to reach the daemon (`SUPEREGO_HOME`, `SUPEREGO_SOCKET`
  when set) comes with the daemon's own environment, as for a pi thread. The thread id is no secret.
- **The prompt** gains a `<superego_cli>` line: the command line works from Bash for scripting, signed as this thread,
  the skill says how, and the MCP tools stay the way to reach the user (questions, panes, UI).

### 3.6 Remote machines and sign-in

- A thread runs on its machine's daemon, so Claude Code runs there, signed in there. Nothing about it crosses
  machines except the transcript.
- **Checking.** An action, `claude-agent.check`, runs `claude --version` and `claude auth status` on the machine, with
  the scrubbed environment. It keeps only `loggedIn`, `authMethod` and `subscriptionType`, never anything else from
  its output. Superego never reads Claude Code's keychain entry or `~/.claude` credentials.
- **Settings → Claude Agent**, per machine, shows:
  - "Claude Code 2.1.325, signed in with your Claude plan";
  - or "Not signed in: run `claude` on <machine> and type `/login`", with a button that opens a terminal pane on that
    machine running `claude`, where the user signs in through Anthropic's own flow;
  - or "Not installed: see code.claude.com". Superego doesn't install it.
- A turn that fails as not logged in puts the thread in the sign-in state (`kind: 'auth'`), with that same message.
  It goes on once a check passes, as threads waiting on a provider do now.
- **As built (wave 3).** `claude-agent.check` runs `claude --version` and `claude auth status --json` with the
  scrubbed environment and keeps `loggedIn`, `authMethod` and `subscriptionType` (shown as "Signed in with your Claude
  Max plan"), published as the live value `claude-agent.claude` for Settings: looked at as the daemon starts, as
  Settings shows it ("Check again"), and behind the model menu when it's over a minute old. Settings → Claude Agent
  shows it under the machine's two settings (permission mode, threads at once); signed out, "Run `claude` and `/login`
  in a terminal." and **Open a terminal**, which opens a terminal pane beside the thread shown (else the machine's
  newest) running that machine's `claude`, for the user to sign in in Claude Code's own flow. The terminal extension
  gained `terminal.run` for it: a window's action only (not the command line's or an outside agent's), the program
  kept in the daemon's memory, never in the pane's params an agent could set.
- **Remote machines (wave 3).** Everything above is the machine's daemon's: its `claude`, its check, its plugin, its
  MCP server and its sessions; the window reaches it as any machine's actions. Tested with a hub daemon reaching a box
  daemon over a `via` pipe (`extensions/claude-agent/test/remote.test.ts`): the box's thread runs the box's `claude`,
  Superego's tools answer for the box's thread, the skill plugin is the box's, and the hub's `claude` is only checked.
  A turn that fails as not logged in still fails with "Not logged in · run `claude` and `/login`"; the `kind: 'auth'`
  state above is still to do.
- **Plan limits.** `Query.usage()` (experimental) returns the plan's 5-hour and 7-day utilisation. Showing it is
  tempting, but it's near the SDK note's "offer … rate limits", so leave it out until Anthropic answers (§7). Show
  rate-limit errors when they happen, with Claude Code's reset time.

### 3.7 What a Claude Agent thread loses next to a pi thread

| Kept | Lost or different |
|---|---|
| Transcript, streaming, recaps, unread, notifications, phone and web, worktrees, panes, forking the Superego thread (not the Claude session) | **Extensions' agent parts**: tools, prompt sections and hooks from pi-durable extensions don't run in Claude Code's loop. Only what's offered over MCP or appended to the prompt reaches it. Skills come from Claude Code's own `.claude/skills`, not Superego's. |
| Superego's actions as MCP tools; approvals and questions as blocked status | **Model choice**: Claude models only, through Claude Code; no GPT. Thinking is Claude Code's `effort`. No fast mode. |
| Profiles: instructions (appended), permission mode, tool lists, MCP servers | **Compaction and context** are Claude Code's own. Superego's compaction policy, prompt sections and context meter don't apply (`getContextUsage()` could feed the meter later). |
| `CLAUDE.md`, hooks and skills from `.claude/`, a plus for Claude Code users | **Durability**: Claude Code's `.jsonl` on that machine is the conversation. Superego's entries mirror it. A crash mid-tool is resumed by Claude Code, not replayed by pi-durable. Moving or archiving a thread to another machine doesn't carry the session. |
| Remote machines, where `claude` is installed and signed in there | **Editing history** (rewind, edit a message) works only as Claude Code's `forkSession`/`resumeSessionAt` allow; ship without it. |
| | **Cost display**: an estimate, not a bill. Plan usage isn't shown (§3.6). |
| | **Headless rate**: a user-measured bug says headless use counts ~1.8× against the 5-hour window (claude-subscriptions.md §0). Unconfirmed, but users may notice. |

### 3.8 Naming

The Agent SDK's branding rules allow "Claude Agent", or "Claude" in a menu labelled "Agents". The legal page allows
saying, in plain text, that a product "runs Claude Code".

- **Use:** "Claude Agent" for the agent kind, the model-menu group, the Settings section and the profile value
  (`agent: 'claude-agent'`). In descriptions, "Runs your Claude Code".
- **Don't use:** "Claude Code" as the name of a Superego feature, setting or thread kind; Claude or Anthropic logos;
  Claude Code's ASCII art or look; anything suggesting Anthropic built, endorses or partners with Superego.
- **No sign-in button labelled for Claude.** The only sign-in path is "run `claude` and `/login`", in the user's own
  terminal.

## 4. Waves

0. **Done (2026-11-20).**
   - §4b closed: Superego refuses Claude subscription tokens in pi-ai's path, and ignores `ANTHROPIC_OAUTH_TOKEN`.
   - The proof of concept above.
1. **Built (2026-11-20), behind a profile's `agent: 'claude-agent'`:** the seam above; `extensions/claude-agent`, one
   `query()` per turn with `resume`, text and tool rows, working/done/error, Stop, the scrubbed environment, `claude`
   found through the login shell. `permissionMode: 'dontAsk'` until wave 2's approvals: a tool the user's Claude Code
   settings don't allow is refused, not asked. Tested in `extensions/claude-agent/test` against
   `test/mock-anthropic.ts`, with the user's `claude` (skipped where it isn't installed). Not yet: real turns on a plan.
   The plan was:
   - Find how a task outside `GenerationTask` owns a pi-durable run and appends entries (§3.2). Settle that first,
     upstream if needed.
   - Then: `extensions/claude-agent` with one `query()` per turn and `resume`; text and tool rows (§3.3); working,
     done and error; Stop; the scrubbed environment; the binary setting.
   - Tested against a mock API like the PoC's, in vitest, with no account.
   - Then **a handful of real turns on a signed-in plan**, to settle §1's "Not proven".
2. **Built (2026-11-20), still behind a profile's `agent: 'claude-agent'`:** approvals, questions and plans as
   blocked status with their card (§3.4's "as built"); the thread's own tools over an in-process MCP server and the
   appended prompt (§3.5's); subagents' steps under their calls. Tested against the mock API with the user's `claude`
   (`extensions/claude-agent/test`), and `test/look.sh <dir> claude-agent` shoots a permission request. Not yet: real
   turns on a plan (§1's "Not proven" stands, `AskUserQuestion` and a denied permission now proven against the mock).
   The plan was:
   - `canUseTool` into permission and question status, with the transcript UI (§3.4).
   - The in-process MCP server with the thread-bound actions and agent-ui's tools (§3.5).
   - The appended prompt.
   - Subagent rows.
3. **Built (2026-11-20): picking it, and other machines.** The model-menu group and the profile as one mechanism
   (§2's "as built"); `claudeAgent.model` and `effort`; Settings → Claude Agent with `claude-agent.check` and a
   terminal to sign in (§3.6's); the cap on turns at once (§3.2); remote machines, tested with two daemons; and the
   subfolder skills gap closed (below). Tested in `extensions/claude-agent/test` (setup, window, remote, parallel and
   daemon tests, with a fake `claude` or the user's against the mock API), and `test/look.sh <dir> claude-agent` shoots
   Settings → Claude Agent and the model menu's group, light and dark. Not yet: real turns on a plan, the sign-in
   state (`kind: 'auth'`), a model menu on a thread. The plan was:
   - The profile field and model-menu group (§2).
   - Settings → Claude Agent with `claude-agent.check` and the terminal-pane sign-in hint (§3.6).
   - The concurrency cap.
   - Remote machines.
   - Docs, and a CHANGELOG entry.
   - Still off by default.

   **The subfolder skills gap, closed.** Claude Code finds `.claude/skills` folders below its folder as it works on
   files there, and a skill runs commands once it's used (its frontmatter `hooks`, and `!` lines in it). Tried against
   the mock with 2.1.325: such a skill loads only when the `project` setting source is on (with `settingSources:
   ['user']` the Skill tool says "Unknown skill"), and Claude Code skips one git ignores, even when the ignoring
   repository is a folder above. So the gap was only for a folder the user had allowed: the allowance covered its
   `.claude/` and not the skills below it, which then loaded unseen. Closed by fingerprinting them with the rest
   (`project.ts`): in a git repository, what `git ls-files` lists (tracked, and untracked but not ignored: what Claude
   Code loads), looking into repositories inside it the same way; outside git, a walk of the folder (past
   `node_modules` and `.git`), only when it has configuration of its own, up to 20,000 folders. A skill showing up or
   changing below asks again; an outside-git folder too big to walk can't be allowed ("too many folders below it to
   look through for the Claude Code skills in them"). Why this, of the options: limiting skill discovery (`skills:
   [...]`) needs the names of every skill the user has (theirs, their plugins') and matches by name, so a skill below
   could take one's name; turning project hooks off (`disableAllHooks`, `allowManagedHooksOnly`) takes the user's own
   hooks too and leaves `!` lines; the Bash sandbox holds nested skills back only as a side effect. The cost: a `git
   ls-files` (tens of ms; 150 ms on this repository) or a walk at each turn's start, where the folder's configuration
   is looked at anyway, and outside git a big folder with configuration of its own can't be allowed at all.
4. **Polish.**
   - A long-lived process per active thread with streaming input (messages mid-turn).
   - Images and attachments.
   - The context meter from `getContextUsage()`.
   - Rate-limit notes.
   - Forking a pi thread into a Claude Agent thread.

   **Turn it on by default only after §7's answers**, or keep it an opt-in labelled as such.

## 5. Risks

- **Terms move.** Billing for exactly this path changed three times in 2026, and Anthropic launched linked billing on
  2026-11-17. Keep the kind opt-in and easy to switch off; re-check the terms at every release.
- **The SDK moves fast** (0.3.323 is pre-1.0; experimental APIs such as `usage()`). Pin it, and test against the mock.
- **The user's `claude` updates itself** under us. Read `init.claude_code_version`, and keep the event mapping
  tolerant of unknown message types: log them, never fail on them.
- **Heavy background use** could get a user's account limited. The cap (§3.2) and the plan's own limits are the brakes;
  say so in the Settings description.

## 6. Why not the alternatives

- **`claude -p` raw stream-json** gives the same events (§1). But the SDK adds `canUseTool` without an MCP permission
  tool, in-process MCP servers, `interrupt()`, `setModel()`, `setPermissionMode()`, typed messages and session
  helpers. The daemon is Node, so the SDK costs nothing extra.
- **Claude Code as a model behind pi's loop** (what Cline did until mid-2026: `--max-turns 1`, every tool
  disallowed) would keep pi's extensions. But it's exactly the "third-party harness" on a subscription that Anthropic
  objects to. Don't.
- **An interactive `claude` in a terminal pane** is plainly fine and already possible with the terminal extension,
  which reads Claude Code's OSC 7501 status. It just isn't a Superego thread: no transcript, approvals or MCP binding.
  It's a useful fallback to point users at.

## 7. Questions for Anthropic before turning it on by default

See claude-subscriptions.md §6 for the full list. The ones this design depends on:

1. Is a free, local, open-source app that runs the user's **own installed, unmodified** Claude Code through the Agent
   SDK (`pathToClaudeCodeExecutable`), signed in by the user with `/login`, within the carve-out for "an end user …
   signing in to the unmodified Claude Code binary"? Is it outside the SDK note's "offer claude.ai login or rate
   limits"?
2. Several such sessions in parallel and in the background (subagents, threads started from a phone): is that within
   "ordinary, individual usage"? Is there a concurrency guideline?
3. May Superego set `CLAUDE_CODE_ENTRYPOINT` (or similar) to identify itself honestly, as T3 Code does, and does
   that change how usage counts?
4. May Superego show the plan's utilisation that Claude Code itself reports (`usage()`, `rate_limit_event`)?
5. Is "Claude Agent", with "Runs your Claude Code" in the description, acceptable naming?
