# Working on Superego

Many agents work on this repo at once, each in a git worktree of its own, all on one machine.

## Early days

The app is in its infancy and under heavy development. This means, we barely have users but ourselves. It is therefore important and timely that we always opt for the proper fixes and implementations. Rather going one step back and getting it right at the cost of compatibility than patching on patches.

## Errors

Surface every failure: to the console and somewhere in the UI the user can see (a notice, the row it belongs to, the
pane). No silent `catch(() => {})`: swallowing an error needs a comment saying why that failure is expected and harmless.

## House rules

- Work in your own worktree. Never reset, stash or overwrite anything in the main checkout.
- Merge to `main` by rebasing onto the local `main`, then `git -C <main checkout> merge --ff-only <your branch>` (the main
  checkout is the first in `git worktree list`). If that fails, rebase again and retry.
- Don't push.
- Don't use `git stash`: it's shared by every worktree of the repo, so a pop can take another agent's changes. Use a
  WIP commit instead.

## Checks

- **While working:** `pnpm typecheck` (incremental: quick after the first run) and only the tests related to what you
  changed: `pnpm vitest related --run <files>`, or a package's own (`pnpm test packages/cli`).
- **Before merging:** `pnpm typecheck` and the tests related to what you changed (`pnpm vitest related --run <files>`,
  or the packages you touched). Add `pnpm smoke` when you changed `app/`, `packages/app` or the protocol
  (`packages/protocol`). The full `pnpm test` runs on main once per batch of merges (the chief of staff's check), not
  before every merge; run it yourself only for a change that reaches across many packages (a rename, an API change).
  Run checks with `ELECTRON_RUN_AS_NODE` and `ELECTRON_RENDERER_URL` unset
  (`env -u ELECTRON_RUN_AS_NODE -u ELECTRON_RENDERER_URL pnpm smoke`): agents started from the dev app inherit them,
  and they make Electron run as plain Node or load the dev server's page instead of the build.
- **After a rebase:** `pnpm install` if `pnpm-lock.yaml` changed; then `pnpm typecheck` and the related tests again.
  Run smoke again only if the rebase brought in changes under `app/` or `packages/app`, or to the protocol
  (`packages/protocol`).
- **Checking main itself:** never in the main checkout. Every merge fast-forwards it and rewrites files under a
  running check. Use a detached worktree of its own: `git worktree add --detach <dir> main`, then `pnpm install`.

`pnpm test`, `pnpm typecheck`, smoke, showcase and `app/test/look.sh` share a few slots across the whole machine
(`scripts/check.ts`; `SUPEREGO_CHECK_SLOTS`, default 2), so "waiting for a check slot…" and a short wait are normal.
Each is stopped if it runs too long: smoke, showcase and look after 8 minutes (`SUPEREGO_SMOKE_TIMEOUT`,
`SUPEREGO_SHOWCASE_TIMEOUT`, in seconds), the rest after 20 (`SUPEREGO_CHECK_TIMEOUT`). Smoke, showcase and look build
the app first only when its sources changed. A new package or extension also goes in the root `tsconfig.json`'s
references, or `pnpm typecheck` skips it.

Give any other long-running command a timeout of its own. Never use ImageMagick's `compare -subimage-search` on
screenshots: it can run for hours.
