# Evals

How well agents extend Superego with only the help it ships: the `superego` skill, the docs and the SDK.

```sh
pnpm eval                          # the spike plan: Opus by Ego and by a plain thread, then Sol by Ego; $60 budget
pnpm eval --batch b2 --models opus --routes thread --tasks l1-weather --runs 1 --budget 5
pnpm eval --batch spike --recheck <run,run>   # check finished runs again, after fixing a task's acceptance
pnpm eval --batch spike --rollup-only   # redo the rolled-up "where it got lost" list and summary
```

Each run: a fresh home in `/tmp/sge/runs/<batch>-<run>` with its own daemon on an installed build (`app/out`, copied
with Electron to `/tmp/sge/install-<commit>`), sandboxed out of the real home; only the required extensions and those
the routes need (`coding-tools`, `panes`, `agents-md`, `skills`, `ego`). The request goes to Ego (`ego.ask`) or to a
plain thread in `~/code/myproject`; the harness waits until nothing is working (20 minutes, $6 at most), says "go
ahead" once if the agent stopped before writing anything, then checks the result against the daemon (`tasks/*.ts`)
and has a model read the transcript for where the agent got lost (`lib/analyze.ts`).

Results go to `evals/results/<batch>/` (gitignored): `runs.jsonl` (a record per run), `summary.md`, `rollup.json`,
and per run its log, transcript, the profile it wrote, acceptance screenshots and the analysis. Running a batch again
skips the runs it has, and spends no more than what's left of its budget.

Needs `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` for Sol) in the environment, macOS (`sandbox-exec`), and the app
buildable here.

The first batch and what it found: [REPORT-spike.md](REPORT-spike.md).
