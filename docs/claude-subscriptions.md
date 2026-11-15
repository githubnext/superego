# Superego on a Claude subscription: what's allowed, what others do, and how

All web sources were accessed on **2026-11-15** (this machine's clock), unless a line says otherwise. Quotes are verbatim. **This is not legal advice.** It's a reading of Anthropic's public terms, docs and staff statements. Those have changed five times in 2026, so check them again before shipping.

---

## TL;DR

- **Wrapping the user's own Claude Code is the sanctioned path.** That means Superego runs the user's own installed, unmodified `claude` binary, which signs itself in through Anthropic's own `/login`. This is allowed today, and Anthropic's legal page says so in so many words: the restrictions don't "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". T3 Code, Conductor, Zed (through ACP) and Cline all work this way. One Anthropic staffer said in February 2026: "We want to encourage local development and experimentation with the Agent SDK and claude -p." Usage currently counts against the plan's normal limits.
  - **The grey edges:**
    - The Agent SDK's standing note says third-party developers may not "offer claude.ai login or rate limits for their products" unless previously approved.
    - The "offer Claude Code in your products" section asks for the Commercial Terms plus some conditions.
    - Plan limits "assume ordinary, individual usage". Background agents running unattended stretch that.
    - The billing for `claude -p` and the Agent SDK has been flipped three times since April 2026.
- **Superego using the subscription's OAuth token itself is clearly not allowed.** That means reading Claude Code's token, or pi-ai's `sk-ant-oat…` handling, to call the API from Superego's own agent loop. The current Usage Policy (effective Nov 12, 2026) bans "services that route requests through consumer subscriptions or misrepresent the product or client being used". Anthropic enforced this technically in January 2026, sent OpenCode a legal request in March 2026, and Pi users reported being cut off in April 2026.
- **A "Log in with Claude" button in Superego is not allowed without approval.** The legal page says: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications … sign-in to a Claude account must complete through Anthropic's own flow." Amp offers exactly this, which strongly suggests it has the approval the SDK note mentions. I found no public announcement of a deal, so that part is unverified.
- **A fully sanctioned extra: plan API credits.** Since 2026-10-07, Max, Ultra and Team plans include monthly API credits: $100 for Max, $200 for Ultra. The user claims them into a Console organization and makes an API key there. Superego's existing native agent already accepts an Anthropic API key, so this works today with no Claude Code involved and nothing lost.

**Recommendation.**
1. **Add an opt-in "Claude Code" agent kind for threads.** It would spawn the user's own `claude` through the Agent SDK, with `pathToClaudeCodeExecutable` set to their install, or through `claude -p` in stream-json mode.
   - Superego never touches Claude credentials.
   - No sign-in button: when Claude Code isn't signed in, tell the user to run `claude` and `/login` themselves.
   - Superego's tools reach it through `superego mcp`.
   - Branding: say "runs Claude Code"; don't use Claude Code's name as Superego's feature name.
2. **In Settings, point Max, Ultra and Team users to the plan-credits API key**, as the no-grey-area option.
3. **Close the latent spoofing path in the current build** (see §4b).
4. **Email Anthropic** to confirm (a) for a free, local, open-source tool before pushing it as a headline feature (§6).

---

## 1. What Anthropic's terms say

### 1.1 Claude Code docs: "Legal and compliance"

Source: <https://code.claude.com/docs/en/legal-and-compliance> (and its `.md` twin).

On licensing, Free, Pro, Max and Ultra users are under the Consumer Terms; Team, Enterprise and API users are under the Commercial Terms.

> **Acceptable use.** Claude Code usage is subject to the Anthropic Usage Policy. Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK.

> **Authentication and credential use.** … **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications. …
>
> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.
>
> This does not restrict how customers provision and manage their own API keys … **Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code** as described under *Can customers offer Claude Code in their products?* above.
>
> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

> **Can customers offer Claude Code in their products?** Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
> - **The Claude Code binary must not be modified.** … customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).
> - **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential …
>
> **Using the Claude Code name and logo.** You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name … or in a way that suggests Anthropic built, endorses, or is partnered with your product.

How this section changed, from Wayback Machine snapshots:

| Snapshot | What the section said |
|---|---|
| 2026-01-28 | The section didn't exist. |
| 2026-02-19 | First version, much harsher: "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — **including the Agent SDK** — is not permitted and constitutes a violation of the Consumer Terms of Service." This was on HN's front page ([hn:47069299](https://news.ycombinator.com/item?id=47069299)). Anthropic walked it back the same week (§1.5). |
| 2026-04-13 to 2026-06-10 | Softened to "ordinary use of Claude Code and other native Anthropic applications". |
| By 2026-09-15 | Added "may not collect, store, or intermediate … credentials", the carve-out for the unmodified binary, and the "offer Claude Code in their products" section. |

### 1.2 Agent SDK overview: the "previously approved" note

Source: <https://code.claude.com/docs/en/agent-sdk/overview>; platform.claude.com and docs.claude.com redirect here.

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead.

How the wording changed, from Wayback snapshots:

| Snapshot | Wording |
|---|---|
| 2025-09-29 (SDK launch, docs.claude.com) | "Unless previously approved, we do not allow third party developers to apply Claude.ai rate limits for their products, including agents built on the Claude Agent SDK." |
| 2026-01-17 (platform.claude.com) | "…to offer Claude.ai login or rate limits for their products…" |
| 2026-02-16 onward | The current wording, with "Anthropic does not allow…". |

The same page's branding rules:
- **Allowed:** "Claude Agent", "Claude" (in a menu labelled "Agents"), "{YourAgentName} Powered by Claude".
- **Not permitted:** "Claude Code" or "Claude Code Agent", and Claude Code-branded ASCII art or visuals.
- "Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product."
- Licence: the SDK is under the Commercial Terms, "including when you use it to power products and services that you make available to your own customers".

### 1.3 Consumer Terms (effective Oct 8, 2025) and Usage Policy (effective Nov 12, 2026)

Consumer Terms (<https://www.anthropic.com/legal/consumer-terms>), on what you may not do:

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else or make your Account available to anyone else.

Headless `claude -p` and the Agent SDK on a subscription are "explicitly permitted" through the docs and support articles below.

Usage Policy (<https://www.anthropic.com/legal/aup>), under "Do Not Abuse Our Platform":

> Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used

> Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products, including by circumvention of the account sign-up or log-in process …

### 1.4 Support center articles

**"Log in to your Claude account"** (<https://support.claude.com/en/articles/13189465-logging-in-to-your-claude-account>), section "Authenticating to subscription plans":

> …the usage included in these plans is designed to support ordinary use of native Anthropic applications, including the Claude web, desktop, and mobile applications and Claude Code. The preferred way to access Anthropic services using third-party software, tools, or services ("third-party tools"), including open-source projects, is through API key authentication … Anthropic may at its discretion allow paid subscribers who have enabled usage credits to use certain third-party tools to access Anthropic services included in paid subscription plans, but reserves the right to draw use of such third-party tools from usage credits rather than subscription limits. … Use of third-party tools that misrepresent their identity to Anthropic's servers, attempt to route third-party traffic against subscription limits, or otherwise violate applicable terms or policies is prohibited …
>
> **Developers** — If you're building a product, application, or tool for others, use API key authentication through Claude Console or a supported cloud provider.

**"Use the Claude Agent SDK with your Claude plan"** (<https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>), current text:

> Update October 7, 2026: Claude Max, Ultra, and Team plans now include monthly API credits. They cover the Claude API, Claude Managed Agents, and the Claude Agent SDK and claude -p when you run them with an API key from your linked Claude Console organization. Nothing changes for your plan: **when you're signed in with your Claude plan, the Claude Agent SDK and claude -p still draw from your subscription limits.**
>
> Update June 15, 2026: We've paused the previously-announced changes to Claude Agent SDK usage. For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription limits.

The original version, from the Wayback snapshot of 2026-05-14, had announced a separate monthly "Agent SDK credit" from June 15. It covered:
- "Claude Agent SDK usage in your own projects"
- "The claude -p command"
- "**Third-party apps that authenticate with your Claude subscription through the Agent SDK**"

Anthropic did not ship that change. The original still matters: it's Anthropic itself naming third-party apps on the Agent SDK with the user's own subscription as a legitimate category. It also shows the billing for this path is volatile.

**"Monthly API credits for Max, Ultra, and Team plans"** (<https://support.claude.com/en/articles/17154008>):
- Max gets $100 a month, Ultra $200, Team $20 or $100 per seat (pooled, capped at $500).
- You link one Console organization; the credits cover "The Claude API … Claude Managed Agents, The Claude Agent SDK".
- Credits don't roll over. When they run out, requests stop unless the organization has bought credits.
- Free, Pro and Enterprise plans aren't eligible.

### 1.5 Public statements and enforcement, 2026

| Date | Who / where | What |
|---|---|---|
| 2026-01-08/09 | Server-side change | OAuth tokens rejected for non-Claude-Code use: "This credential is only authorized for use with Claude Code and cannot be used for other API requests." (OpenCode issue [anomalyco/opencode#7410](https://github.com/anomalyco/opencode/issues/7410), [HN 46549823](https://news.ycombinator.com/item?id=46549823)). |
| 2026-01-09 | Thariq Shihipar, Claude Code team, [x.com/trq212/status/2009689809875591565](https://x.com/trq212/status/2009689809875591565) and thread | "Yesterday we tightened our safeguards against spoofing the Claude Code harness … Third-party harnesses using Claude subscriptions create problems for users and are prohibited by our Terms of Service. … This is why the supported way to use Claude in your own tools is via the API. … If you're a maintainer of a third-party tool and want to chat about integration paths, my DMs are open." |
| 2026-02-18 | Thariq, [2024212378402095389](https://x.com/trq212/status/2024212378402095389) and [2024212380142752025](https://x.com/trq212/status/2024212380142752025) | On the harsh February legal-page wording: "this was a docs clean up … Nothing is changing about how you can use the Agent SDK and MAX subscriptions! **We want to encourage local development and experimentation with the Agent SDK and claude -p. If you're building a business on top of the Agent SDK, you should use an API key instead.**" |
| 2026-03-19 | OpenCode PR [#18186](https://github.com/anomalyco/opencode/pull/18186), "anthropic legal requests" | Removed the built-in Anthropic OAuth plugin, the `claude-code-20250219` beta header and the "anthropic_spoof" system prompt. |
| 2026-04-03 | Boris Cherny, Claude Code lead, [x.com/bcherny/status/2040206440556826908](https://x.com/bcherny/status/2040206440556826908) and the user email ([HN 47633396](https://news.ycombinator.com/item?id=47633396)) | "Claude subscriptions will no longer cover usage on third-party tools like OpenClaw. You can still use these tools with your Claude login via extra usage bundles … or with a Claude API key." The email says: "this policy applies to all third-party harnesses." Asked whether "personal local tools that use or wrap the Claude harness like Claude Code and Claude Code headless and Agent SDK" were still fine, Boris answered only "Yep, working on improving clarity here to make it more explicit" ([2040207998807908432](https://x.com/bcherny/status/2040207998807908432)). |
| 2026-04-08 | HN ([47688918](https://news.ycombinator.com/item?id=47688918)) | Users reported Pi, the harness under Superego's pi-durable, losing subscription access. This is user reports only; **unverified**. |
| 2026-05-13 → 06-15 → 10-07 | Support article 15036540 | The Agent SDK credit was announced, then paused, then replaced by plan API credits. Signed-in Agent SDK and `claude -p` stay on plan limits. |

**My reading.** Anthropic's line has settled. *Harnesses* are banned on the subscription: their own agent loop using a subscription token, especially one disguised as Claude Code. *The real Claude Code*, driven by the CLI or the Agent SDK and signed in by the user, is tolerated and named in support articles, even inside other apps. A third-party developer *running the sign-in, holding the token, or serving many users from one subscription* needs Anthropic's approval.

---

## 2. Amp and others

### Amp (Sourcegraph): a special arrangement, most likely

- **Announcement.** "Use Your Claude Plan in Amp", 2026-10-10 (<https://ampcode.com/news/use-your-claude-plan>): "You can now use your Claude Subscription in Amp. It's free and available for everyone now. … It'll ask to link your Claude sub … **Under the hood, this mode uses the Claude Agent SDK instead of Amp's own agent.**"
- **Docs** (<https://ampcode.com/docs/the-dial#use-your-claude-subscription>, <https://ampcode.com/docs/markdown/model-selector>):
  - "When you link a Claude subscription in Settings → Model Routing … Claude Code serves these requests from your Claude plan. **It runs through the Claude Agent SDK on Amp's servers**, so nothing needs to be installed in your orb or on your runner."
  - Amp shows "how much of your Claude plan's 5-hour and weekly limits is left, as Anthropic last reported it".
  - There's also a "Claude Code agent" that "runs Claude Code with Amp's tools"; Claude Code's own `~/.claude/CLAUDE.md` is not loaded.
  - Cost notes: "Each response takes longer to start. Claude Code adds its own attribution and environment details to the prompt."
- **How it works.** It's not the user's local `claude`, and not raw OAuth calls. Amp runs real Claude Code, through the Agent SDK, on Amp's own servers, with a Claude subscription the user "links" to Amp. So Amp holds or intermediates the subscription credential server-side. The current legal page forbids exactly that "unless previously approved". It's also the only kind of integration that could report the plan's rate limits back to the user.
- **Was it approved?** I found no public Anthropic or Amp statement of a partnership. The news post and docs don't mention one, and the docs link to Anthropic's own support article. Amp shipping a server-side, linked-subscription flow openly, a year after OpenCode's legal request, is strong circumstantial evidence of approval. **Unverified.**

### Others

| Tool | How it uses a Claude subscription | Within the rules? |
|---|---|---|
| **T3 Code** ([github.com/pingdotgg/t3code](https://github.com/pingdotgg/t3code)) | Local server plus desktop, web and phone clients, very like Superego. Uses `@anthropic-ai/claude-agent-sdk` but strips the SDK's bundled binaries (pnpm overrides), so it drives the user's installed `claude`. Setup says: "install Claude Code and run `claude auth login`". README: "T3 Code does not resell tokens. It drives the agents you are already signed in to." | Path (a). This is the closest precedent to Superego. |
| **Conductor** ([docs](https://www.conductor.build/docs/reference/harnesses/claude-code), [FAQ](https://www.conductor.build/docs/faq)) | "Conductor includes a managed Claude Code executable. You can use your own Claude Code install instead." "By default, Conductor uses the auth tokens already saved on your machine … if you're logged in with Claude Pro or Max, Conductor uses that." "Conductor does not bill or resell model usage." | Path (a), with a bundled but unmodified binary. "Uses the auth tokens already saved" means Claude Code reads its own keychain entry, as far as I can tell. |
| **Zed** ([external agents](https://github.com/zed-industries/zed/blob/main/docs/src/ai/external-agents.md)) | Runs "Claude Agent" over ACP through [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) ("ACP adapter for the Claude Agent SDK"). "Claude Agent owns its own authentication and billing … run `/login`". The adapter ships its own `claude` or uses `CLAUDE_CODE_EXECUTABLE`. Its name follows the SDK branding rules. | Path (a). |
| **Cline** ([docs](https://docs.cline.bot/provider-config/anthropic.md)) | A "Claude Code (subscription-based)" provider: "Install and authenticate Claude CLI … Set the Claude CLI path." It notes "Responses may not stream token-by-token. Image uploads and prompt caching are limited." Historically it ran Cline's own prompt and loop through `claude -p` with Claude's tools disabled, using Claude Code as a model proxy; **I didn't verify how it works today.** | Path (a) on paper. Using `claude -p` as a bare model proxy for your own harness is the greyest form: it looks like the "third-party harness" Anthropic objects to. |
| **Crystal / Claude Squad-style wrappers** | Run interactive `claude` in a pty or tmux per worktree. | Plainly fine: it's literally the user running Claude Code. |
| **OpenCode** | Had a built-in OAuth plugin that impersonated Claude Code (system prompt "You are Claude Code…", Claude Code's client ID and beta headers). Blocked in January 2026; removed in March 2026 after Anthropic's legal request. | Path (b)/(c): not allowed. |
| **OpenClaw** | Mostly ran on Pi with a subscription token. Its docs also offer "Claude CLI as the message provider". Cut off from subscription limits on 2026-04-04; now needs extra usage or an API key. | Classed as a third-party harness. |
| **Pi (pi-mono / pi-ai)** | pi-ai ships a "Claude Pro/Max" OAuth flow using Claude Code's OAuth client ID (base64-obfuscated in `auth/oauth/anthropic.js`) and sends `user-agent: claude-cli/<ver>`, `x-app: cli` and the `claude-code-20250219` beta for `sk-ant-oat` tokens. | Path (b)/(c) with impersonation. **This code is vendored in Superego** (see §4b). |

---

## 3. The three options, rated

### (a) Wrap the user's own Claude Code, which signs itself in: allowed, with grey edges

The setup: Superego spawns the user's installed `claude`, either as `claude -p --input-format stream-json --output-format stream-json` or through the Agent SDK pointed at that binary. Claude Code reads its own credentials from the keychain or `~/.claude`. Superego never sees a token.

**For it:**
- The legal page's carve-out for "signing in to the unmodified Claude Code binary with their own Claude subscription".
- The support article saying the signed-in Agent SDK and `claude -p` draw on plan limits.
- Staff saying they "encourage local development and experimentation with the Agent SDK and claude -p".
- The May 2026 article listing "third-party apps that authenticate with your Claude subscription through the Agent SDK" as a covered category.
- T3 Code, Conductor and Zed shipping exactly this in public.

**Grey edges:**
1. **The SDK note.** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products." Whether Superego offers rate limits by running the user's own Claude Code is open to interpretation. Lower risk: Superego offers no sign-in, holds no credential, and relies on the user having signed in to Claude Code themselves.
2. **Commercial Terms.** "Running Claude Code in your products" asks for the Commercial Terms and the conditions above: unmodified binary, all auth methods kept, each user on their own credentials. Superego meets the conditions. It isn't clear whether a free, local, open-source app "agrees to the Commercial Terms" in any meaningful sense; ask (§6).
3. **"Ordinary, individual usage".** Superego's selling points are many parallel threads, subagents, background work and phone access. Heavy unattended automation on a subscription is what Anthropic said its plans "weren't built for". That's a rate-limit and ban risk, not a licence question.
4. **Volatility.** The billing for exactly this path was announced to change (May), paused (June) and re-affirmed (October), all in 2026. Expect it to move again.
5. **"Business" versus "local".** Thariq: "If you're building a business on top of the Agent SDK, you should use an API key instead." If Superego is ever sold or hosted, this matters more.

**Doesn't need approval** as I read it, but worth a confirming email.

### (b) Superego reads or uses the OAuth token itself: not allowed

This covers Superego extracting Claude Code's keychain token, taking a `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, or reusing pi-ai's OAuth support, then calling `api.anthropic.com` from pi-durable's own loop. It's prohibited by:
- the legal page: "may not collect, store, or intermediate Claude.ai credentials or session tokens"; "route requests through … plan credentials";
- the Usage Policy: "route requests through consumer subscriptions or misrepresent the product or client";
- the support article: "misrepresent their identity".

It's also enforced technically: the API rejects such tokens unless the request looks like Claude Code, so making it work means impersonating Claude Code. On top of that come the January bans, the OpenCode legal request and the April third-party-harness billing. Even a `setup-token` the user pastes in counts: that token is documented for running Claude Code in CI ("set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable"), not for other clients.

Approval: no realistic path short of a partnership.

### (c) Superego's own "Log in with Claude": not allowed without approval

The legal page: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications … sign-in to a Claude account must complete through Anthropic's own flow." The SDK note adds "unless previously approved". Amp's linked subscription looks like the approved version of this.

The only form available without approval is a deep-link or terminal step that runs `claude` or `claude auth login` in the user's own Claude Code. That's (a), not (c).

pi-ai's built-in Anthropic OAuth flow is (c) done with Claude Code's own client ID. Never expose it.

### (d) Bonus: plan API credits fed to Superego's own agent: allowed

A Max, Ultra or Team user claims the monthly credits into a Console organization, makes an API key, and pastes it into Superego's Anthropic API-key field. That's the normal Commercial or API path, and every Superego feature works as today. The limits: $100–$200 a month, no Pro plan, and the user has to do the claiming.

---

## 4. Technical sketch: a thread backed by Claude Code

### 4a. Shape

- **A second agent kind.** A thread is `agent: 'pi'` (today) or `agent: 'claude-code'`, chosen when the thread starts (a profile field or a model choice such as "Claude (your Claude Code)") and fixed for the thread's life, as Amp does.
  - The pi-durable conversation stays the thread's record: Superego writes Claude Code's events into it as entries of its own (`defineEntry`).
  - A durable task (`defineTask`) owns the child process, so pausing, aborting and restarting fit pi-durable's model.
  - The thread stores Claude Code's `session_id`.
  - Thread status is derived the same way: `run` present → working; result → done; error → error.
- **Driving it.** Two choices. Prefer the SDK, since the daemon is Node.
  - **Agent SDK (TypeScript)**, with `pathToClaudeCodeExecutable` set to the user's `claude`. Don't bundle the SDK's binary; T3 Code strips it the same way. Gains:
    - `canUseTool`, which maps onto ask-user and blocked status;
    - `resume` and `forkSession`;
    - `includePartialMessages` for streaming;
    - in-process MCP servers (`createSdkMcpServer`);
    - `interrupt()`;
    - typed messages.
  - **Raw CLI**: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid>` for the first turn, then `--resume <id>`. It's one long-lived process per running thread (stream-json input takes later user messages), or one per turn. **Don't pass `--bare`**: bare mode "never reads OAuth credentials", so it can't use the subscription.
- **Permissions.**
  - SDK: `canUseTool` becomes a Superego approval prompt, shown as the thread's blocked status, with notifications and phone access.
  - CLI: `--permission-prompt-tool mcp__superego__approve` on Superego's MCP server.
  - Either way, profiles can set `--permission-mode` (`acceptEdits`, `plan`, …) and `--allowedTools`/`--disallowedTools`.
- **Superego's tools.** Pass Superego's MCP server with `--mcp-config` / `mcpServers`: `superego mcp -m <machine>`, or an in-process SDK server built from the same action table. Claude Code then gets `thread_*`, panes, ask-user and the rest as `mcp__superego__*` tools. Superego's instructions and the pane catalogue go in through `--append-system-prompt` / `systemPrompt: { preset: 'claude_code', append }`. **Append, don't replace**: keep Claude Code as Claude Code, and avoid looking like a harness disguised as it.
- **Rendering.** Map stream-json `assistant`, `user` (tool results), `stream_event` and `result` events onto Superego's work-run rows: Read, Edit, Bash and so on match its verbs. `result` carries `total_cost_usd` (an estimate) for the cost display, though subscription use isn't really billed per token.

### 4b. Fix now, whatever is decided

Superego currently offers OAuth only for OpenAI (`OAUTH = new Set(['openai'])` in `agent-settings.ts`). But the vendored pi-ai will still:
- use `ANTHROPIC_OAUTH_TOKEN` from the daemon's environment (pi-ai's default auth context reads `process.env`), and
- treat any stored Anthropic "API key" containing `sk-ant-oat` as an OAuth token. It then sends it with `user-agent: claude-cli/…`, `x-app: cli` and `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, i.e. impersonating Claude Code.

A user pasting a `setup-token` into Settings would quietly put Superego in option (b). The fix: refuse `sk-ant-oat` keys and ignore `ANTHROPIC_OAUTH_TOKEN` for the Anthropic provider, with a message pointing to the Claude Code agent kind or plan credits.

### 4c. What would and wouldn't work in a Claude Code thread

| Works | Doesn't work, or differs |
|---|---|
| Transcript, streaming, panes beside the thread, notifications, unread/seen status, phone and web access, worktrees (Claude Code runs in the thread's folder) | pi-durable **agent extensions** (tools, prompt sections, hooks) don't run inside Claude Code's loop. Only what's exposed over MCP or appended to the prompt reaches it. |
| Superego actions and tools through MCP: ask-user, threads, panes | **Model, thinking and fast settings** come from Claude Code (`--model`, effort), not pi-ai; GPT models aren't available in that thread. |
| Approvals mapped to blocked status | **Durability**: the conversation lives in `~/.claude/projects/…jsonl` on that machine. Resuming relies on `--resume`; a crash mid-tool is Claude Code's to recover from, not pi-durable's replay. Superego's copy is a mirror. |
| Profiles choosing the agent kind, permission mode, allowed tools, appended prompt, MCP servers | **Compaction** and context are Claude Code's own. Superego's compaction and prompt sections don't apply. |
| `CLAUDE.md`, skills and hooks from `.claude/` (Claude Code loads them; a plus for many users) | **Cost and limits**: no reliable display of plan usage. Rate-limit errors come back as Claude Code errors and should map to an error status with a clear message. |
| Remote machines: works if `claude` is installed and signed in **on that machine** | No "Sign in with Claude" in Superego. Show "Claude Code isn't signed in on <machine>: run `claude` there and `/login`." |

---

## 5. Things I couldn't verify

- Whether Amp has a formal approval or partnership with Anthropic. It's inferred from its server-side linked-subscription design; I found no public statement.
- Whether Anthropic has any rule specific to wrappers like Conductor or T3 Code, beyond the general carve-out. Anthropic hasn't been seen enforcing against them.
- That Pi itself was cut off in April 2026 (user reports only).
- Cline's current Claude Code provider internals.
- Exactly when the Agent SDK note changed from "apply Claude.ai rate limits" to "offer claude.ai login or rate limits": between 2025-12-12 and 2026-01-17, per Wayback; the 2025-12-12 snapshot couldn't be parsed.
- All dates assume this machine's clock (2026-11-15) and the dates shown on the pages.

## 6. Questions for Anthropic

Ask through their sales contact, which the legal page names "for questions about permitted authentication methods", or through Thariq's offer to tool maintainers, if it still stands.

1. Superego is a free, local, open-source app. It spawns the user's **own installed, unmodified** Claude Code through the Agent SDK (`pathToClaudeCodeExecutable`), signed in by the user through Claude Code's own `/login`. Superego never sees or stores credentials. Is that within "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription", and outside the SDK note's "offer claude.ai login or rate limits"?
2. Does that need Superego (the project) to accept the Commercial Terms under "Can customers offer Claude Code in their products?", given that it doesn't bundle Claude Code?
3. Can Superego run several Claude Code sessions in parallel and unattended (subagents, background threads, started from a phone) on one user's subscription, or does that fall outside "ordinary, individual usage"? Is there a concurrency guideline?
4. Is the plan-credit API key (Max, Ultra, Team) the path you'd prefer Superego to recommend?
5. Is approved "Sign in with Claude" for third-party apps (the Amp model) available to small open-source projects, and what does it require?
6. Branding: is "Claude (runs your Claude Code)" in a model menu acceptable? Should we stay with "Claude Agent"?
