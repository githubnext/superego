# Extension-building eval: spike report

Run on 2026-11-15, installed build `b5d8260` (main at `3d3e324` plus the harness). 18 runs, 16 passed. Spent about
**$24.1 of the $60 budget**: $23.34 in the batch (agents $16.59, acceptance probes $0.06, transcript analysis $6.69
including the rollup), $0.47 on Haiku runs while building the harness, and about $0.25 on a rollup call whose reply
didn't parse. Wall time was about 70 minutes with three runs at a time.

Raw results, transcripts, the profiles each run wrote, and acceptance screenshots are in `evals/results/spike/`
(gitignored). `summary.md` there has the per-run table and `rollup.json` has the ranked stumbles.

## Results

| model | route | task | pass | min | agent cost | turns | tool calls | failed calls | tokens in (incl. cache) | tokens out |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | thread | L1 weather | 3/3 | 2.0 | $0.27 | 19 | 19 | 1.7 | 231k | 6k |
| claude-opus-5-5 | ego | L1 weather | 3/3 | 5.6 | $0.75 | 39 | 41 | 3.3 | 863k | 17k |
| claude-opus-5-5 | thread | L3 kanban | 2/3 | 10.4 | $1.89 | 51 | 51 | 1.7 | 3,318k | 26k |
| claude-opus-5-5 | ego | L3 kanban | 2/3 | 10.9 | $1.89 | 56 | 59 | 2.7 | 3,344k | 25k |
| gpt-6.1-sol | ego | L1 weather | 3/3 | 4.2 | $0.32 | 34 | 33 | 4.3 | 785k | 11k |
| gpt-6.1-sol | ego | L3 kanban | 3/3 | 4.7 | $0.41 | 39 | 37 | 4.0 | 1,422k | 11k |

All figures are means per run. Turns are model requests, and failed calls are tool results marked as errors. One run
hit the 20-minute limit (`l3-kanban.opus.ego.3`). None hit the $6 cost cap, and none needed the "go ahead" nudge.

What stands out:

- **L1 is solved: 9/9.** Every run put a `get_weather`-style tool in the user's `~/.superego/profiles/default`. In
  every run a fresh thread in the user's project picked it up and called it successfully.
- **L3 is mostly solved: 7/9.** Both failures had the same cause: `superego.store('folded', …)` threw at setup because
  it must be `'kanban.folded'`, so the UI half never registered its pane (details under stumble 1). Both boards were
  otherwise complete, and both agents believed they had shipped.
- **Every run, by both routes, chose the same place:** the user's `default` profile. Nobody made a project profile,
  so trust and allow never came up.
- **Ego's handoff worked in 12/12 runs.** Ego read the skill, started one well-briefed thread in `~/.superego`, and
  linked it. Ego itself costs little ($0.02–0.07 a run, 3–5 turns). The Ego route still costs about 2.5× more on L1 than
  a plain thread ($0.75 vs $0.27, 5.6 vs 2.0 min). Its briefs ask for tests and verification, so the building thread
  then fights `extension test` (stumble 2). On L3 the two routes are level.
- **Sol was 4–5× cheaper than Opus and passed 6/6,** but it reached outside the help more. Sol runs read the app's
  bundled JS (`out/main`, `out/renderer`) 1–6 times each, against 0–3 for Opus, and fetched from the web in 3 of 6
  runs. Both models ran with thinking **off**, because the machine's "Model default" resolves to off.
- **The first help they reach for:** all 18 read SKILL.md and `--skill profiles`, 14 read
  `docs/writing-extensions.md`, and 13 ran `superego extension --help`. Every run used `superego profile new`, but only
  3 used `superego extension new`, the scaffold the docs build everything on. SKILL.md doesn't mention
  `extension new`, `test` or `reload` at all.

## Where agents got lost, ranked, with fixes

The counts come from a model pass over each transcript, merged across runs (`rollup.json`). I checked the top items
against the transcripts and the source. Item 1 is my own addition: the analysis pass never saw the window's console
error, so it missed it. The harness now passes acceptance notes to the analysis.

1. **`superego.store` keys must carry the extension's name, and the docs read as if they don't.** This was fatal in
   both L3 failures (2 runs). The window throws `Extension kanban must name its state "kanban.<key>", not "folded"`
   (`packages/app/src/renderer/extension.tsx:680`). `ui.md` describes `store(key, initial)` as "state of the extension
   kept in the window (`<name>.<key>`)", which reads as "prefixed for you".
   *Fix:* prefix bare keys in `store()` (the simplest choice), or change the `ui.md` row to an example like
   `superego.store('orders.open', false)`. Also make `superego/testing`'s window enforce the same rule, so a test
   would have caught it.
2. **`superego extension test` doesn't work in an installed app.** 16 of 18 runs ran into it. It fails with
   `Cannot find module '@superego/sdk/package.json'`: `sdkPaths()` in `packages/cli/src/extensions.ts` looks for the
   SDK, `tsc` and `vitest` in a checkout. Agents deleted tests they had written, wrote their own runners, or tried to
   download TypeScript from npm or jsdelivr.
   *Fix:* ship a type-checker and test runner with the app, resolved from `out/types`, and run on the app's Electron
   as Node. Add a packaged-build smoke test that runs `superego extension test` on a scaffolded extension. Until then,
   say in `tools.md` and `writing-extensions.md` that it needs a checkout.
3. **There's no type-checking path at all** (15 runs). It's the same root cause as item 2, from the other side:
   agents look for `tsc`, `npx` or `node` and find nothing.
   *Fix:* have `superego extension test` (or a new `extension check`) be the documented check. State in SKILL.md that
   no Node, npm or tsc is needed or shipped.
4. **The SDK's type entry points are thin re-export shells** (11 runs). `superego/src/index.d.ts` is
   `export * from '@superego/daemon/sdk'`, so finding `defineTool`, `obj/str/opt/union/lit`, `testing` or the UI hooks
   means grepping `@superego/*`, `pi-schema`, `pi-durable` and `chord` declarations.
   *Fix:* emit flattened, documented `index.d.ts` files for `superego`, `superego/ui` and `superego/testing` in
   `~/.superego/types`. List the schema builders with their signatures in `tools.md`.
5. **Reading threads from a UI isn't documented** (9 runs, and a factor in one failure). `ui.md` names `useThreads` and
   `useAllThreads` but not what they return (`Record<machineId, ThreadInfo[] | undefined>`), nor `ThreadInfo` or the
   `status.state` values. Boards got made-up lanes, or rendered nothing.
   *Fix:* document the return shapes, `ThreadInfo`, and `idle | working | done | blocked | error` in `ui.md`, and
   export the `Status` type. Add a small `docs/examples/threads-board` with a `mountUi` test.
6. **A UI half can't be checked without the window** (9 runs). The UI's errors only reach the window's dev-tools
   console. Agents spoke raw JSON-RPC to `profile.ui` and `profile.module`, imported hashed `out/main` chunks, or
   built mock React harnesses that missed real bugs. Both failing runs hit exactly this gap.
   *Fix:* report UI setup and draw failures back to the daemon, and show them in `superego extensions` and
   `superego actions log`. `superego extensions --json` should also list each profile's UI entries and pane kinds.
   Longer term, add `extension test --ui` to render panes headlessly.
7. **The CLI can't wait for or read a thread's answer** (6 runs). Agents testing their tool polled `superego.sqlite`,
   slept blindly, or wrote MCP `thread_read` clients by hand.
   *Fix:* add `superego read <thread> [--wait]` and `create/send --wait`, matching MCP's `thread_read`. Point to them
   from "Testing a tool" in `tools.md`.
8. **A tool can't be run without a model turn** (6 runs). Agents stubbed `'superego'` and ran their module under
   Electron as Node.
   *Fix:* add `superego extension call <tool> --args '{…}'`, or a `callTool` example in "Testing a tool".
9. **Profiles apply to new threads only, and nothing says so** (6 runs). The requesting thread doesn't get the new
   tool, `thread.setProfile` is refused while the thread is working, and one agent told the user their open threads
   would gain the tool.
   *Fix:* say it in `profiles.md` ("existing threads keep their profile; start a new one, or setProfile on an idle
   one").
10. **SKILL.md never names the extension scaffold** (3 of 18 runs used it; the rollup's item 21). *Fix:* add
    `superego extension new <name> [--ui]`, `extension test` and `extension reload` to SKILL.md's quick reference,
    and say to start there.
11. **Subcommand help is missing** (4 runs). `superego extension --help`, `extension test --help` and
    `do <action> --help` print the global usage, and there's no `--version`. *Fix:* give subcommands their own
    usage, make `do <id> --help` print the action's params, and add `--version`.
12. Smaller items, 1–3 runs each (all in `rollup.json`):
    - There's no CLI for live values or methods (`superego value <key> --watch`, `superego call`).
    - It's unclear whether a pane kind is declared in the daemon half, the UI half or `profile.ts` `panes`.
    - `str({ enum })` doesn't exist; show `union([lit…])` in `tools.md`.
    - `tools.md`'s `defineTool` example has a `label` field the type rejects.
    - `LiveValue.update()` returns void.
    - Type stripping rejects enums and parameter properties; the docs should say so, and scaffolds should set
      `erasableSyntaxOnly`.
    - `daemon.transcript()` returns a string, not an object.
    - Agents leave test threads ("say hi", "New thread" in `/tmp`) in the user's sidebar. A way to delete a thread, or
      a "scratch" flag, would help.

## What made the setup unrealistic

- **The docs are reachable here and not for real users.** The skill links `docs/writing-extensions.md` to
  `github.com/mikker/superego`, which is private, so it's a 404 for everyone outside. The harness rewrote those links
  to a local copy of `docs/writing-extensions.md` and `docs/examples`. That doc's own link to
  `../packages/cli/skill/bundled.md` is dead in the copy.
- **The skill was installed for the agent.** The app doesn't put the `superego` skill into `~/.agents/skills`. The
  harness copied SKILL.md there, so every thread was told about it. Without that, a plain thread hears of
  `superego --skill` only through Ego's brief. The plain-thread numbers are optimistic for a real user.
- **No app window ran during the work.** As a result:
  - `~/.superego/types` didn't exist until `superego profile new` made it (the app installs it at start). That
    sent some agents hunting through the install for `.d.ts` files.
  - There was no `layout.json`.
  - The daemon logged to stdout instead of `~/.superego/daemon.log`, which the debugging topic points to.
  - Agents couldn't see their pane; then again, an agent can't see the window in real life either.
- **A sandbox denied the real home.** The daemon and everything it ran couldn't read `/Users/<me>`, so Superego's
  source, `~/.superego`, `~/.agents`, ssh keys and gh's token were out of reach. Three runs got
  "Operation not permitted" while looking around. The installed build's bundled JS was readable, as it is inside a
  real app bundle. 9 runs read it, mostly Sol.
- **Optional extensions were off,** except `coding-tools`, `panes`, `agents-md`, `skills` and `ego`. Turning off
  `thread-reports` was a mistake: Ego never heard when its thread finished (one analysis flagged it). With `ask-user`
  off, nobody could ask a question, though none tried to.
- **Paths:** worlds lived under `/tmp`, which the daemon stores as `/private/tmp`. That tripped one agent's
  `profile.ui` call.
- **Thinking was off** for both models (the machine default), and the network was open. L1's "fails gracefully
  without network" wasn't tested: every weather call reached a real API.
- **The request went to Ego through `ego.ask`** on the command-line path, not typed in the window. Ego didn't know
  which project the user was in, which is also true in the app.
- **Acceptance bugs, fixed during the spike.** L3's first pass found pane kinds by string-literal regex and missed
  `superego.pane(PANE, …)`. I fixed it and rechecked all nine L3 runs, which reran their analysis (that's why analysis
  cost $6.69). Two runs had `pane_opens` counted where the window drew its "No pane of kind" stand-in; those records
  are corrected and the check is fixed. Pass and fail weren't affected.

## What I'd change before running it regularly

1. **Fix the setup gaps:** pre-install `~/.superego/types` as the app does (or run the headless app for the whole
   run), keep `thread-reports` on, and fix the thinking level per model. Run from a packaged `.app`, not a copy of
   `app/out`.
2. **Make the skill an explicit variable:** run "skill installed" and "not installed" as separate arms. The second is
   what users have today, and it's the bigger onboarding question.
3. **Harden acceptance:**
   - Ask the window which pane kinds it registered, instead of regex over the source.
   - Screenshot the whole pane, not the first 1500px.
   - Add a vision check on the screenshot, or a rubric for whether columns follow status.
   - Test L1 with the network blocked (a tool-only proxy, or a probe that runs the module with `fetch` stubbed).
   - Replace the Haiku probe with a deterministic tool call once the CLI can call a tool directly (stumble 8).
4. **Grow the task set:** an L2 (an action plus a scoped value or data view, no UI code) and an L4 (a tool renderer,
   or a daemon hook such as `status`). L1 is already at ceiling, so keep it as a canary.
5. **Get more signal per cell:** 5+ runs for the trend model (Opus, one route) and fewer elsewhere. Report pass rate
   with a range, plus cost and time. At about $1–2 an Opus run, 20 runs a week fit in roughly $40.
6. **Keep a trend file:** commit a small CSV (commit, task, route, pass rate, cost, minutes) and track the top-5
   stumble counts across docs changes. Reset the stumble list when the docs change a lot.
7. **Make analysis cheaper:** analyse only new or changed runs, and use a cheaper model for per-run passes with Opus
   for the rollup. Hand the analysis the acceptance notes (done) and the window console (part of the notes now).

## The harness

`pnpm eval` (`evals/run.ts`, see `evals/README.md`):

- Each run gets a fresh, sandboxed home (`/tmp/sge/runs/…`) and its own daemon, on an installed build at
  `/tmp/sge/install-<commit>`.
- It asks by one route and waits until nothing is working, with a time and cost limit.
- It checks the result against that daemon. L1 uses a Haiku probe thread in the user's project. L3 runs the headless
  app on the run's daemon, opens the pane, reads its text and takes a screenshot, then checks that a new thread shows
  up live.
- It writes one JSONL record per run, then a model pass over the transcript and a ranked rollup.
- A running total enforces the budget across parallel runs, and a batch resumes where it left off.
- `--recheck` reruns acceptance on finished runs, and `--rollup-only` and `--summary-only` redo the reports.
