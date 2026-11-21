# pi-durable agent runner: the upstream contribution (draft, not opened)

Superego carries `patches/@earendil-works__pi-durable@1.6.0.patch`, the seam Claude Agent threads run on
(`docs/research/claude-code-agent.md` §3.2). This is that seam as a change to pi itself, ready to offer upstream. Nothing
has been posted: whether and when is the user's call.

## Where it is

- Cached clone: `~/.cache/checkouts/github.com/earendil-works/pi`.
- **`durable-agent-runner`**: two commits on `origin/main` (as of 780bf31fc), the branch to offer. `npm run check` and
  pi-durable's suites (`vitest --run`, with `PI_DURABLE_DOCUMENT_RETENTION_MS=0`, the store and workerd configs) pass
  on the first. The second (2026-11-21), `placeSteers()`, for a runner to take steers mid-turn, wasn't built or run
  there (this Mac has no install of pi's dependencies): its `dist/` twin is in Superego's patch, tested by
  `packages/daemon/test/agent-kind.test.ts`. Build and test it before offering it.
- **`durable-agent-runner-1.6`**: the same commits on `v1.6.0`. Superego's patch is built from it: `npm run build` in
  `packages/durable`, then the diff of `dist/` against the published 1.6.0 tarball (only `harness/agent.js`,
  `harness/generation.js`, `harness/generation.d.ts`, `harness/types.d.ts`, `index.js` and `index.d.ts` differ; source
  maps left out). To
  rebuild the patch for a later pi, rebase this branch onto that tag and diff again.

## Before a PR: an issue

pi's `CONTRIBUTING.md` closes PRs from contributors a maintainer hasn't approved (`lgtm` on an issue), and asks that
issues be short, in the author's own voice, and say whether they'd implement it. So the first step is an issue, written
by the user (an agent's draft would have to say so). The points it needs:

- What: let a task run a conversation's turns in place of the model request, keeping the run pi-durable's.
- Why: driving another agent (Claude Code through its Agent SDK, Codex) from a pi-durable host. Today an extension's
  task can't own a run: `startRun` always creates `pi.generation`, and only it may hold `pi.live.run`, so such a host
  either reimplements runs (inputs, queueing, Stop, failures) or can't use pi-durable's.
- Offer to implement it; the branch exists.

## PR text

The PR text below starts with "(Agent) " as required for anything posted on the user's behalf.

---

(Agent) feat(durable): agent runner, a task that runs a conversation's turns instead of a model request

**Problem.** A host that drives another agent (Claude Code through its Agent SDK, Codex, a scripted bot) wants
pi-durable to own its conversations as it owns a model's: `pi.live.run` while it works, queued messages and steering,
`abort()`, failures with `runFailure`, `afterRun` work, restarts. It can't: every run is a `pi.generation`, which always
asks a model, and only the generation may hold the run. So such a host keeps a second run model next to pi-durable's,
or gives up the durable parts.

Example: Superego runs some threads on the user's own Claude Code. One turn there is a long `query()` of the Agent SDK
that streams text, calls tools (some of them pi tools, offered back to Claude Code over MCP) and ends with an answer.
The user's Stop should stop it, a message sent meanwhile should queue as for a model, and the transcript should hold
the turn as pi entries.

**Solution.** `AgentState.runner` names an installed task that runs each turn instead of a model request:

```typescript
await conversation.configure({ runner: "my-agent.turn" }, context); // null hands the turns back to the model
```

The generation's `prepare` sees it and, instead of rendering a prompt and requesting the model, creates the runner as
a child it owns (input `{}`) and waits for it in a new `delegate` phase. The runner reads the conversation, appends the
turn's entries itself (assistant messages, tool results), may commit its answer in flight as
`pi.live.generation.message` (deferred, like the generation's partials), and completes with `{ entryId }` of its answer
(`GenerationResult`). Then:

- completed with an entry: the run concludes as a model's final answer does (`concludeAnswer()`): inputs settle `done`,
  the final boundary places queued items, `afterRun` hooks run.
- failed, faulted, aborted or orphaned: the run ends `unanswered` with `model_error` and the runner's error; a partial
  it left becomes an aborted entry.
- `abort()` aborts the runner as the generation's child, then the generation's abort handler keeps its partial, as for
  a model's.
- a runner that isn't installed, or a built-in `pi.*` name: `no_model`, detail `Runner <name> is not installed`. A
  context with nothing to answer: `nothing_to_answer`, before the runner starts.

The runner owns the turn: the agent's model, sections, tools, compaction, retries, `maxTurns` and the generation hooks
other than `afterRun` don't apply. Task-owned children and forks inherit `runner` like the rest of the agent.
`pi.generation` is version 4 for the new phase.

The generation stays the only owner of runs, so nothing else changes: the scheduler, `startRun`, the inbox and the
live document are untouched. The change is about 100 lines in `generation.ts`, the field in `agent.ts`/`types.ts`,
and docs (README "Per-Conversation Agent", spec §7.1 and §8.3, changelog).

**Open question.** `onYield` hooks take the model's `AssistantMessage` and aren't asked for a runner's answer here.
Reading the answer entry back and asking them would be possible if a maintainer prefers it.

**Tests.** `packages/durable/test/harness-runner.test.ts`, with a probe runner that publishes a partial, appends a tool
call, its result and an answer:

- runs the turn instead of the model: its entries, its answer, no request
- keeps the run: an input queued meanwhile starts the next run, answered by the runner too
- publishes its answer in flight, and an abort keeps it as an aborted entry
- fails the run with the runner's error, keeping its partial
- fails the run `no_model` when the runner is not installed, or is a built-in task
- ends a continue with nothing to answer before starting the runner
- asks `afterRun` hooks once the runner answered; `onYield` and the model's hooks don't apply
- configures: an empty name is refused, `null` hands the turn back to the model

`harness-tool-hooks.test.ts` expects `pi.generation` version 4. `npm run check` passes, and so do pi-durable's suites
(both document-retention settings, the store config, workerd).

---

## Opening it, when decided

From the cached clone: push `durable-agent-runner` to a fork, open the PR against `earendil-works/pi` `main` with the
text above (from a file: `gh pr create --body-file`), after the issue got its `lgtm`. Rebase onto `origin/main` first;
the changelog entry goes under `## [Unreleased]` there.
