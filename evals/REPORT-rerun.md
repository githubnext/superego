# Extension-building eval: the spike, re-run

Run on 2026-11-15 on main at `9c9f382`, with the spike's plan and setup (`pnpm eval --plan spike`, from before round 2
changed the harness): L1 weather and L3 kanban; Opus 5.5 by Ego and by a plain thread, and Sol 6.1 by Ego; 3 runs each,
so 18 runs. The setup is the spike's too: only `coding-tools`, `panes`, `agents-md`, `skills` and `ego` on (so
`thread-reports` was off again, for comparability), and no SDK types until a command makes them. The skill wasn't copied
in this time, because the app now offers it to every thread itself.

**18/18 passed, against the spike's 16/18.** Spent **$11.36 of the $30 budget**: $11.06 in the batch (agents $8.87,
acceptance probes $0.06, analysis and rollup $2.13), plus about $0.30 on a first start I stopped so harness work
couldn't change files under it. Wall time was about 40 minutes with three runs at a time.

Raw results: `evals/results/rerun/` (gitignored). `summary.md` has the per-run table, and `rollup.json` the 28 ranked
stumbles.

## Side by side

| model | route | task | pass: spike → now | minutes | agent cost | turns | failed calls | tokens out | out per turn |
|---|---|---|---|---|---|---|---|---|---|
| Opus | thread | L1 weather | 3/3 → 3/3 | 2.0 → 1.9 | $0.27 → $0.25 | 19 → 17 | 1.7 → 1.3 | 6k → 6.4k | 316 → 376 |
| Opus | ego | L1 weather | 3/3 → 3/3 | 5.6 → 2.6 | $0.75 → $0.46 | 39 → 22 | 3.3 → 0 | 17k → 9.6k | 436 → 442 |
| Opus | thread | L3 kanban | 2/3 → **3/3** | 10.4 → 2.8 | $1.89 → **$0.62** | 51 → 21 | 1.7 → 1.0 | 26k → 9.2k | 510 → 440 |
| Opus | ego | L3 kanban | 2/3 → **3/3** | 10.9 → 5.7 | $1.89 → $1.20 | 56 → 37 | 2.7 → 1.7 | 25k → 20k | 446 → 546 |
| Sol | ego | L1 weather | 3/3 → 3/3 | 4.2 → 2.6 | $0.32 → $0.17 | 34 → 14 | 4.3 → 2.0 | 11k → 5.6k | 324 → 393 |
| Sol | ego | L3 kanban | 3/3 → 3/3 | 4.7 → 3.1 | $0.41 → $0.25 | 39 → 19 | 4.0 → 2.3 | 11k → 6.2k | 282 → 332 |
| **all** | | | **16/18 → 18/18** | | **$16.59 → $8.87** | | | | |

All figures are means per run. Turns are model requests. No run hit a limit or needed the "go ahead" nudge.

- **Agent cost fell by 47% overall, and by up to two-thirds on L3,** because runs took half the turns or fewer. Time
  roughly halved. L3 by a plain thread now costs what L1 by Ego did in the spike.
- **Nothing reached outside the help.** No run read the app's bundled JS (the spike had 9 such runs, mostly Sol). None
  fetched from the web (3 Sol runs in the spike), and none hit the sandbox.
- **The Ego route still costs more than a plain thread.** On L1 it's $0.46 vs $0.25; on L3 it's $1.20 vs $0.62, and the
  gap on L3 is new (the routes were level in the spike). The cause is Ego's brief (stumble A below). Ego's own share is
  small: $0.03 to $0.09 a run.
- **Sol is still about 2–5× cheaper than Opus,** and now it stays inside the help.

## Did thinking at medium change costs?

Not upward: it was swamped by the drop in turns. Thinking tokens count as output, and output *per turn* rose about
0–20% in five of six cells (Opus L3 by a plain thread fell). That fits a modest per-turn thinking overhead. Total output
still fell in every cell but one (Opus L1 by a plain thread: 6k → 6.4k), because the runs were much shorter.

This doesn't separate the two effects. The spike ran with thinking off, and this run has both thinking at medium and the
fixes. Some of the drop in turns may be thinking itself, from fewer wrong guesses. Separating them takes a run with
thinking set to `off` for Sol (Opus 5.5 can't turn it off), or with the fixes reverted. I don't think it's worth the
money: the round-2 plan pins thinking at the default, as users get it.

## The spike's stumbles, now

| # | spike stumble (runs it hit, of 18) | now (of 18) |
|---|---|---|
| 1 | `store` keys must carry the extension's prefix; fatal in both L3 failures (2) | **gone.** No prefix error anywhere; L3 is 9/9 |
| 2 | `superego extension test` doesn't work in an installed app (16) | **gone.** Every run ran it (4–12 times each), with no runner errors. The failures it showed were the agents' own type errors and tests, which they then fixed |
| 3 | no type-checking path; agents hunt for `tsc`, `npx`, `node` (15) | **mostly gone (2).** Both runs were Opus via Ego, whose brief said to "test with bun/node" (see A) |
| 4 | the SDK's type files are thin re-export shells (11) | **mostly gone.** 13 runs read the flattened `index`/`ui`/`testing.d.ts` directly. 3 still grepped `pi-schema`/`pi-durable`, mostly for the schema builders (see C) |
| 5 | reading threads from a UI isn't documented (9) | **gone.** No board got made-up lanes; every pane drew the seeded threads, and all 9 sorted them by status |
| 6 | a UI half can't be checked without the window (9) | **changed shape.** Nobody spoke raw RPC or imported `out/main`. Agents now test with `mountUi`, and trip on its rough edges instead (see E) |
| 7 | the CLI can't wait for or read a thread's answer (6) | **still there (3).** Agents polled `threads --json` and read a cut-off status message |
| 8 | a tool can't be run without a model turn (6) | **mostly answered** by `testDaemon` + `callTool`, which most L1 runs used. The analysis still found 6 runs that wanted a live check and looked for Node first (folded into stumble 3's fix) |
| 9 | profiles reach new threads only, and nothing said so (6) | **mostly gone (1).** One agent couldn't show the new board in its own thread, and shipped without seeing it |
| 10 | SKILL.md never names `extension new` (3 of 18 used it) | **better, but not by Ego: 11 of 18 used it.** Plain threads used it 4/6 and Sol 6/6, but Opus via Ego only 1/6, because Ego's brief says `profile new default` (see A) |
| 11 | subcommand `--help` prints the global usage; no `--version` (4) | **still there (5 + 1)** |
| 12 | smaller: `str({ enum })` doesn't exist; `tools.md`'s `label` field; type stripping; `daemon.log`… | **still there.** `enum` cost 2 runs a type error and `label` 2 more (the rollup's 7 and 6 runs include reading around them); `daemon.log` missing (1) |

## New stumbling points

Ranked by runs, from `rollup.json`, checked against the transcripts.

- **A. Ego briefs builders the old way** (5 of 6 Opus Ego runs). Ego's prompt (`extensions/ego/src/tools.ts`) names
  `profile new [name]` and never `extension new`, so its briefs say `superego profile new default`. Two also said to
  "test with bun/node". The built thread then writes tools by hand, looks for `npx`, `tsc` and `bun`, and takes 37
  turns where a plain thread took 21 for L3. *Fix:* in Ego's prompt, name `superego extension new <name> --user [--ui]`
  and `superego extension test`, and say that no Node is needed.
- **B. `extension new` scaffolds a data-only sample whatever you're making** (8 runs). An agent that wants only a tool,
  or only a pane, deletes most of it. The leftover sample test then imports `ITEMS`/`Item` from a rewritten
  `shared.ts`, and the next `extension test` stops at type errors with no tests run (2 runs). *Fix:* a `--tool`
  template (one `defineTool` file plus a `callTool` test). Keep the sample test self-contained, with a note to delete
  it along with the sample.
- **C. The schema builders aren't documented, and `tools.md` is wrong about two things** (7 runs reading around them).
  It says `str` takes `enum` (it doesn't), and its `defineTool` example has a `label` field that `ToolRegistration`
  rejects. 11 of 18 runs' first `extension test` stopped at type errors, and these two were the most common. *Fix:* in
  `tools.md`, remove `label`, show fixed choices as `union([lit('metric'), lit('imperial')])`, and add a table of
  builders and their options. Type-check the skill's code samples in CI against the shipped `.d.ts`.
- **D. The guide is too long to read in one go** (7 runs). `superego --skill guide` overflows a tool result and gets
  truncated, so agents save it to a file and page through it. *Fix:* a contents list at its top, and
  `superego --skill guide <section>`.
- **E. `superego/testing`'s window has rough edges** (4 runs each, overlapping):
  - It floods the output with React `act(...)` warnings from the window's own components.
  - `Rendered.click(text)` doesn't find clickable cards, and its matching isn't documented.
  - Dispatches show up as `action.run`, and selection makes no call at all.
  - `render({ view, place: 'pane' })` draws an empty div for a pane kind (3).
  - Views registered in test files count as the profile's pane kinds (3).

  *Fix:* wrap `mountUi`'s helpers in `act()`, and add `render({ pane: kind })` and `window.dispatched(id)`. Document
  what `click` matches.
- **F. A tool's `execute` context is undocumented** (4 runs). Agents found `context.abortSignal` in pi-durable, then
  treated it as always set. *Fix:* export the `Context` type with a doc comment, and show the optional signal in
  `tools.md`.
- Smaller, 1–2 runs each:
  - `details` must be JSON, and `JsonValue` isn't exported.
  - The scaffold's `noUncheckedIndexedAccess` trips tests.
  - `extension test` rejects a single-file extension.
  - `fakeMachine`'s `thread.list` ignores `archived`.
  - There's no list of key bindings in use.
  - The first `extension new` looked hung while linking types, and the agent's own timeout killed it.

## What changed in the setup since the spike

- The skill is the app's own (offered by the skills extension), not a copy in `~/.agents/skills`, so this is what real
  users get.
- The app's types weren't installed up front. Two runs found `~/.superego/types` missing on first look, which is
  harness setup and not a product bug: the app installs them when it starts. Round 2 installs them.
- `thread-reports` was off, as in the spike, and Ego never heard its thread finish. Round 2 turns it on.

## Spend

| | |
|---|---|
| Agents (18 runs) | $8.87 |
| Acceptance probes (Haiku) | $0.06 |
| Per-run analysis (Opus) and rollup | $2.13 |
| Aborted first start | ≈ $0.30 |
| **Total** | **≈ $11.36 of $30** |
