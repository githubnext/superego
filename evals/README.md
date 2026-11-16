# Evals

How well agents extend Superego with only the help it ships: the `superego` skill, the docs and the SDK.

```sh
pnpm eval                          # the trend line: Opus through Ego, every task, 5 runs each; $60 budget
pnpm eval --batch b2 --tasks l1-weather --runs 1 --budget 5
pnpm eval --batch dry --tasks l1-weather --models haiku --runs 1 --analysis claude-haiku-5-5 --run-cap 1 --budget 4   # does the harness work? (about $1)
pnpm eval --batch b2 --recheck <run,run>   # check finished runs again, after fixing a task's acceptance
pnpm eval --batch b2 --rollup-only         # redo the rolled-up "where it got lost" list and summary
```

## Tasks

| task | level | the user asks | passes when |
|---|---|---|---|
| `l1-weather` | 1: a tool | "Give my agents a tool that fetches the current weather for a city." | a new thread in the project has the tool and gets the weather with it, and the same call with no network answers with a message (not a crash, a hang or made-up weather) |
| `l2-lead` | 2: a profile | "Add lead agents that hand work out and review it." | a thread with the profile it made, given a small job on Sonnet, starts a child thread for it, looks at what came back (`thread_read`, or acts on the child's report), and the job is done |
| `l3-kanban` | 3: a pane | "Add a kanban board of my threads." | a pane kind the window says the profile registered opens beside a project thread and draws the project's threads |
| `l4-db-badge` | 4: daemon and window | "Mark threads that touch the database in the sidebar." | in a project with a SQLite database, the sidebar marks a thread that queried it and not one that only counted README lines |

Each acceptance check is in `tasks/*.ts`, with what it does and doesn't judge at its top. Checks that aren't needed to
pass (L3's live updates, L4's mark on a schema edit or before a thread was opened) are recorded too.

## A run

Each run gets a fresh home in `/tmp/sge/runs/<batch>-<run>` with its own daemon on an installed build (`app/out`,
copied with Electron to `/tmp/sge/install-<commit>`), sandboxed out of the real home. The SDK's types are installed in
`~/.superego/types` as the app installs them when it starts, and the app's optional extensions are on as a user has
them, except `suggestions` (its side calls count toward no thread's cost).

The request goes to Ego (`ego.ask`) or to a plain thread in `~/code/myproject`. The harness waits until nothing is
working (20 minutes and $6 at most), answers a question the agent asks (`ask_user`: "go ahead"; `ask_ui`: the form as
it came), says "go ahead" once if the agent stopped before writing anything, then checks the result against the daemon
and has a model read the transcript for where the agent got lost (`lib/analyze.ts`). Window checks run the installed
app headless on the run's daemon (`lib/window.mjs`) and ask it what extensions registered (`window.superegoRegistered`).

## Results and budget

Results go to `evals/results/<batch>/` (gitignored): `runs.jsonl` (a record per run), `summary.md`, `rollup.json`,
and per run its log, transcript, the profile it wrote, acceptance screenshots and the analysis. Every recorded run also
adds a line to `evals/history.csv` (committed: date, commit, model, route, task, pass, agent cost, turns, minutes,
batch, plan, run), the trend across batches. (`plan` is `spike` for the first batches' setup and `regular` since.)

A batch keeps a running total of what it spent (agents, acceptance probes, analysis) and stops starting runs once one
more might not fit in what's left of `--budget`, keeping $3 back for the analysis. Running it again skips the runs it
has, and spends no more than what's left.

Needs `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` for Sol) in the environment, macOS (`sandbox-exec`), `sqlite3`, and the
app buildable here.
