# Extension-building eval: round 2

Run on 2026-11-16, installed build `e720da7` (main at `9c9f382` plus this harness). This is the new regular plan
(`pnpm eval`): Opus 5.5 through Ego, which is the realistic route, 5 runs on each of four tasks.

**20/20 passed.** Each task went 5/5. At 5 runs a task, that means a pass rate of at least ~57% each (95% Wilson
interval), and at least ~84% across the 20. L1 and L3 are at ceiling, so the next signal will come from cost, time and
the stumbles. Spent **≈ $25.4 of the $60 budget**: details under Spend.

Raw results: `evals/results/round2/` (gitignored). The per-run lines are also in `evals/history.csv`.

## Results

| task | pass | minutes | agent cost (range) | turns | failed calls | tokens out | Ego's share | acceptance |
|---|---|---|---|---|---|---|---|---|
| L1 weather: a tool | 5/5 | 2.5 | $0.43 ($0.33–0.55) | 21 | 0.2 | 9.0k | $0.07 | $0.00 |
| L2 lead agents: a profile | 5/5 | 1.9 | $0.35 ($0.27–0.52) | 20 | 1.2 | 6.9k | $0.09 | $0.17 |
| L3 kanban: a pane | 5/5 | 6.1 | $1.57 ($1.18–2.36) | 55 | 1.8 | 24.0k | $0.07 | $0.00 |
| L4 database badge: daemon + window | 5/5 | 6.8 | $1.64 ($1.34–1.85) | 57 | 1.6 | 23.5k | $0.08 | $0.00 |

All figures are means per run. No run hit a limit or needed the "go ahead" nudge. 14 runs asked a question that the
harness answered: an `ask_ui` form submitted as it came, or "go ahead" to an `ask_user`.

Compared with the re-run's Opus-via-Ego cells, L1 is level ($0.43 vs $0.46). L3 costs more ($1.57 vs $1.20, 55 turns
vs 37). The setup changed between the two: here every default extension is on, thread tools included. With them, L3's
builders started test threads (one sleeping, one asking a question) to check that their board shows each status. That
work is real, and paid for.

## What the new tasks showed

### L2: "Add lead agents that hand work out and review it"

- **All 5 built the same sound thing:** a `lead` user profile with no code. Its long prompt covers planning, briefing
  workers with `thread_start` (some in worktrees of their own), waiting, reviewing the diffs and running the checks,
  sending fixes back with `thread_send`, and archiving the workers. It took about 2 minutes and $0.35, the cheapest
  task. Ego asked a scoping question first in 4 of 5 runs.
- **The leads' judgement is the interesting part.** The first acceptance gave each lead a one-script job. 4 of 5 did it
  themselves, because their prompts say to keep small work, which is a fair call. The fifth handed it out, but to a
  worktree, so the script sat on a branch where the check didn't look.
  - I changed the check after the batch and checked all five again (`--recheck`). The job is now three independent
    scripts with tests and a README section, and the user says they want to "see the team at work". The script is
    looked for in the project and in its worktrees.
  - Under that check all 5 leads started three workers. Four read each one back with `thread_read`, and one acted on
    the workers' reports. All three scripts worked every time.
  - The check also requires the profile to say it leads, so a plain profile told to hand work out doesn't pass.
  - Run 1's world had been used to build the check, which left worktrees and half-done scripts behind. I cleaned its
    project and checked it again; its profile had also passed the same check in a fresh world.
- So L2 measures the wiring (a profile with a prompt, the thread tools and reports, worktrees), not whether a lead
  would delegate a small job unprompted. The rollup also found that `thread_read` with `wait: true` can return a
  worker's old answer right after a `thread_send` (stumble 8 below).

### L4: "Mark threads that touch the database in the sidebar"

- **All 5 built the same architecture**, in the user's default profile:
  - the daemon half notices database work at the end of each run (`turnEnd`, scanning `threads.entries`) or per tool
    call (pi-durable's `afterTool` hook);
  - it keeps the result in the thread's `state` and publishes it as a fact;
  - the UI half draws a `thread.badge` mark with a tooltip saying why, from `thread.ext.<name>`.

  The query thread was marked and the README thread wasn't, every time. All 5 also marked the thread that edited
  `db/schema.sql`. It costs about the same as L3 ($1.64) and took the most turns.
- **Not one badge showed until a thread of that profile had been opened (0/5).** A profile's UI loads only when
  `ThreadView` shows one of its threads (`useProfileUi`). So after a restart, the sidebar has no marks until the user
  clicks into a thread. This is a product gap, not the builders' fault. *Fix:* load the UI of the profiles of listed
  threads when the sidebar lists them. At least do it for this machine's own profiles, which need no allowance.
- **Where they reached outside the help:** to watch tool calls (5 runs), and for the badge slot's props and the
  `thread-badge` class (5 runs). 3 of the 5 L4 runs and one L3 run read the app's bundled JS for these; no L1 or L2 run
  did. *Fix:* in `ui.md`, add a recipe for a per-thread sidebar mark: `state` → `facts` → `thread.ext` → a
  `thread.badge` slot. Export the tool-hook types, or add a `superego.onToolCall` helper, with a "watching tool calls"
  recipe in `tools.md`.
- **A dev run, outside the batch, hit the 20-minute limit.** Its own matcher looped forever inside `superego extension
  test` (a synchronous loop, 97% CPU for 10+ minutes). The runner's per-test timeouts can't fire through a synchronous
  loop, and it hadn't printed which test was running. *Fix:* print each test's name as it starts, and run test files in
  a worker the runner can kill after a wall-clock limit.

### L1 and L3

- **L1 now tests the offline case, and it's 5/5.** The tool runs in `superego/testing`'s daemon with a scripted model,
  under a sandbox that refuses every connection. Every run's tool answered within about 55ms with a clear message, such
  as `Could not look up "Copenhagen": fetch failed`. Two answered as an error result and three as a normal result
  saying why it failed. None made up weather, crashed or hung.
- **L3: the window now says which pane kinds exist.** Each of the 5 runs registered one kind in its default profile,
  which opened and drew the seeded threads by status, and updated live.

## Top remaining stumbling points, ranked

From `rollup.json` (29 items), merged with the re-run's and checked against the transcripts. "Runs" means runs here,
out of 20.

1. **Ego's handoff is out of date and asks too much** (7 runs asked a scoping question on a clear request, and 14
   needed some answer; in the re-run, 5 of 6 Opus briefs said `profile new default`, and 2 said to test with
   bun/node). *Fix, in Ego's prompt (`extensions/ego/src/tools.ts`):*
   - name `superego extension new <name> --user [--ui]` and `extension test`, and say that no Node is needed;
   - on a clear request, pick the sensible default (the user's default profile), say so, and start the thread.
2. **Agents still look for `node`, `npx` or `tsc`** (8 runs). *Fix:* say in SKILL.md, near the top, that
   `superego extension test` is the type checker and the runtime, and that plain Node can't import `superego`.
3. **Subcommand `--help` prints the global usage and exits 1** (8 runs; 5 in the re-run). *Fix:* give `profile …` and
   `extension …` subcommands their own usage, with `-P`, `--user` and examples, and exit 0.
4. **Which profile do `extension test` and `extension reload` act on?** (6 runs). Without `-P` they fail with "No
   profile default…", even from inside a profile's folder, and `[name]` reads as a test name. *Fix:* default to the
   profile whose folder holds the working directory, and on failure list the profiles and suggest `-P <name> --user`.
5. **`tools.md` is wrong in two places, and the schema builders aren't listed** (5 + 4 runs; 6 + 7 in the re-run).
   The `label` field is rejected and `str({ enum })` doesn't exist. Together they were the most common first type
   error. *Fix:* correct the example, add a table of builders with `union([lit…])` for fixed choices, and type-check
   the skill's code samples in CI.
6. **L4's two undocumented pieces: watching tool calls, and the `thread.badge` slot** (5 runs each). *Fix:* as under
   L4 above.
7. **`superego/testing`'s window can't render a pane kind or a slot** (4 + 4 runs), and `fakeMachine`'s behaviour is
   learned from failing tests (4 runs). *Fix:* add `render({ pane })` and `render({ slot: 'thread.badge', thread })`,
   and document what `fakeMachine` answers.
8. **Threads' wait and report semantics** (3 runs). `thread_read wait: true` right after `thread_send` returns the old
   answer. Ego's threads aren't its children, so Ego never hears they finished, even with `thread-reports` on: 0 of 20
   Ego threads got a report. *Fix:* make `wait: true` wait for the next finished run after a send, and say in Ego's
   prompt that its handoff is fire-and-forget (or let Ego hear back).
9. **The long topics get truncated** (5 runs; 7 in the re-run). *Fix:* a recipe index at the top of SKILL.md, and
   `superego --skill guide <section>`.
10. **Test threads left in the user's sidebar.** 13 of 20 runs started threads to try their work ("Reply with just:
    hi", "Run exactly this shell command…"), which are the user's threads now. *Fix:* a scratch
    flag for a thread an agent starts to test with, kept out of the sidebar, or a `superego` way to delete a thread.

## Harness changes in this round

- **Setup as a user has it.** The SDK's types are in `~/.superego/types` before the run starts, as the app installs
  them. Every default extension is on, `thread-reports` included, except `suggestions`: its side calls show up in no
  thread's cost, so no budget would catch them. `--plan spike` keeps the first batch's setup, for comparisons.
- **No skill arms.** The app offers its own skill to every thread, so "installed vs not" no longer differs.
- **The window says what's registered.** It exposes `window.superegoRegistered()` (panes, slots and views by owner).
  The L3 check opens the pane kinds it reports for the thread's profile, in place of a regex over the source. L4 reads
  its slots, and the screenshot is now of the pane, not the window.
- **Questions get answered.** With `ask-user` and `reply-ui` on, Ego asks first. The harness answers `ask_user` with
  "go ahead" and submits `ask_ui` forms with their defaults, up to 3 times a run.
- **New tasks:** L2 (`tasks/lead.ts`) and L4 (`tasks/db-badge.ts`), each with what it judges written at its top.
  - L4 sets up the user's project with a SQLite database before the request (`Task.setup`).
  - Both checks were tried on real runs before the batch: L4 on a dev run, L2 on a hand-written lead and then on this
    batch's profiles (see L2 above).
- **History.** `evals/history.csv` gets a line per recorded run (date, commit, model, route, task, pass, agent cost,
  turns, minutes, batch, plan, run), and `--recheck` updates its lines. The re-run's 18 runs are in it too
  (`--history`).
- **Cheaper analysis.** Per-run analysis is on Sonnet 5.5 for the regular plan (about $0.06 a run, against $0.10 on Opus in
  the re-run); the rollup stays on Opus.
- **The budget holds** as before: a running total of agents, probes and analysis, with $3 kept back, and no run
  started that might not fit. Acceptance probes and rechecks count toward it.

## Spend

| | |
|---|---|
| Batch: agents, 20 runs | $19.98 |
| Batch: acceptance probes, including the L2 recheck | $0.87 |
| Batch: per-run analysis (Sonnet), rechecks included | $1.61 |
| Rollups (Opus, two) | ≈ $0.65 |
| Dev batch `r2-dev` (L2 and L4, one run each) | $1.77 |
| Trying the checks by hand on finished worlds | ≈ $0.50 |
| **Total** | **≈ $25.4 of $60** |
